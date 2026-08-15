//! Spaces rail + tab list (the Arc-style sidebar). Emits actions rather than
//! mutating app state, so the app layer owns all db/session effects.

use std::collections::HashMap;

use egui::{
    Align2, Color32, CornerRadius, FontId, Rect, RichText, Sense, Stroke, StrokeKind, Ui, Vec2,
};

use crate::capture::ChatPrompt;
use crate::db::{SpaceRow, TabRow};
use crate::pty::TabKind;
use crate::theme::AppTheme;

pub enum Action {
    SelectSpace(String),
    NewSpace,
    RenameSpace(String, String),
    DeleteSpace(String),
    SetDefaultSpace(String),
    SelectTab(String),
    NewTab(TabKind),
    CloseTab(String),
    SetPinned(String, bool),
    RenameTab(String, String),
}

/// Live-session info for icons/labels, precomputed by the app layer.
pub struct TabLive {
    pub proc: Option<String>,
    pub dead: bool,
    #[allow(dead_code)] // spawn-on-demand indicator (P5)
    pub live: bool,
}

#[derive(Default)]
pub struct SidebarState {
    /// (tab id, edit buffer) while a rename edit is open.
    pub renaming_tab: Option<(String, String)>,
    pub renaming_space: Option<(String, String)>,
}

pub fn spaces_rail(
    ui: &mut Ui,
    spaces: &[SpaceRow],
    active: &str,
    theme: &AppTheme,
) -> Option<Action> {
    let mut action = None;
    ui.add_space(10.0);
    for space in spaces {
        let selected = space.id == active;
        let label = space
            .icon
            .clone()
            .filter(|i| !i.is_empty())
            .unwrap_or_else(|| {
                space
                    .name
                    .chars()
                    .next()
                    .map(|c| c.to_uppercase().to_string())
                    .unwrap_or_else(|| "·".to_string())
            });

        let (rect, resp) = ui.allocate_exact_size(Vec2::new(44.0, 40.0), Sense::click());
        let box_rect = Rect::from_center_size(rect.center(), Vec2::splat(32.0));
        let painter = ui.painter();
        let fill = if selected {
            theme.chrome.titlebar_1
        } else if resp.hovered() {
            theme.chrome.chrome
        } else {
            Color32::TRANSPARENT
        };
        painter.rect_filled(box_rect, CornerRadius::from(9.0), fill);
        if selected {
            painter.rect_stroke(
                box_rect,
                CornerRadius::from(9.0),
                Stroke::new(1.0_f32, theme.chrome.accent),
                StrokeKind::Inside,
            );
        }
        let text_color = if selected { theme.chrome.text } else { theme.chrome.text_3 };
        painter.text(
            box_rect.center(),
            Align2::CENTER_CENTER,
            &label,
            FontId::proportional(14.0),
            text_color,
        );

        if resp.clicked() {
            action = Some(Action::SelectSpace(space.id.clone()));
        }
        resp.clone().on_hover_text(&space.name);
        resp.context_menu(|ui| {
            if ui.button("Make default").clicked() {
                action = Some(Action::SetDefaultSpace(space.id.clone()));
                ui.close();
            }
            if spaces.len() > 1 && ui.button("Delete Space").clicked() {
                action = Some(Action::DeleteSpace(space.id.clone()));
                ui.close();
            }
        });
        ui.add_space(2.0);
    }

    ui.add_space(4.0);
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(44.0, 36.0), Sense::click());
    let color = if resp.hovered() { theme.chrome.text_2 } else { theme.chrome.muted };
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        "+",
        FontId::proportional(20.0),
        color,
    );
    if resp.clicked() {
        action = Some(Action::NewSpace);
    }
    resp.on_hover_text("New Space");

    action
}

pub fn tab_panel(
    ui: &mut Ui,
    space: &SpaceRow,
    tabs: &[TabRow],
    active_tab: Option<&str>,
    live: &HashMap<String, TabLive>,
    prompts: Option<&[ChatPrompt]>,
    theme: &AppTheme,
    state: &mut SidebarState,
) -> Option<Action> {
    let mut action = None;

    // --- Space header (rename inline) --------------------------------------
    ui.add_space(10.0);
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        if let Some((id, buf)) = &mut state.renaming_space {
            let id = id.clone();
            let edit = ui.text_edit_singleline(buf);
            edit.request_focus();
            let commit = edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            let cancel = ui.input(|i| i.key_pressed(egui::Key::Escape));
            if commit && !buf.trim().is_empty() {
                action = Some(Action::RenameSpace(id, buf.trim().to_string()));
                state.renaming_space = None;
            } else if cancel || (edit.lost_focus() && !commit) {
                state.renaming_space = None;
            }
        } else {
            let name = ui.label(
                RichText::new(&space.name)
                    .color(theme.chrome.text)
                    .size(14.0)
                    .strong(),
            );
            let name = name.interact(Sense::click());
            if name.double_clicked() {
                state.renaming_space = Some((space.id.clone(), space.name.clone()));
            }
            if space.is_default {
                ui.label(RichText::new("default").color(theme.chrome.muted).size(10.0));
            }
        }
    });
    ui.add_space(8.0);

    // --- new tab buttons ----------------------------------------------------
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        let new_chat = egui::Button::new(
            RichText::new("+  New chat").color(theme.chrome.text).size(12.5),
        )
        .fill(theme.chrome.titlebar_1)
        .corner_radius(CornerRadius::from(7.0))
        .min_size(Vec2::new(130.0, 28.0));
        if ui.add(new_chat).clicked() {
            action = Some(Action::NewTab(TabKind::Claude));
        }
        let new_shell = egui::Button::new(
            RichText::new("❯_").color(theme.chrome.text_3).size(12.0),
        )
        .fill(theme.chrome.chrome)
        .corner_radius(CornerRadius::from(7.0))
        .min_size(Vec2::new(34.0, 28.0));
        if ui.add(new_shell).on_hover_text("New shell tab (⌘T with ⇧)").clicked() {
            action = Some(Action::NewTab(TabKind::Shell));
        }
    });
    ui.add_space(10.0);

    // --- tab rows -----------------------------------------------------------
    let show_prompts = prompts.map(|p| !p.is_empty()).unwrap_or(false);
    let tabs_max_height = if show_prompts {
        (ui.available_height() * 0.5).max(120.0)
    } else {
        f32::INFINITY
    };
    egui::ScrollArea::vertical()
        .id_salt("tab-rows")
        .max_height(tabs_max_height)
        .auto_shrink([false, false])
        .show(ui, |ui| {
        for tab in tabs {
            if let Some((id, mut buf)) = state.renaming_tab.take() {
                if id == tab.id {
                    let mut done = false;
                    ui.horizontal(|ui| {
                        ui.add_space(10.0);
                        let edit = ui.text_edit_singleline(&mut buf);
                        edit.request_focus();
                        let commit =
                            edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                        if commit && !buf.trim().is_empty() {
                            action = Some(Action::RenameTab(id.clone(), buf.trim().to_string()));
                            done = true;
                        } else if ui.input(|i| i.key_pressed(egui::Key::Escape))
                            || (edit.lost_focus() && !commit)
                        {
                            done = true;
                        }
                    });
                    if !done {
                        state.renaming_tab = Some((id, buf));
                    }
                    continue;
                }
                state.renaming_tab = Some((id, buf));
            }

            let info = live.get(&tab.id);
            let selected = active_tab == Some(tab.id.as_str());
            let row_w = ui.available_width();
            let (rect, resp) = ui.allocate_exact_size(Vec2::new(row_w, 30.0), Sense::click());
            let painter = ui.painter();
            let row_rect = Rect::from_min_size(
                rect.min + Vec2::new(6.0, 1.0),
                Vec2::new(row_w - 12.0, 28.0),
            );
            if selected {
                painter.rect_filled(row_rect, CornerRadius::from(7.0), theme.chrome.titlebar_1);
            } else if resp.hovered() {
                painter.rect_filled(row_rect, CornerRadius::from(7.0), theme.chrome.chrome);
            }

            // Icon: shell prompt, or Claude spark when claude runs in the tab.
            let proc = info.and_then(|i| i.proc.as_deref());
            let is_claude = proc.map(|p| p.contains("claude")).unwrap_or(tab.kind == TabKind::Claude);
            let dead = info.map(|i| i.dead).unwrap_or(false);
            let (icon, icon_color) = if dead {
                ("○", theme.chrome.muted)
            } else if is_claude {
                ("✳", theme.chrome.accent)
            } else {
                ("❯", theme.chrome.text_3)
            };
            painter.text(
                Rect::from_min_size(row_rect.min, Vec2::new(26.0, 28.0)).center(),
                Align2::CENTER_CENTER,
                icon,
                FontId::proportional(12.0),
                icon_color,
            );

            // Title (crudely truncated; the panel width is fixed).
            let title_color = if dead {
                theme.chrome.muted
            } else if selected {
                theme.chrome.text
            } else {
                theme.chrome.text_2
            };
            let max_chars = ((row_rect.width() - 54.0) / 6.6).max(4.0) as usize;
            let mut title: String = tab.title.chars().take(max_chars).collect();
            if title.len() < tab.title.len() {
                title.push('…');
            }
            painter.text(
                Rect::from_min_size(row_rect.min + Vec2::new(26.0, 0.0), Vec2::new(0.0, 28.0))
                    .center(),
                Align2::LEFT_CENTER,
                title,
                FontId::proportional(12.5),
                title_color,
            );

            if tab.pinned {
                painter.circle_filled(
                    Pos2::new(row_rect.max.x - 34.0, row_rect.center().y),
                    2.5,
                    theme.chrome.accent,
                );
            }

            // Close ×, shown on hover.
            let x_rect = Rect::from_center_size(
                Pos2::new(row_rect.max.x - 16.0, row_rect.center().y),
                Vec2::splat(18.0),
            );
            if resp.hovered() || selected {
                let x_resp = ui.interact(x_rect, resp.id.with("close"), Sense::click());
                let x_color = if x_resp.hovered() { theme.chrome.red } else { theme.chrome.muted };
                ui.painter().text(
                    x_rect.center(),
                    Align2::CENTER_CENTER,
                    "×",
                    FontId::proportional(13.0),
                    x_color,
                );
                if x_resp.clicked() {
                    action = Some(Action::CloseTab(tab.id.clone()));
                }
            }

            if resp.clicked() && action.is_none() {
                action = Some(Action::SelectTab(tab.id.clone()));
            }
            resp.context_menu(|ui| {
                let pin_label = if tab.pinned { "Unpin" } else { "Pin" };
                if ui.button(pin_label).clicked() {
                    action = Some(Action::SetPinned(tab.id.clone(), !tab.pinned));
                    ui.close();
                }
                if ui.button("Rename").clicked() {
                    state.renaming_tab = Some((tab.id.clone(), tab.title.clone()));
                    ui.close();
                }
                if ui.button("Close").clicked() {
                    action = Some(Action::CloseTab(tab.id.clone()));
                    ui.close();
                }
            });
        }
    });

    // --- prompt navigator (this chat's user prompts, newest first) ----------
    if show_prompts {
        let prompts = prompts.unwrap_or(&[]);
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.add_space(12.0);
            ui.label(
                RichText::new(format!("Prompts · {}", prompts.len()))
                    .color(theme.chrome.text_3)
                    .size(11.0)
                    .strong(),
            );
        });
        ui.add_space(4.0);
        egui::ScrollArea::vertical()
            .id_salt("prompt-rows")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for prompt in prompts.iter().rev() {
                    let row_w = ui.available_width();
                    let (rect, resp) =
                        ui.allocate_exact_size(Vec2::new(row_w, 24.0), Sense::click());
                    let row_rect = Rect::from_min_size(
                        rect.min + Vec2::new(6.0, 1.0),
                        Vec2::new(row_w - 12.0, 22.0),
                    );
                    if resp.hovered() {
                        ui.painter().rect_filled(
                            row_rect,
                            CornerRadius::from(6.0),
                            theme.chrome.titlebar_2,
                        );
                    }
                    let max_chars = ((row_rect.width() - 20.0) / 6.0).max(4.0) as usize;
                    let mut text: String = prompt.text.chars().take(max_chars).collect();
                    if text.chars().count() < prompt.text.chars().count() {
                        text.push('…');
                    }
                    ui.painter().text(
                        Rect::from_min_size(
                            row_rect.min + Vec2::new(10.0, 0.0),
                            Vec2::new(0.0, 22.0),
                        )
                        .center(),
                        Align2::LEFT_CENTER,
                        text,
                        FontId::proportional(11.5),
                        theme.chrome.text_3,
                    );
                    if resp.clicked() {
                        ui.ctx().copy_text(prompt.text.clone());
                    }
                    resp.on_hover_text(format!("{}\n\n(click to copy)", prompt.text));
                }
            });
    }

    action
}

use egui::Pos2;
