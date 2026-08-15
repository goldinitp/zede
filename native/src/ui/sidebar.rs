//! The sidebar (`.sidebar` in app.css): Space header, new-tab row, flat tab
//! rows, the prompt navigator, and the bottom Space-chip switcher. Emits
//! actions rather than mutating app state, so the app layer owns all
//! db/session effects.

use std::collections::HashMap;

use egui::{
    Align2, Color32, CornerRadius, FontId, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, Ui,
    Vec2,
};

use crate::capture::ChatPrompt;
use crate::db::{SpaceRow, TabRow};
use crate::pty::TabKind;
use crate::theme::AppTheme;
use crate::ui::style;

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

/// Middle-truncate to a pixel budget using the real galley width.
fn truncate_to_width(ui: &Ui, text: &str, font: &FontId, max_w: f32) -> String {
    let width = |s: &str| {
        ui.fonts(|f| {
            f.layout_no_wrap(s.to_string(), font.clone(), Color32::WHITE)
                .rect
                .width()
        })
    };
    if width(text) <= max_w {
        return text.to_string();
    }
    let mut out: String = text.to_string();
    while !out.is_empty() && width(&format!("{out}…")) > max_w {
        out.pop();
    }
    format!("{out}…")
}

#[allow(clippy::too_many_arguments)]
pub fn tab_panel(
    ui: &mut Ui,
    space: &SpaceRow,
    spaces: &[SpaceRow],
    tabs: &[TabRow],
    active_tab: Option<&str>,
    live: &HashMap<String, TabLive>,
    prompts: Option<&[ChatPrompt]>,
    theme: &AppTheme,
    state: &mut SidebarState,
) -> Option<Action> {
    let mut action = None;
    let ch = &theme.chrome;
    let panel = ui.max_rect();

    // Pane separator on the right edge (`--sep`).
    ui.painter().vline(
        panel.right() - 0.5,
        panel.y_range(),
        Stroke::new(1.0_f32, ch.sep()),
    );

    // Reserve the footer (Space chips) before laying the scrolling body.
    let footer_h = 42.0;
    let body_h = (ui.available_height() - footer_h - 1.0).max(40.0);

    ui.allocate_ui(Vec2::new(ui.available_width(), body_h), |ui| {
        ui.set_min_height(body_h);

        // --- Space header (`.sb-space`) ---------------------------------
        ui.add_space(12.0);
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
                match style::renderable_icon(ui, space.icon.clone(), 12.0) {
                    Some(icon) => {
                        ui.label(RichText::new(icon).size(12.0));
                    }
                    None => {
                        // Accent mark in place of an unrenderable emoji icon.
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
                        ui.painter().rect_filled(
                            Rect::from_center_size(r.center(), Vec2::splat(8.0)),
                            CornerRadius::from(2.5),
                            ch.accent,
                        );
                    }
                }
                let name = ui.label(
                    RichText::new(&space.name).color(ch.text).size(13.0).strong(),
                );
                if name.interact(Sense::click()).double_clicked() {
                    state.renaming_space = Some((space.id.clone(), space.name.clone()));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add_space(12.0);
                    let tag = if space.is_default { "DEFAULT" } else { "SPACE" };
                    ui.label(RichText::new(tag).color(ch.muted).size(9.5).strong());
                });
            }
        });
        ui.add_space(8.0);

        // --- new-tab row (`.sb-newtab-row`) ------------------------------
        ui.horizontal(|ui| {
            ui.add_space(8.0);
            let gap = 4.0;
            let icon_w = 28.0;
            let main_w = (ui.available_width() - 8.0 - gap - icon_w).max(60.0);
            let new_chat = egui::Button::new(
                RichText::new("✳  New chat").color(ch.text_2).size(12.5),
            )
            .fill(ch.fill())
            .stroke(Stroke::NONE)
            .corner_radius(CornerRadius::from(6.0))
            .min_size(Vec2::new(main_w, 28.0));
            if ui.add(new_chat).on_hover_text("New Claude tab (⌘T)").clicked() {
                action = Some(Action::NewTab(TabKind::Claude));
            }
            let new_shell = egui::Button::new(
                RichText::new("❯").color(ch.green).size(12.0),
            )
            .fill(ch.fill())
            .stroke(Stroke::NONE)
            .corner_radius(CornerRadius::from(6.0))
            .min_size(Vec2::new(icon_w, 28.0));
            if ui.add(new_shell).on_hover_text("New shell tab (⇧⌘T)").clicked() {
                action = Some(Action::NewTab(TabKind::Shell));
            }
        });
        ui.add_space(6.0);

        // --- tab rows (`.sb-tab`) ----------------------------------------
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
                                ui.add_space(8.0);
                                let edit = ui.text_edit_singleline(&mut buf);
                                edit.request_focus();
                                let commit = edit.lost_focus()
                                    && ui.input(|i| i.key_pressed(egui::Key::Enter));
                                if commit && !buf.trim().is_empty() {
                                    action =
                                        Some(Action::RenameTab(id.clone(), buf.trim().to_string()));
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
                    let (rect, resp) =
                        ui.allocate_exact_size(Vec2::new(row_w, 29.0), Sense::click());
                    let painter = ui.painter();
                    let row_rect = Rect::from_min_size(
                        rect.min + Vec2::new(8.0, 0.5),
                        Vec2::new(row_w - 16.0, 28.0),
                    );
                    if selected {
                        painter.rect_filled(row_rect, CornerRadius::from(6.0), ch.accent_soft());
                    } else if resp.hovered() {
                        painter.rect_filled(row_rect, CornerRadius::from(6.0), ch.fill_h());
                    }

                    // Icon: shell prompt, or the Claude spark when claude runs.
                    let proc = info.and_then(|i| i.proc.as_deref());
                    let is_claude = proc
                        .map(|p| p.contains("claude"))
                        .unwrap_or(tab.kind == TabKind::Claude);
                    let dead = info.map(|i| i.dead).unwrap_or(false);
                    let (icon, icon_color) = if dead {
                        ("○", ch.muted)
                    } else if is_claude {
                        ("✳", ch.accent)
                    } else {
                        ("❯", ch.green)
                    };
                    painter.text(
                        Rect::from_min_size(row_rect.min, Vec2::new(26.0, 28.0)).center(),
                        Align2::CENTER_CENTER,
                        icon,
                        FontId::proportional(11.5),
                        icon_color,
                    );

                    let title_color = if dead {
                        ch.muted
                    } else if selected {
                        Color32::from_rgb(0xee, 0xf1, 0xf6)
                    } else {
                        ch.text_2
                    };
                    let font = FontId::proportional(12.5);
                    let text_w = row_rect.width() - 26.0 - 26.0;
                    let title = truncate_to_width(ui, &tab.title, &font, text_w);
                    painter.text(
                        Pos2::new(row_rect.min.x + 26.0, row_rect.center().y),
                        Align2::LEFT_CENTER,
                        title,
                        font,
                        title_color,
                    );

                    // Pin dot, hidden while hovering (the × takes its place).
                    if tab.pinned && !resp.hovered() {
                        painter.circle_filled(
                            Pos2::new(row_rect.max.x - 14.0, row_rect.center().y),
                            2.5,
                            ch.accent,
                        );
                    }

                    if resp.hovered() {
                        let x_rect = Rect::from_center_size(
                            Pos2::new(row_rect.max.x - 14.0, row_rect.center().y),
                            Vec2::splat(20.0),
                        );
                        let x_resp = ui.interact(x_rect, resp.id.with("close"), Sense::click());
                        if x_resp.hovered() {
                            ui.painter().rect_filled(
                                x_rect,
                                CornerRadius::from(5.0),
                                ch.fill_a(),
                            );
                        }
                        let x_color = if x_resp.hovered() { ch.text } else { ch.muted };
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
                if tabs.is_empty() {
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        ui.add_space(14.0);
                        ui.label(
                            RichText::new("No tabs yet — ⌘T starts a chat.")
                                .color(ch.muted)
                                .size(12.0),
                        );
                    });
                }
            });

        // --- prompt navigator (`.prompt-row`) -----------------------------
        if show_prompts {
            let prompts = prompts.unwrap_or(&[]);
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                ui.add_space(14.0);
                style::section_label(ui, &format!("Prompts · {}", prompts.len()), ch.text_3);
            });
            ui.add_space(2.0);
            egui::ScrollArea::vertical()
                .id_salt("prompt-rows")
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    for prompt in prompts.iter().rev() {
                        let row_w = ui.available_width();
                        let (rect, resp) =
                            ui.allocate_exact_size(Vec2::new(row_w, 25.0), Sense::click());
                        let row_rect = Rect::from_min_size(
                            rect.min + Vec2::new(8.0, 0.5),
                            Vec2::new(row_w - 16.0, 24.0),
                        );
                        if resp.hovered() {
                            ui.painter().rect_filled(
                                row_rect,
                                CornerRadius::from(5.0),
                                ch.fill_h(),
                            );
                        }
                        let mark_color = if resp.hovered() { ch.accent } else { ch.muted };
                        ui.painter().text(
                            Pos2::new(row_rect.min.x + 8.0, row_rect.center().y),
                            Align2::LEFT_CENTER,
                            "›",
                            FontId::proportional(12.0),
                            mark_color,
                        );
                        let font = FontId::proportional(12.0);
                        let text =
                            truncate_to_width(ui, &prompt.text, &font, row_rect.width() - 30.0);
                        ui.painter().text(
                            Pos2::new(row_rect.min.x + 20.0, row_rect.center().y),
                            Align2::LEFT_CENTER,
                            text,
                            font,
                            ch.text_3,
                        );
                        if resp.clicked() {
                            ui.ctx().copy_text(prompt.text.clone());
                        }
                        resp.on_hover_text(format!("{}\n\n(click to copy)", prompt.text));
                    }
                });
        }
    });

    // --- footer: Space chips (`.sb-foot`) ---------------------------------
    style::hairline(ui, theme);
    ui.allocate_ui(Vec2::new(ui.available_width(), footer_h), |ui| {
        ui.set_min_height(footer_h);
        ui.horizontal_centered(|ui| {
            ui.add_space(10.0);
            for s in spaces {
                let selected = s.id == space.id;
                let label = style::renderable_icon(ui, s.icon.clone(), 12.0)
                    .unwrap_or_else(|| {
                        s.name
                            .chars()
                            .next()
                            .map(|c| c.to_uppercase().to_string())
                            .unwrap_or_else(|| "·".to_string())
                    });
                let (rect, resp) = ui.allocate_exact_size(Vec2::splat(26.0), Sense::click());
                let fill = if selected {
                    ch.accent_fill_h()
                } else if resp.hovered() {
                    Color32::from_rgba_unmultiplied(255, 255, 255, 20)
                } else {
                    Color32::TRANSPARENT
                };
                ui.painter().rect_filled(rect, CornerRadius::from(6.0), fill);
                if selected {
                    ui.painter().rect_stroke(
                        rect,
                        CornerRadius::from(6.0),
                        Stroke::new(1.0_f32, ch.accent_line()),
                        StrokeKind::Inside,
                    );
                }
                let color = if selected || resp.hovered() { ch.text } else { ch.text_3 };
                ui.painter().text(
                    rect.center(),
                    Align2::CENTER_CENTER,
                    &label,
                    FontId::proportional(12.0),
                    color,
                );
                if s.is_default {
                    ui.painter().text(
                        rect.right_top() + Vec2::new(1.0, 2.0),
                        Align2::RIGHT_TOP,
                        "★",
                        FontId::proportional(7.0),
                        ch.amber,
                    );
                }
                if resp.clicked() {
                    action = Some(Action::SelectSpace(s.id.clone()));
                }
                resp.clone().on_hover_text(&s.name);
                resp.context_menu(|ui| {
                    if !s.is_default && ui.button("Make default").clicked() {
                        action = Some(Action::SetDefaultSpace(s.id.clone()));
                        ui.close();
                    }
                    if selected && ui.button("Rename").clicked() {
                        state.renaming_space = Some((s.id.clone(), s.name.clone()));
                        ui.close();
                    }
                    if spaces.len() > 1 && ui.button("Delete Space").clicked() {
                        action = Some(Action::DeleteSpace(s.id.clone()));
                        ui.close();
                    }
                });
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(8.0);
                if style::icon_button(ui, "+", 15.0, false, theme)
                    .on_hover_text("New Space")
                    .clicked()
                {
                    action = Some(Action::NewSpace);
                }
            });
        });
    });

    action
}
