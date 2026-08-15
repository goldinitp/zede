//! The app shell: Spaces rail, tab sidebar, terminal pane, settings window.
//! Owns the db, settings, theme, and the map of live PTY sessions (sessions
//! survive Space switches; a tab's PTY dies only when the tab closes).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use alacritty_terminal::vte::ansi::{CursorShape as AnsiCursorShape, CursorStyle as AnsiCursorStyle};
use egui::{Align2, Color32, CornerRadius, Frame, Key, Modifiers, RichText, Vec2};

use crate::capture::{self, PromptFeed};
use crate::db::{Db, MemoryRow, SpaceRow, TabRow};
use crate::extract;
use crate::inject;
use crate::pty::{self, TabKind};
use crate::settings::{self, CursorStyleKind, Settings};
use crate::sync;
use crate::term::{OscColors, TermSession};
use crate::theme::{self, AppTheme};
use crate::ui::memory::{self, MemoryAction};
use crate::ui::sidebar::{self, Action, SidebarState, TabLive};
use crate::ui::{settings_panel, terminal};

pub struct ZedeApp {
    db: Db,
    settings: Settings,
    theme: &'static AppTheme,
    osc: Arc<RwLock<OscColors>>,
    spaces: Vec<SpaceRow>,
    tabs: Vec<TabRow>,
    active_space: String,
    active_tab: HashMap<String, String>,
    sessions: HashMap<String, TermSession>,
    prompt_feeds: HashMap<String, PromptFeed>,
    spawn_errors: HashMap<String, String>,
    /// Tabs whose next spawn must be fresh (post-crash restart).
    no_resume_once: HashSet<String>,
    sidebar_state: SidebarState,
    sidebar_visible: bool,
    show_settings: bool,
    show_memory: bool,
    memory_rows: Vec<MemoryRow>,
    memory_filter: String,
    memory_last_filter: String,
    electron_db_available: bool,
    import_report: Option<String>,
    /// How many of each feed's prompts have been through the learn pipeline.
    extracted_upto: HashMap<String, usize>,
    /// Per-tab throttle for transcript discovery scans.
    discovery_at: HashMap<String, Instant>,
    last_learned: Option<(Instant, usize)>,
    learn_tx: std::sync::mpsc::Sender<extract::LearnRequest>,
    learn_rx: std::sync::mpsc::Receiver<extract::LearnResult>,
    sync_tx: std::sync::mpsc::Sender<SyncCmd>,
    sync_rx: std::sync::mpsc::Receiver<sync::SyncResult>,
    sync_busy: bool,
    sync_url_input: String,
    sync_mode_input: String,
    focus_terminal: bool,
}

pub enum SyncCmd {
    Setup { url: String, mode: String },
    Now,
}

/// Sync runs on its own thread with its own db connection (WAL + busy
/// timeout); the UI refreshes from the db when the result lands.
fn start_sync_worker(
    ctx: egui::Context,
) -> (std::sync::mpsc::Sender<SyncCmd>, std::sync::mpsc::Receiver<sync::SyncResult>) {
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<SyncCmd>();
    let (res_tx, res_rx) = std::sync::mpsc::channel::<sync::SyncResult>();
    std::thread::Builder::new()
        .name("zede-sync".into())
        .spawn(move || {
            while let Ok(cmd) = cmd_rx.recv() {
                let path = db_path();
                let data_root = path
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| PathBuf::from("."));
                let result = match Db::open(&path) {
                    Ok(db) => match cmd {
                        SyncCmd::Setup { url, mode } => sync::setup(&db, &data_root, &url, &mode),
                        SyncCmd::Now => sync::sync_now(&db, &data_root),
                    },
                    Err(e) => sync::SyncResult {
                        ok: false,
                        error: Some(e),
                        ..Default::default()
                    },
                };
                if res_tx.send(result).is_err() {
                    break;
                }
                ctx.request_repaint();
            }
        })
        .ok();
    (cmd_tx, res_rx)
}

pub fn electron_db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("Zede")
        .join("zede.db")
}

/// Open (and migrate) the native database at its resolved location.
pub fn open_db() -> Result<Db, String> {
    Db::open(&db_path())
}

fn db_path() -> PathBuf {
    if let Ok(dir) = std::env::var("ZEDE_DATA_DIR") {
        return PathBuf::from(dir).join("zede.db");
    }
    // "ZedeNative", not "Zede": that directory belongs to the Electron app
    // (Chromium storage + its own schema-v6 zede.db). P6 imports from it and
    // unifies the location once the importer exists.
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("ZedeNative")
        .join("zede.db")
}

pub fn osc_from_theme(t: &AppTheme) -> OscColors {
    let mut ansi = [alacritty_terminal::vte::ansi::Rgb { r: 0, g: 0, b: 0 }; 16];
    for (i, c) in t.term.ansi.iter().enumerate() {
        ansi[i] = theme::to_ansi_rgb(*c);
    }
    OscColors {
        ansi,
        foreground: theme::to_ansi_rgb(t.term.foreground),
        background: theme::to_ansi_rgb(t.term.background),
        cursor: theme::to_ansi_rgb(t.term.cursor),
    }
}

fn apply_visuals(ctx: &egui::Context, t: &AppTheme) {
    let mut v = egui::Visuals::dark();
    v.panel_fill = t.chrome.chrome;
    v.window_fill = t.chrome.chrome;
    v.window_stroke = egui::Stroke::new(1.0_f32, t.chrome.titlebar_1);
    v.override_text_color = Some(t.chrome.text_2);
    v.selection.bg_fill =
        Color32::from_rgba_unmultiplied(t.chrome.accent.r(), t.chrome.accent.g(), t.chrome.accent.b(), 70);
    ctx.set_visuals(v);
}

/// Load an installed Nerd Font so powerline prompts render; egui's bundled
/// Hack covers everything else.
fn find_nerd_font() -> Option<Vec<u8>> {
    let mut dirs_to_scan: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs_to_scan.push(home.join("Library/Fonts"));
        dirs_to_scan.push(home.join(".local/share/fonts"));
    }
    dirs_to_scan.push(PathBuf::from("/Library/Fonts"));
    dirs_to_scan.push(PathBuf::from("/usr/share/fonts"));

    let mut best: Option<(u8, PathBuf)> = None;
    for dir in dirs_to_scan {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let is_font = name.ends_with(".ttf") || name.ends_with(".otf");
            let is_nerd = name.contains("nerd") || name.contains(" nf ") || name.contains(" nf.");
            if !is_font || !is_nerd || !name.contains("regular") {
                continue;
            }
            let rank = if name.contains("meslo") {
                0
            } else if name.contains("jetbrains") {
                1
            } else if name.contains("fira") {
                2
            } else if name.contains("hack") {
                3
            } else {
                9
            };
            if best.as_ref().map_or(true, |(r, _)| rank < *r) {
                best = Some((rank, entry.path()));
            }
        }
    }
    best.and_then(|(_, path)| std::fs::read(path).ok())
}

fn install_fonts(ctx: &egui::Context) {
    let mut defs = egui::FontDefinitions::default();
    if let Some(bytes) = find_nerd_font() {
        defs.font_data
            .insert("nerd".to_string(), Arc::new(egui::FontData::from_owned(bytes)));
        if let Some(family) = defs.families.get_mut(&egui::FontFamily::Monospace) {
            family.insert(0, "nerd".to_string());
        }
    }
    ctx.set_fonts(defs);
}

impl ZedeApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Result<ZedeApp, String> {
        install_fonts(&cc.egui_ctx);

        let db = Db::open(&db_path())?;
        db.ensure_seed();
        let settings = Settings::load(&db);
        let th = theme::theme_by_id(&settings.theme);
        apply_visuals(&cc.egui_ctx, th);

        let spaces = db.list_spaces();
        let active_space = db
            .meta_get("active_space")
            .filter(|id| spaces.iter().any(|s| &s.id == id))
            .or_else(|| spaces.iter().find(|s| s.is_default).map(|s| s.id.clone()))
            .or_else(|| spaces.first().map(|s| s.id.clone()))
            .ok_or("no spaces after seed")?;

        let (learn_tx, learn_rx) = extract::start_worker(Some(cc.egui_ctx.clone()));
        let (sync_tx, sync_rx) = start_sync_worker(cc.egui_ctx.clone());
        let mut app = ZedeApp {
            db,
            settings,
            theme: th,
            osc: Arc::new(RwLock::new(osc_from_theme(th))),
            spaces,
            tabs: Vec::new(),
            active_space,
            active_tab: HashMap::new(),
            sessions: HashMap::new(),
            prompt_feeds: HashMap::new(),
            spawn_errors: HashMap::new(),
            no_resume_once: HashSet::new(),
            sidebar_state: SidebarState::default(),
            sidebar_visible: true,
            show_settings: false,
            show_memory: false,
            memory_rows: Vec::new(),
            memory_filter: String::new(),
            memory_last_filter: String::new(),
            electron_db_available: electron_db_path().exists(),
            import_report: None,
            extracted_upto: HashMap::new(),
            discovery_at: HashMap::new(),
            last_learned: None,
            learn_tx,
            learn_rx,
            sync_tx,
            sync_rx,
            sync_busy: false,
            sync_url_input: String::new(),
            sync_mode_input: "git".to_string(),
            focus_terminal: true,
        };
        if let Some(url) = app.db.meta_get(sync::META_REMOTE_URL) {
            app.sync_url_input = url;
        }
        app.sync_mode_input = app
            .db
            .meta_get(sync::META_AUTH_MODE)
            .unwrap_or_else(|| "git".to_string());
        app.load_tabs();
        Ok(app)
    }

    fn load_tabs(&mut self) {
        let mut tabs = self.db.list_tabs(&self.active_space);
        tabs.sort_by_key(|t| (!t.pinned, t.sort_order));
        self.tabs = tabs;
        let stored = self.active_tab.get(&self.active_space).cloned().or_else(|| {
            self.db.meta_get(&format!("active_tab:{}", self.active_space))
        });
        let valid = stored.filter(|id| self.tabs.iter().any(|t| &t.id == id));
        let chosen = valid.or_else(|| self.tabs.first().map(|t| t.id.clone()));
        if let Some(id) = chosen {
            self.active_tab.insert(self.active_space.clone(), id);
        } else {
            self.active_tab.remove(&self.active_space);
        }
    }

    fn reload_memories(&mut self) {
        let query = self.memory_filter.trim().to_string();
        self.memory_rows = if query.len() >= 2 {
            self.db
                .search_rows(&self.active_space, &inject::build_match_query(&query), &query)
        } else {
            self.db.list_memories(&self.active_space)
        };
        self.memory_last_filter = self.memory_filter.clone();
    }

    fn handle_memory_action(&mut self, action: MemoryAction) {
        match action {
            MemoryAction::SetPinned(id, pinned) => {
                self.db.set_memory_pinned(&id, pinned);
                self.reload_memories();
            }
            MemoryAction::Forget(id) => {
                self.db.forget_memory(&id, "forgotten from memory panel");
                self.reload_memories();
            }
            MemoryAction::Import => {
                match self.db.import_from_electron(&electron_db_path()) {
                    Ok(r) => {
                        self.import_report = Some(format!(
                            "Imported {} memories, {} spaces, {} tombstones ({} skipped)",
                            r.memories, r.spaces, r.tombstones, r.skipped
                        ));
                        self.spaces = self.db.list_spaces();
                        self.reload_memories();
                    }
                    Err(e) => self.import_report = Some(format!("Import failed: {e}")),
                }
            }
            MemoryAction::ClearReport => self.import_report = None,
        }
    }

    fn current_tab(&self) -> Option<TabRow> {
        let id = self.active_tab.get(&self.active_space)?;
        self.tabs.iter().find(|t| &t.id == id).cloned()
    }

    fn set_active_tab(&mut self, id: String) {
        self.db
            .meta_set(&format!("active_tab:{}", self.active_space), &id);
        self.active_tab.insert(self.active_space.clone(), id);
        self.focus_terminal = true;
    }

    fn cursor_style(&self) -> AnsiCursorStyle {
        AnsiCursorStyle {
            shape: match self.settings.cursor_style {
                CursorStyleKind::Block => AnsiCursorShape::Block,
                CursorStyleKind::Underline => AnsiCursorShape::Underline,
                CursorStyleKind::Bar => AnsiCursorShape::Beam,
            },
            blinking: self.settings.cursor_blink,
        }
    }

    fn spawn_session_for(&mut self, tab: &TabRow, ctx: &egui::Context) {
        if self.sessions.contains_key(&tab.id) || self.spawn_errors.contains_key(&tab.id) {
            return;
        }
        // Inject this Space's ranked memory before the session starts, so the
        // spawning claude reads current context (file adapter: CLAUDE.md
        // imports .zede/context.md).
        if tab.kind == TabKind::Claude {
            let space_name = self
                .spaces
                .iter()
                .find(|s| s.id == tab.space_id)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| "Default".to_string());
            let rows = self.db.list_memories(&tab.space_id);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // Lexical relevance seed: where the session runs + what it's about.
            let titles: Vec<String> = self.tabs.iter().map(|t| t.title.clone()).collect();
            let seed = format!("{} {} {}", tab.cwd, space_name, titles.join(" "));
            let fts: HashMap<String, f64> = self
                .db
                .search_fts(&tab.space_id, &inject::build_match_query(&seed))
                .into_iter()
                .collect();
            let selected = inject::select(&rows, now, &fts);
            inject::write_context(&tab.cwd, &selected, &space_name);
        }

        let fresh_only = self.no_resume_once.remove(&tab.id);
        let resume = if !fresh_only
            && tab.kind == TabKind::Claude
            && tab.pinned
            && self.settings.restore_pinned_sessions
        {
            tab.last_session_id
                .clone()
                .filter(|s| pty::is_uuid(s))
                .filter(|s| pty::transcript_path_for(&tab.cwd, s).exists())
        } else {
            None
        };
        match TermSession::spawn(
            tab.kind,
            &tab.cwd,
            resume.as_deref(),
            self.settings.scrollback,
            self.cursor_style(),
            Arc::clone(&self.osc),
            Some(ctx.clone()),
        ) {
            Ok(session) => {
                if tab.kind == TabKind::Claude {
                    self.db.set_tab_last_session(&tab.id, &session.session_id);
                    // Deterministic transcript path -> prompt navigator feed.
                    let path = pty::transcript_path_for(&tab.cwd, &session.session_id);
                    self.prompt_feeds.insert(tab.id.clone(), PromptFeed::new(path));
                }
                self.sessions.insert(tab.id.clone(), session);
            }
            Err(err) => {
                self.spawn_errors.insert(tab.id.clone(), err);
            }
        }
    }

    fn handle_action(&mut self, action: Action, ctx: &egui::Context) {
        match action {
            Action::SelectSpace(id) => {
                self.active_space = id;
                self.db.meta_set("active_space", &self.active_space);
                self.load_tabs();
                if self.show_memory {
                    self.reload_memories();
                }
                self.focus_terminal = true;
            }
            Action::NewSpace => {
                let name = format!("Space {}", self.spaces.len() + 1);
                let space = self.db.create_space(&name, None);
                self.spaces = self.db.list_spaces();
                self.handle_action(Action::SelectSpace(space.id), ctx);
            }
            Action::RenameSpace(id, name) => {
                self.db.rename_space(&id, &name);
                self.spaces = self.db.list_spaces();
            }
            Action::DeleteSpace(id) => {
                for tab in self.db.list_tabs(&id) {
                    self.sessions.remove(&tab.id);
                    self.prompt_feeds.remove(&tab.id);
                    self.spawn_errors.remove(&tab.id);
                }
                self.db.delete_space(&id);
                self.spaces = self.db.list_spaces();
                if self.active_space == id {
                    let next = self
                        .spaces
                        .first()
                        .map(|s| s.id.clone())
                        .unwrap_or_default();
                    if next.is_empty() {
                        self.db.ensure_seed();
                        self.spaces = self.db.list_spaces();
                    }
                    let next = self.spaces.first().map(|s| s.id.clone()).unwrap_or_default();
                    self.handle_action(Action::SelectSpace(next), ctx);
                } else {
                    self.load_tabs();
                }
            }
            Action::SetDefaultSpace(id) => {
                self.db.set_default_space(&id);
                self.spaces = self.db.list_spaces();
            }
            Action::SelectTab(id) => self.set_active_tab(id),
            Action::NewTab(kind) => {
                let cwd = self
                    .current_tab()
                    .map(|t| t.cwd)
                    .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().to_string()))
                    .unwrap_or_else(|| "/".to_string());
                let title = match kind {
                    TabKind::Claude => "New chat",
                    TabKind::Shell => "Shell",
                };
                let tab = self.db.create_tab(&self.active_space, kind, title, &cwd);
                self.load_tabs();
                self.set_active_tab(tab.id);
            }
            Action::CloseTab(id) => {
                self.sessions.remove(&id);
                self.prompt_feeds.remove(&id);
                self.discovery_at.remove(&id);
                self.extracted_upto.remove(&id);
                self.spawn_errors.remove(&id);
                self.no_resume_once.remove(&id);
                self.db.delete_tab(&id);
                if self.active_tab.get(&self.active_space) == Some(&id) {
                    self.active_tab.remove(&self.active_space);
                }
                self.load_tabs();
            }
            Action::SetPinned(id, pinned) => {
                self.db.set_tab_pinned(&id, pinned);
                self.load_tabs();
            }
            Action::RenameTab(id, title) => {
                self.db.rename_tab(&id, &title);
                self.load_tabs();
            }
        }
    }

    fn handle_shortcuts(&mut self, ctx: &egui::Context) {
        let cmd = Modifiers::COMMAND;
        let mut actions: Vec<Action> = Vec::new();
        let mut toggle_settings = false;
        let mut toggle_sidebar = false;
        let mut toggle_memory = false;
        let mut clear_terminal = false;
        let mut select_index: Option<usize> = None;
        let mut cycle: i32 = 0;

        ctx.input_mut(|i| {
            if i.consume_key(cmd | Modifiers::SHIFT, Key::T) {
                actions.push(Action::NewTab(TabKind::Shell));
            }
            if i.consume_key(cmd, Key::T) {
                actions.push(Action::NewTab(TabKind::Claude));
            }
            if i.consume_key(cmd, Key::W) {
                // Sentinel: resolved to the current tab after the input lock.
                actions.push(Action::CloseTab(String::new()));
            }
            if i.consume_key(cmd, Key::Comma) {
                toggle_settings = true;
            }
            if i.consume_key(cmd, Key::S) {
                toggle_sidebar = true;
            }
            if i.consume_key(cmd, Key::M) {
                toggle_memory = true;
            }
            if i.consume_key(cmd, Key::K) {
                clear_terminal = true;
            }
            if i.consume_key(cmd | Modifiers::SHIFT, Key::CloseBracket) {
                cycle = 1;
            }
            if i.consume_key(cmd | Modifiers::SHIFT, Key::OpenBracket) {
                cycle = -1;
            }
            let digits = [
                Key::Num1, Key::Num2, Key::Num3, Key::Num4, Key::Num5,
                Key::Num6, Key::Num7, Key::Num8, Key::Num9,
            ];
            for (idx, key) in digits.iter().enumerate() {
                if i.consume_key(cmd, *key) {
                    select_index = Some(idx);
                }
            }
        });

        if toggle_settings {
            self.show_settings = !self.show_settings;
        }
        if toggle_sidebar {
            self.sidebar_visible = !self.sidebar_visible;
        }
        if toggle_memory {
            self.show_memory = !self.show_memory;
            if self.show_memory {
                self.reload_memories();
            }
        }
        if clear_terminal {
            if let Some(tab) = self.current_tab() {
                if let Some(session) = self.sessions.get(&tab.id) {
                    session.clear_local();
                }
            }
        }
        if let Some(idx) = select_index {
            if let Some(tab) = self.tabs.get(idx) {
                let id = tab.id.clone();
                self.set_active_tab(id);
            }
        }
        if cycle != 0 && !self.tabs.is_empty() {
            let current = self.active_tab.get(&self.active_space);
            let pos = self
                .tabs
                .iter()
                .position(|t| Some(&t.id) == current)
                .unwrap_or(0);
            let len = self.tabs.len() as i32;
            let next = ((pos as i32 + cycle) % len + len) % len;
            let id = self.tabs[next as usize].id.clone();
            self.set_active_tab(id);
        }
        for action in actions {
            match action {
                Action::CloseTab(id) if id.is_empty() => {
                    if let Some(tab) = self.current_tab() {
                        self.handle_action(Action::CloseTab(tab.id), ctx);
                    }
                }
                other => self.handle_action(other, ctx),
            }
        }
    }

    fn dead_overlay(
        &self,
        ctx: &egui::Context,
        rect: egui::Rect,
        tab_id: &str,
        exit_code: i32,
    ) -> Option<DeadChoice> {
        let painter = ctx.layer_painter(egui::LayerId::new(
            egui::Order::Middle,
            egui::Id::new(("dead-dim", tab_id)),
        ));
        painter.rect_filled(rect, CornerRadius::ZERO, Color32::from_black_alpha(130));

        let mut choice = None;
        egui::Area::new(egui::Id::new(("dead-overlay", tab_id)))
            .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                Frame::NONE
                    .fill(self.theme.chrome.chrome)
                    .corner_radius(CornerRadius::from(10.0))
                    .inner_margin(18.0)
                    .stroke(egui::Stroke::new(1.0_f32, self.theme.chrome.titlebar_1))
                    .show(ui, |ui| {
                        ui.vertical_centered(|ui| {
                            ui.label(
                                RichText::new(format!("Session ended (exit {exit_code})"))
                                    .color(self.theme.chrome.text)
                                    .size(13.5),
                            );
                            ui.add_space(10.0);
                            ui.horizontal(|ui| {
                                if ui.button("Restart session").clicked() {
                                    choice = Some(DeadChoice::Restart);
                                }
                                if ui.button("Close tab").clicked() {
                                    choice = Some(DeadChoice::Close);
                                }
                            });
                        });
                    });
            });
        choice
    }
}

enum DeadChoice {
    Restart,
    Close,
}

impl eframe::App for ZedeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.handle_shortcuts(ctx);

        // Sync results land here; the worker already persisted the summary to
        // meta, so this is just a refresh of everything sync can change.
        while let Ok(_result) = self.sync_rx.try_recv() {
            self.sync_busy = false;
            self.spaces = self.db.list_spaces();
            self.load_tabs();
            self.settings = Settings::load(&self.db);
            let next_theme = theme::theme_by_id(&self.settings.theme);
            if !std::ptr::eq(next_theme, self.theme) {
                self.theme = next_theme;
                if let Ok(mut osc) = self.osc.write() {
                    *osc = osc_from_theme(next_theme);
                }
                apply_visuals(ctx, next_theme);
            }
            if self.show_memory {
                self.reload_memories();
            }
        }

        let th = self.theme;
        let mut pending: Vec<Action> = Vec::new();

        // --- capture: every live tab in this Space tails its transcript.
        // Discovery binds sessions Zede didn't spawn (a `claude` typed into a
        // shell tab, using the tab's LIVE cwd); polling queues new prompts for
        // the extraction worker; results store here (db stays single-writer).
        {
            let mut auto_title: Option<(String, String)> = None;
            let mut rebinds: Vec<(String, std::path::PathBuf, String)> = Vec::new();
            let tabs_snapshot = self.tabs.clone();
            for tab in &tabs_snapshot {
                let Some(session) = self.sessions.get(&tab.id) else { continue };
                if session.is_dead() {
                    continue;
                }
                let started = session.started_epoch_ms;
                let fg_pid = session.foreground_pid();
                let due = self
                    .discovery_at
                    .get(&tab.id)
                    .map(|at| at.elapsed().as_secs() >= 2)
                    .unwrap_or(true);
                if due {
                    self.discovery_at.insert(tab.id.clone(), Instant::now());
                    let live_cwd = fg_pid
                        .and_then(pty::process_cwd)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|| tab.cwd.clone());
                    let dir = pty::transcript_dir_for(&live_cwd);
                    if let Some((path, sid, _)) = capture::newest_transcript(&dir, started) {
                        let bound = self
                            .prompt_feeds
                            .get(&tab.id)
                            .map(|f| f.path() == path.as_path())
                            .unwrap_or(false);
                        if !bound {
                            rebinds.push((tab.id.clone(), path, sid));
                        }
                    }
                }

                if let Some(feed) = self.prompt_feeds.get_mut(&tab.id) {
                    if feed.poll() {
                        let upto = self
                            .extracted_upto
                            .get(&tab.id)
                            .copied()
                            .unwrap_or(0)
                            .min(feed.prompts.len());
                        let new: Vec<String> = feed.prompts[upto..]
                            .iter()
                            .map(|p| format!("User: {}", p.text))
                            .collect();
                        if !new.is_empty() {
                            let _ = self.learn_tx.send(extract::LearnRequest {
                                space_id: tab.space_id.clone(),
                                span: new.join("\n\n"),
                                tier: self.settings.extraction_tier.clone(),
                            });
                        }
                        self.extracted_upto.insert(tab.id.clone(), feed.prompts.len());
                    }
                    // Default-titled chats take their first prompt as a title.
                    if tab.title == "New chat" && auto_title.is_none() {
                        if let Some(first) = feed.prompts.first() {
                            let mut t: String = first.text.chars().take(30).collect();
                            if first.text.chars().count() > 30 {
                                t.push('…');
                            }
                            auto_title = Some((tab.id.clone(), t));
                        }
                    }
                }
            }
            for (tab_id, path, sid) in rebinds {
                self.prompt_feeds.insert(tab_id.clone(), PromptFeed::new(path));
                self.extracted_upto.insert(tab_id.clone(), 0);
                if pty::is_uuid(&sid) {
                    self.db.set_tab_last_session(&tab_id, &sid);
                }
            }
            if !self.sessions.is_empty() {
                // Keep capture ticking while panes are idle.
                ctx.request_repaint_after(std::time::Duration::from_secs(2));
            }
            if let Some((id, title)) = auto_title {
                self.db.rename_tab(&id, &title);
                self.load_tabs();
            }

            let mut learned = 0usize;
            while let Ok(result) = self.learn_rx.try_recv() {
                learned += extract::store_candidates(&self.db, &result.space_id, &result.candidates);
            }
            if learned > 0 {
                self.last_learned = Some((Instant::now(), learned));
                if self.show_memory {
                    self.reload_memories();
                }
            }
        }

        // --- header bar ------------------------------------------------------
        egui::TopBottomPanel::top("header")
            .exact_height(36.0)
            .frame(Frame::NONE.fill(th.chrome.titlebar_2))
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.add_space(12.0);
                    let space_name = self
                        .spaces
                        .iter()
                        .find(|s| s.id == self.active_space)
                        .map(|s| s.name.clone())
                        .unwrap_or_default();
                    ui.label(RichText::new(space_name).color(th.chrome.text_3).size(12.0));
                    if let Some(tab) = self.current_tab() {
                        ui.label(RichText::new("›").color(th.chrome.muted).size(12.0));
                        let live_title = self
                            .sessions
                            .get(&tab.id)
                            .map(|s| s.title())
                            .filter(|t| !t.is_empty());
                        let title = live_title.unwrap_or(tab.title);
                        ui.label(RichText::new(title).color(th.chrome.text).size(12.5));
                    }
                    if let Some((at, n)) = self.last_learned {
                        if at.elapsed().as_secs() < 5 {
                            ui.label(
                                RichText::new(format!("✦ learned {n}"))
                                    .color(th.chrome.green)
                                    .size(11.0),
                            );
                        }
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.add_space(10.0);
                        if ui
                            .button(RichText::new("⚙").size(14.0))
                            .on_hover_text("Settings (⌘,)")
                            .clicked()
                        {
                            self.show_settings = !self.show_settings;
                        }
                    });
                });
            });

        // --- spaces rail + tab sidebar --------------------------------------
        if self.sidebar_visible {
            egui::SidePanel::left("rail")
                .exact_width(52.0)
                .resizable(false)
                .frame(Frame::NONE.fill(th.chrome.editor_header))
                .show(ctx, |ui| {
                    if let Some(a) = sidebar::spaces_rail(ui, &self.spaces, &self.active_space, th) {
                        pending.push(a);
                    }
                });

            let space = self
                .spaces
                .iter()
                .find(|s| s.id == self.active_space)
                .cloned();
            if let Some(space) = space {
                // Live info for icons (foreground proc needs &mut session).
                let mut live: HashMap<String, TabLive> = HashMap::new();
                for tab in &self.tabs {
                    if let Some(session) = self.sessions.get_mut(&tab.id) {
                        live.insert(
                            tab.id.clone(),
                            TabLive {
                                proc: session.foreground_proc(),
                                dead: session.is_dead(),
                                live: true,
                            },
                        );
                    }
                }
                let active_tab = self.active_tab.get(&self.active_space).cloned();
                let prompts = active_tab
                    .as_deref()
                    .and_then(|id| self.prompt_feeds.get(id))
                    .map(|f| f.prompts.as_slice());
                let sidebar_state = &mut self.sidebar_state;
                let tabs = &self.tabs;
                egui::SidePanel::left("tabs")
                    .default_width(212.0)
                    .width_range(170.0..=320.0)
                    .frame(Frame::NONE.fill(th.chrome.chrome))
                    .show(ctx, |ui| {
                        if let Some(a) = sidebar::tab_panel(
                            ui,
                            &space,
                            tabs,
                            active_tab.as_deref(),
                            &live,
                            prompts,
                            th,
                            sidebar_state,
                        ) {
                            pending.push(a);
                        }
                    });
            }
        }

        // --- memory sidebar (⌘M) ---------------------------------------------
        if self.show_memory {
            if self.memory_filter != self.memory_last_filter {
                self.reload_memories();
            }
            let mut mem_action = None;
            let rows = &self.memory_rows;
            let filter = &mut self.memory_filter;
            let electron_available = self.electron_db_available;
            let report = self.import_report.clone();
            egui::SidePanel::right("memory")
                .default_width(280.0)
                .width_range(220.0..=420.0)
                .frame(Frame::NONE.fill(th.chrome.chrome))
                .show(ctx, |ui| {
                    mem_action = memory::memory_panel(
                        ui,
                        rows,
                        filter,
                        electron_available,
                        report.as_deref(),
                        th,
                    );
                });
            if let Some(a) = mem_action {
                self.handle_memory_action(a);
            }
        }

        // --- terminal --------------------------------------------------------
        egui::CentralPanel::default()
            .frame(Frame::NONE.fill(th.term.background))
            .show(ctx, |ui| {
                let Some(tab) = self.current_tab() else {
                    ui.centered_and_justified(|ui| {
                        ui.label(
                            RichText::new("⌘T — new Claude tab")
                                .color(th.chrome.muted)
                                .size(14.0),
                        );
                    });
                    return;
                };

                self.spawn_session_for(&tab, ctx);

                if let Some(err) = self.spawn_errors.get(&tab.id).cloned() {
                    ui.centered_and_justified(|ui| {
                        ui.vertical_centered(|ui| {
                            ui.label(
                                RichText::new(format!("Failed to start terminal: {err}"))
                                    .color(th.chrome.red),
                            );
                            ui.add_space(8.0);
                            if ui.button("Retry").clicked() {
                                self.spawn_errors.remove(&tab.id);
                            }
                        });
                    });
                    return;
                }

                let focus = self.focus_terminal;
                self.focus_terminal = false;
                let (resp_rect, dead, exit_code) = {
                    let session = self.sessions.get_mut(&tab.id).expect("session spawned");
                    let resp = terminal::terminal_view(ui, session, th, &self.settings, focus);
                    (resp.rect, session.is_dead(), session.exit_code())
                };

                if dead {
                    match self.dead_overlay(ctx, resp_rect, &tab.id, exit_code) {
                        Some(DeadChoice::Restart) => {
                            self.sessions.remove(&tab.id);
                            self.no_resume_once.insert(tab.id.clone());
                            self.focus_terminal = true;
                        }
                        Some(DeadChoice::Close) => pending.push(Action::CloseTab(tab.id.clone())),
                        None => {}
                    }
                }
            });

        // --- settings --------------------------------------------------------
        if self.show_settings {
            let status = sync::status(&self.db);
            let sync_ui = settings_panel::SyncUi {
                configured: status.configured,
                busy: self.sync_busy,
                last_result: status.last_result,
                url: &mut self.sync_url_input,
                mode: &mut self.sync_mode_input,
            };
            let (changes, sync_action) =
                settings_panel::settings_window(ctx, &mut self.show_settings, &self.settings, th, sync_ui);
            match sync_action {
                Some(settings_panel::SyncAction::Connect) => {
                    self.sync_busy = true;
                    let _ = self.sync_tx.send(SyncCmd::Setup {
                        url: self.sync_url_input.clone(),
                        mode: self.sync_mode_input.clone(),
                    });
                }
                Some(settings_panel::SyncAction::SyncNow) => {
                    self.sync_busy = true;
                    let _ = self.sync_tx.send(SyncCmd::Now);
                }
                Some(settings_panel::SyncAction::Disconnect) => {
                    sync::disconnect(&self.db);
                }
                None => {}
            }
            if !changes.is_empty() {
                let theme_changed = changes.iter().any(|(k, _)| *k == "theme");
                for (key, value) in &changes {
                    settings::save_setting(&self.db, key, value);
                }
                self.settings = Settings::load(&self.db);
                if theme_changed {
                    self.theme = theme::theme_by_id(&self.settings.theme);
                    if let Ok(mut osc) = self.osc.write() {
                        *osc = osc_from_theme(self.theme);
                    }
                    apply_visuals(ctx, self.theme);
                }
            }
        }

        for action in pending {
            self.handle_action(action, ctx);
        }
    }
}
