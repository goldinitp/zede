//! Settings window. Emits (key, value) pairs in the same string form the
//! Electron app stored, so persistence and future sync stay compatible.

use egui::{ComboBox, Context, RichText, Slider, TextEdit, Window};

use crate::settings::{CursorStyleKind, Settings};
use crate::theme::{self, AppTheme};

pub struct SyncUi<'a> {
    pub configured: bool,
    pub busy: bool,
    pub last_result: Option<String>,
    pub url: &'a mut String,
    pub mode: &'a mut String,
}

pub enum SyncAction {
    Connect,
    SyncNow,
    Disconnect,
}

pub fn settings_window(
    ctx: &Context,
    open: &mut bool,
    s: &Settings,
    th: &AppTheme,
    sync: SyncUi<'_>,
) -> (Vec<(&'static str, String)>, Option<SyncAction>) {
    let mut changes: Vec<(&'static str, String)> = Vec::new();
    let mut sync_action: Option<SyncAction> = None;

    let mut theme_id = s.theme.clone();
    let mut font_size = s.font_size;
    let mut line_height = s.line_height;
    let mut letter_spacing = s.letter_spacing;
    let mut scrollback = s.scrollback as i64;
    let mut cursor_style = s.cursor_style;
    let mut cursor_blink = s.cursor_blink;
    let mut restore = s.restore_pinned_sessions;
    let mut tier = s.extraction_tier.clone();

    Window::new("Settings")
        .open(open)
        .collapsible(false)
        .resizable(false)
        .default_width(360.0)
        .show(ctx, |ui| {
            ui.label(RichText::new("Appearance").strong().color(th.chrome.text));
            ui.add_space(6.0);

            ComboBox::from_label("Theme")
                .selected_text(theme::theme_by_id(&theme_id).name)
                .show_ui(ui, |ui| {
                    for t in theme::themes() {
                        ui.selectable_value(&mut theme_id, t.id.to_string(), t.name);
                    }
                });

            if ui
                .add(Slider::new(&mut font_size, 9.0..=24.0).text("Font size"))
                .changed()
            {
                changes.push(("fontSize", format!("{font_size}")));
            }
            if ui
                .add(Slider::new(&mut line_height, 1.0..=2.0).text("Line spacing"))
                .changed()
            {
                changes.push(("lineHeight", format!("{line_height}")));
            }
            if ui
                .add(Slider::new(&mut letter_spacing, 0.0..=4.0).text("Letter spacing"))
                .changed()
            {
                changes.push(("letterSpacing", format!("{letter_spacing}")));
            }
            if ui
                .add(
                    Slider::new(&mut scrollback, 500..=50_000)
                        .logarithmic(true)
                        .text("Scrollback (new sessions)"),
                )
                .changed()
            {
                changes.push(("scrollback", format!("{scrollback}")));
            }

            ComboBox::from_label("Cursor")
                .selected_text(cursor_style.as_str())
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut cursor_style, CursorStyleKind::Block, "block");
                    ui.selectable_value(&mut cursor_style, CursorStyleKind::Underline, "underline");
                    ui.selectable_value(&mut cursor_style, CursorStyleKind::Bar, "bar");
                });
            if ui.checkbox(&mut cursor_blink, "Cursor blink").changed() {
                changes.push(("cursorBlink", if cursor_blink { "1" } else { "0" }.into()));
            }

            ui.add_space(10.0);
            ui.separator();
            ui.add_space(6.0);
            ui.label(RichText::new("Memory & capture").strong().color(th.chrome.text));
            ui.add_space(6.0);
            if ui
                .checkbox(
                    &mut restore,
                    "Pinned tabs resume their last Claude session on relaunch",
                )
                .changed()
            {
                changes.push(("restorePinnedSessions", if restore { "1" } else { "0" }.into()));
            }
            ComboBox::from_label("Extraction")
                .selected_text(if tier == "claude" { "claude (higher recall)" } else { "heuristic (offline)" })
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut tier, "claude".to_string(), "claude (higher recall)");
                    ui.selectable_value(&mut tier, "heuristic".to_string(), "heuristic (offline)");
                });
            ui.label(
                RichText::new("claude runs a fast model over new prompts; heuristic is free and offline.")
                    .size(10.5)
                    .color(th.chrome.muted),
            );

            ui.add_space(10.0);
            ui.separator();
            ui.add_space(6.0);
            ui.label(RichText::new("Sync").strong().color(th.chrome.text));
            ui.add_space(6.0);
            if sync.busy {
                ui.label(RichText::new("Syncing…").color(th.chrome.amber).size(11.5));
            } else if sync.configured {
                ui.label(
                    RichText::new(sync.url.as_str())
                        .size(11.0)
                        .color(th.chrome.text_3),
                );
                if let Some(last) = &sync.last_result {
                    ui.label(RichText::new(last).size(10.5).color(th.chrome.muted));
                }
                ui.horizontal(|ui| {
                    if ui.button("Sync now").clicked() {
                        sync_action = Some(SyncAction::SyncNow);
                    }
                    if ui.button("Disconnect").clicked() {
                        sync_action = Some(SyncAction::Disconnect);
                    }
                });
            } else {
                ui.add(
                    TextEdit::singleline(sync.url)
                        .hint_text("git@github.com:you/zede-sync.git")
                        .desired_width(f32::INFINITY),
                );
                ComboBox::from_label("Auth")
                    .selected_text(if sync.mode.as_str() == "gh-cli" { "GitHub CLI (gh)" } else { "git (ssh keys / helpers)" })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(sync.mode, "git".to_string(), "git (ssh keys / helpers)");
                        ui.selectable_value(sync.mode, "gh-cli".to_string(), "GitHub CLI (gh)");
                    });
                if ui.button("Connect & sync").clicked() {
                    sync_action = Some(SyncAction::Connect);
                }
                ui.label(
                    RichText::new("Any git remote works: GitHub, GitLab, a NAS over ssh, or a local bare repo.")
                        .size(10.5)
                        .color(th.chrome.muted),
                );
            }

            ui.add_space(10.0);
            ui.label(
                RichText::new(format!("Zede native {}", env!("CARGO_PKG_VERSION")))
                    .size(10.5)
                    .color(th.chrome.muted),
            );
        });

    if theme_id != s.theme {
        changes.push(("theme", theme_id));
    }
    if cursor_style != s.cursor_style {
        changes.push(("cursorStyle", cursor_style.as_str().to_string()));
    }
    if tier != s.extraction_tier {
        changes.push(("extractionTier", tier));
    }
    (changes, sync_action)
}
