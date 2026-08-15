//! Settings window (`.modal` in app.css): frameless rounded card, uppercase
//! accent group labels, switch toggles. Emits (key, value) pairs in the same
//! string form the Electron app stored, so persistence and sync stay
//! compatible.

use egui::{Align2, ComboBox, Context, RichText, Slider, TextEdit, Window};

use crate::settings::{CursorStyleKind, Settings};
use crate::theme::{self, AppTheme};
use crate::ui::style;

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

fn group(ui: &mut egui::Ui, th: &AppTheme, text: &str) {
    ui.add_space(14.0);
    style::section_label(ui, text, th.chrome.accent);
    ui.add_space(4.0);
}

fn row<R>(
    ui: &mut egui::Ui,
    th: &AppTheme,
    label: &str,
    control: impl FnOnce(&mut egui::Ui) -> R,
) -> R {
    let result = ui
        .horizontal(|ui| {
            ui.label(RichText::new(label).color(th.chrome.text_2).size(13.0));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), control)
                .inner
        })
        .inner;
    ui.add_space(2.0);
    result
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
    let mut close = false;

    let mut theme_id = s.theme.clone();
    let mut font_size = s.font_size;
    let mut line_height = s.line_height;
    let mut letter_spacing = s.letter_spacing;
    let mut scrollback = s.scrollback as i64;
    let mut cursor_style = s.cursor_style;
    let mut cursor_blink = s.cursor_blink;
    let mut restore = s.restore_pinned_sessions;
    let mut tier = s.extraction_tier.clone();

    Window::new("settings")
        .title_bar(false)
        .collapsible(false)
        .resizable(false)
        .movable(true)
        .pivot(Align2::CENTER_CENTER)
        .default_pos(ctx.screen_rect().center())
        .fixed_size(egui::vec2(400.0, 0.0))
        .show(ctx, |ui| {
            ui.spacing_mut().slider_width = 150.0;

            // --- header ----------------------------------------------------
            ui.horizontal(|ui| {
                ui.label(RichText::new("Settings").size(15.0).strong().color(th.chrome.text));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if style::icon_button(ui, "×", 15.0, false, th).clicked() {
                        close = true;
                    }
                });
            });

            group(ui, th, "Appearance");
            row(ui, th, "Theme", |ui| {
                ComboBox::from_id_salt("theme")
                    .width(170.0)
                    .selected_text(theme::theme_by_id(&theme_id).name)
                    .show_ui(ui, |ui| {
                        for t in theme::themes() {
                            ui.selectable_value(&mut theme_id, t.id.to_string(), t.name);
                        }
                    });
            });
            row(ui, th, "Font size", |ui| {
                if ui.add(Slider::new(&mut font_size, 9.0..=24.0)).changed() {
                    changes.push(("fontSize", format!("{font_size}")));
                }
            });
            row(ui, th, "Line spacing", |ui| {
                if ui.add(Slider::new(&mut line_height, 1.0..=2.0)).changed() {
                    changes.push(("lineHeight", format!("{line_height}")));
                }
            });
            row(ui, th, "Letter spacing", |ui| {
                if ui.add(Slider::new(&mut letter_spacing, 0.0..=4.0)).changed() {
                    changes.push(("letterSpacing", format!("{letter_spacing}")));
                }
            });
            row(ui, th, "Scrollback", |ui| {
                if ui
                    .add(Slider::new(&mut scrollback, 500..=50_000).logarithmic(true))
                    .changed()
                {
                    changes.push(("scrollback", format!("{scrollback}")));
                }
            });
            row(ui, th, "Cursor", |ui| {
                ComboBox::from_id_salt("cursor")
                    .width(170.0)
                    .selected_text(cursor_style.as_str())
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut cursor_style, CursorStyleKind::Block, "block");
                        ui.selectable_value(
                            &mut cursor_style,
                            CursorStyleKind::Underline,
                            "underline",
                        );
                        ui.selectable_value(&mut cursor_style, CursorStyleKind::Bar, "bar");
                    });
            });
            row(ui, th, "Cursor blink", |ui| {
                if style::toggle(ui, &mut cursor_blink, th).changed() {
                    changes.push(("cursorBlink", if cursor_blink { "1" } else { "0" }.into()));
                }
            });

            ui.add_space(10.0);
            style::hairline(ui, th);
            group(ui, th, "Memory & capture");
            row(ui, th, "Resume pinned tabs on relaunch", |ui| {
                if style::toggle(ui, &mut restore, th).changed() {
                    changes.push(("restorePinnedSessions", if restore { "1" } else { "0" }.into()));
                }
            });
            row(ui, th, "Extraction", |ui| {
                ComboBox::from_id_salt("tier")
                    .width(170.0)
                    .selected_text(if tier == "claude" { "claude" } else { "heuristic" })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut tier, "claude".to_string(), "claude");
                        ui.selectable_value(&mut tier, "heuristic".to_string(), "heuristic");
                    });
            });
            ui.label(
                RichText::new("claude runs a fast model over new prompts; heuristic is free and offline.")
                    .size(10.5)
                    .color(th.chrome.muted),
            );

            ui.add_space(10.0);
            style::hairline(ui, th);
            group(ui, th, "Sync");
            if sync.busy {
                ui.label(RichText::new("Syncing…").color(th.chrome.amber).size(12.0));
            } else if sync.configured {
                ui.label(RichText::new(sync.url.as_str()).size(11.5).color(th.chrome.text_3));
                if let Some(last) = &sync.last_result {
                    ui.label(RichText::new(last).size(10.5).color(th.chrome.muted));
                }
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    if style::pill_button(ui, "Sync now", true, th).clicked() {
                        sync_action = Some(SyncAction::SyncNow);
                    }
                    if style::pill_button(ui, "Disconnect", false, th).clicked() {
                        sync_action = Some(SyncAction::Disconnect);
                    }
                });
            } else {
                ui.add(
                    TextEdit::singleline(sync.url)
                        .hint_text("git@github.com:you/zede-sync.git")
                        .desired_width(f32::INFINITY),
                );
                row(ui, th, "Auth", |ui| {
                    ComboBox::from_id_salt("auth")
                        .width(170.0)
                        .selected_text(if sync.mode.as_str() == "gh-cli" {
                            "GitHub CLI (gh)"
                        } else {
                            "git (ssh keys / helpers)"
                        })
                        .show_ui(ui, |ui| {
                            ui.selectable_value(
                                sync.mode,
                                "git".to_string(),
                                "git (ssh keys / helpers)",
                            );
                            ui.selectable_value(sync.mode, "gh-cli".to_string(), "GitHub CLI (gh)");
                        });
                });
                ui.add_space(2.0);
                if style::pill_button(ui, "Connect & sync", true, th).clicked() {
                    sync_action = Some(SyncAction::Connect);
                }
                ui.label(
                    RichText::new("Any git remote works: GitHub, GitLab, a NAS over ssh, or a local bare repo.")
                        .size(10.5)
                        .color(th.chrome.muted),
                );
            }

            ui.add_space(12.0);
            ui.label(
                RichText::new(format!("Zede native {}", env!("CARGO_PKG_VERSION")))
                    .size(10.5)
                    .color(th.chrome.muted),
            );
        });

    if close || ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        *open = false;
    }

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
