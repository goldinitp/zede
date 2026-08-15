//! One live terminal session: a PTY, a reader thread, and an alacritty
//! `Term` grid behind a fair mutex. The UI thread renders the grid and writes
//! input; the reader thread parses PTY bytes into the grid and requests
//! repaints. There is no IPC hop anywhere between a keystroke and pixels.

pub mod keys;

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use alacritty_terminal::event::{Event as TermEvent, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config as TermConfig, Term, TermMode};
use alacritty_terminal::vte::ansi::{CursorStyle as AnsiCursorStyle, Processor, Rgb as AnsiRgb};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::pty::{self, TabKind};

/// Target grid dimensions (alacritty's `Dimensions` for `Term::new`/`resize`).
#[derive(Clone, Copy)]
struct GridSize {
    cols: usize,
    lines: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Colors the terminal reports back for OSC 4/10/11 queries (Claude Code
/// queries the background at startup to pick its theme). Updated on theme
/// change so live sessions answer with current values.
#[derive(Clone, Copy)]
pub struct OscColors {
    pub ansi: [AnsiRgb; 16],
    pub foreground: AnsiRgb,
    pub background: AnsiRgb,
    pub cursor: AnsiRgb,
}

impl OscColors {
    fn lookup(&self, index: usize) -> AnsiRgb {
        match index {
            0..=15 => self.ansi[index],
            16..=231 => {
                let n = index as u32 - 16;
                let cube = |v: u32| -> u8 { if v == 0 { 0 } else { (v * 40 + 55) as u8 } };
                AnsiRgb { r: cube(n / 36), g: cube((n % 36) / 6), b: cube(n % 6) }
            }
            232..=255 => {
                let v = (8 + 10 * (index as u32 - 232)) as u8;
                AnsiRgb { r: v, g: v, b: v }
            }
            257 => self.background,
            258 => self.cursor,
            _ => self.foreground, // 256 (foreground) and anything exotic
        }
    }
}

/// State shared between the UI thread, the reader thread and the event proxy.
pub struct SessionShared {
    start: Instant,
    pub dead: AtomicBool,
    pub exit_code: AtomicI32,
    pub title: Mutex<String>,
    /// ms since session start of the last PTY output (0 = none yet).
    pub last_output_ms: AtomicU64,
    pub bell_at_ms: AtomicU64,
    pub window_size: Mutex<WindowSize>,
}

impl SessionShared {
    fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// Listener alacritty's `Term` reports into (called on the reader thread while
/// the term lock is held — keep handlers non-blocking and lock-free on term).
#[derive(Clone)]
pub struct EventProxy {
    ctx: Option<egui::Context>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    shared: Arc<SessionShared>,
    osc: Arc<RwLock<OscColors>>,
}

impl EventProxy {
    fn write_pty(&self, bytes: &[u8]) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(bytes);
            let _ = w.flush();
        }
    }

    fn repaint(&self) {
        if let Some(ctx) = &self.ctx {
            ctx.request_repaint();
        }
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: TermEvent) {
        match event {
            TermEvent::Wakeup => self.repaint(),
            TermEvent::PtyWrite(text) => self.write_pty(text.as_bytes()),
            TermEvent::Title(title) => {
                if let Ok(mut t) = self.shared.title.lock() {
                    *t = title;
                }
                self.repaint();
            }
            TermEvent::ResetTitle => {
                if let Ok(mut t) = self.shared.title.lock() {
                    t.clear();
                }
                self.repaint();
            }
            TermEvent::ColorRequest(index, format) => {
                let rgb = self.osc.read().map(|o| o.lookup(index)).unwrap_or(AnsiRgb {
                    r: 0,
                    g: 0,
                    b: 0,
                });
                self.write_pty(format(rgb).as_bytes());
            }
            TermEvent::TextAreaSizeRequest(format) => {
                let size = self
                    .shared
                    .window_size
                    .lock()
                    .map(|s| *s)
                    .unwrap_or(WindowSize { num_lines: 24, num_cols: 80, cell_width: 8, cell_height: 16 });
                self.write_pty(format(size).as_bytes());
            }
            TermEvent::ClipboardStore(_, text) => {
                if let Some(ctx) = &self.ctx {
                    ctx.copy_text(text);
                }
            }
            // Never let an app read the clipboard silently.
            TermEvent::ClipboardLoad(..) => {}
            TermEvent::Bell => {
                self.shared
                    .bell_at_ms
                    .store(self.shared.elapsed_ms().max(1), Ordering::Relaxed);
                self.repaint();
            }
            TermEvent::CursorBlinkingChange => self.repaint(),
            TermEvent::MouseCursorDirty | TermEvent::Exit | TermEvent::ChildExit(_) => {}
        }
    }
}

struct PendingResize {
    cols: u16,
    rows: u16,
    cell_w: u16,
    cell_h: u16,
    set_at_ms: u64,
}

/// A live terminal bound to a tab.
pub struct TermSession {
    pub term: Arc<FairMutex<Term<EventProxy>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pub shared: Arc<SessionShared>,
    pub session_id: String,
    /// Wall-clock spawn time — transcript discovery only binds sessions
    /// started during this tab's lifetime.
    pub started_epoch_ms: i64,
    #[allow(dead_code)] // "resumed session" badge (P5)
    pub resumed: bool,
    pub kind: TabKind,
    pub cols: u16,
    pub rows: u16,
    pub has_initial_resize: bool,
    pending_resize: Option<PendingResize>,
    proc_cache: Option<(Instant, Option<String>)>,
    pub scroll_accum: f32,
    /// Desired grid size awaiting the resize debounce (size, first seen).
    pub debounce: Option<((u16, u16, u16, u16), Instant)>,
}

impl TermSession {
    pub fn spawn(
        kind: TabKind,
        cwd: &str,
        resume_session_id: Option<&str>,
        scrollback: u32,
        cursor_style: AnsiCursorStyle,
        osc: Arc<RwLock<OscColors>>,
        ctx: Option<egui::Context>,
    ) -> Result<TermSession, String> {
        let plan = pty::spawn_plan(kind, resume_session_id);
        Self::spawn_inner(plan, kind, cwd, scrollback, cursor_style, osc, ctx)
    }

    /// Spawn an arbitrary command (selftest harness; no login-shell plan).
    pub fn spawn_raw(
        program: &str,
        args: &[&str],
        cwd: &str,
        scrollback: u32,
        cursor_style: AnsiCursorStyle,
        osc: Arc<RwLock<OscColors>>,
    ) -> Result<TermSession, String> {
        let plan = pty::SpawnPlan {
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            session_id: uuid::Uuid::new_v4().to_string(),
            resumed: false,
        };
        Self::spawn_inner(plan, TabKind::Shell, cwd, scrollback, cursor_style, osc, None)
    }

    fn spawn_inner(
        plan: pty::SpawnPlan,
        kind: TabKind,
        cwd: &str,
        scrollback: u32,
        cursor_style: AnsiCursorStyle,
        osc: Arc<RwLock<OscColors>>,
        ctx: Option<egui::Context>,
    ) -> Result<TermSession, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {e}"))?;

        let mut cmd = CommandBuilder::new(&plan.program);
        for arg in &plan.args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);
        cmd.env_clear();
        for (k, v) in pty::terminal_environment() {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn {}: {e}", plan.program))?;
        drop(pair.slave);

        let master = pair.master;
        let reader = master
            .try_clone_reader()
            .map_err(|e| format!("pty reader: {e}"))?;
        let writer = Arc::new(Mutex::new(
            master.take_writer().map_err(|e| format!("pty writer: {e}"))?,
        ));
        let killer = child.clone_killer();

        let shared = Arc::new(SessionShared {
            start: Instant::now(),
            dead: AtomicBool::new(false),
            exit_code: AtomicI32::new(0),
            title: Mutex::new(String::new()),
            last_output_ms: AtomicU64::new(0),
            bell_at_ms: AtomicU64::new(0),
            window_size: Mutex::new(WindowSize {
                num_lines: 24,
                num_cols: 80,
                cell_width: 8,
                cell_height: 16,
            }),
        });

        let proxy = EventProxy {
            ctx: ctx.clone(),
            writer: Arc::clone(&writer),
            shared: Arc::clone(&shared),
            osc,
        };

        let config = TermConfig {
            scrolling_history: scrollback as usize,
            default_cursor_style: cursor_style,
            ..TermConfig::default()
        };
        let term = Arc::new(FairMutex::new(Term::new(
            config,
            &GridSize { cols: 80, lines: 24 },
            proxy,
        )));

        // Reader thread: parse PTY bytes into the grid, then reap the child on
        // EOF so the exit overlay can show a real code.
        {
            let term = Arc::clone(&term);
            let shared = Arc::clone(&shared);
            let mut reader = reader;
            std::thread::Builder::new()
                .name("zede-pty-reader".into())
                .spawn(move || {
                    let mut processor: Processor = Processor::new();
                    let mut buf = [0u8; 65536];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                {
                                    let mut t = term.lock();
                                    processor.advance(&mut *t, &buf[..n]);
                                }
                                shared
                                    .last_output_ms
                                    .store(shared.elapsed_ms().max(1), Ordering::Relaxed);
                                if let Some(ctx) = &ctx {
                                    ctx.request_repaint();
                                }
                            }
                        }
                    }
                    let code = child
                        .wait()
                        .map(|status| status.exit_code() as i32)
                        .unwrap_or(-1);
                    shared.exit_code.store(code, Ordering::Relaxed);
                    shared.dead.store(true, Ordering::Relaxed);
                    if let Some(ctx) = &ctx {
                        ctx.request_repaint();
                    }
                })
                .map_err(|e| format!("reader thread: {e}"))?;
        }

        Ok(TermSession {
            term,
            writer,
            master,
            killer,
            shared,
            started_epoch_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            session_id: plan.session_id,
            resumed: plan.resumed,
            kind,
            cols: 80,
            rows: 24,
            has_initial_resize: false,
            pending_resize: None,
            proc_cache: None,
            scroll_accum: 0.0,
            debounce: None,
        })
    }

    pub fn write(&self, bytes: &[u8]) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(bytes);
            let _ = w.flush();
        }
    }

    pub fn is_dead(&self) -> bool {
        self.shared.dead.load(Ordering::Relaxed)
    }

    pub fn exit_code(&self) -> i32 {
        self.shared.exit_code.load(Ordering::Relaxed)
    }

    pub fn title(&self) -> String {
        self.shared.title.lock().map(|t| t.clone()).unwrap_or_default()
    }

    pub fn mode(&self) -> TermMode {
        *self.term.lock().mode()
    }

    /// Foreground process-group leader pid (uncached; one cheap syscall).
    pub fn foreground_pid(&self) -> Option<i32> {
        self.master.process_group_leader().map(|pid| pid as i32)
    }

    /// Foreground process name of the PTY (cached ~500ms). Drives the
    /// shell→claude icon swap and resize deferral.
    pub fn foreground_proc(&mut self) -> Option<String> {
        if let Some((at, name)) = &self.proc_cache {
            if at.elapsed().as_millis() < 500 {
                return name.clone();
            }
        }
        let name = self
            .master
            .process_group_leader()
            .and_then(|pid| pty::process_name(pid as i32));
        self.proc_cache = Some((Instant::now(), name.clone()));
        name
    }

    fn foreground_is_shell(&mut self) -> bool {
        match self.foreground_proc() {
            Some(name) => pty::is_shell_process(&name),
            None => false,
        }
    }

    /// Resize with the idle-shell deferral rule: rich zsh prompts may append a
    /// fresh prompt on every SIGWINCH, so idle shell tabs hold the pending size
    /// until a foreground program starts producing output.
    pub fn resize(&mut self, cols: u16, rows: u16, cell_w: u16, cell_h: u16) {
        let (cols, rows) = (cols.max(2), rows.max(2));
        if self.has_initial_resize && self.cols == cols && self.rows == rows {
            self.pending_resize = None;
            return;
        }
        if self.kind == TabKind::Shell && self.has_initial_resize && self.foreground_is_shell() {
            self.pending_resize = Some(PendingResize {
                cols,
                rows,
                cell_w,
                cell_h,
                set_at_ms: self.shared.elapsed_ms(),
            });
            return;
        }
        self.pending_resize = None;
        self.apply_resize(cols, rows, cell_w, cell_h);
    }

    /// Apply a deferred resize once a foreground program is active.
    pub fn maybe_flush_pending_resize(&mut self) {
        let Some(p) = &self.pending_resize else { return };
        let (cols, rows, cw, ch, set_at) = (p.cols, p.rows, p.cell_w, p.cell_h, p.set_at_ms);
        let output_since = self.shared.last_output_ms.load(Ordering::Relaxed) > set_at;
        if output_since && !self.foreground_is_shell() {
            self.pending_resize = None;
            self.apply_resize(cols, rows, cw, ch);
        }
    }

    fn apply_resize(&mut self, cols: u16, rows: u16, cell_w: u16, cell_h: u16) {
        self.term
            .lock()
            .resize(GridSize { cols: cols as usize, lines: rows as usize });
        let size = PtySize {
            rows,
            cols,
            pixel_width: cols * cell_w,
            pixel_height: rows * cell_h,
        };
        let _ = self.master.resize(size);
        if let Ok(mut ws) = self.shared.window_size.lock() {
            *ws = WindowSize {
                num_lines: rows,
                num_cols: cols,
                cell_width: cell_w,
                cell_height: cell_h,
            };
        }
        self.cols = cols;
        self.rows = rows;
        self.has_initial_resize = true;
    }

    pub fn scroll_display(&self, delta: i32) {
        self.term.lock().scroll_display(Scroll::Delta(delta));
    }

    pub fn scroll_to_bottom(&self) {
        self.term.lock().scroll_display(Scroll::Bottom);
    }

    /// Clear the local screen and scrollback (⌘K) without touching the PTY.
    pub fn clear_local(&self) {
        let mut processor: Processor = Processor::new();
        let mut t = self.term.lock();
        processor.advance(&mut *t, b"\x1b[H\x1b[2J\x1b[3J");
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl Drop for TermSession {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}
