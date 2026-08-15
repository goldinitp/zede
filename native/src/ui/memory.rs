//! Claude Context panel (⌘M — `.memory` in app.css): the active Space's
//! memories with search, pin, forget, and the one-way Electron importer.

use egui::{
    Align2, Color32, CornerRadius, FontId, Pos2, Rect, RichText, Sense, Stroke, TextEdit, Ui, Vec2,
};

use crate::db::MemoryRow;
use crate::theme::AppTheme;
use crate::ui::style;

pub enum MemoryAction {
    SetPinned(String, bool),
    Forget(String),
    Import,
    ClearReport,
}

/// `.ctx-dot` colors, keyed by memory type (the native panel's scopes).
fn type_dot(mtype: &str, theme: &AppTheme) -> Color32 {
    let ch = &theme.chrome;
    match mtype {
        "decision" => ch.magenta(),
        "preference" => ch.amber,
        "entity" => ch.green,
        "todo" => ch.red,
        _ => ch.accent, // fact
    }
}

pub fn memory_panel(
    ui: &mut Ui,
    rows: &[MemoryRow],
    filter: &mut String,
    electron_available: bool,
    report: Option<&str>,
    theme: &AppTheme,
) -> Option<MemoryAction> {
    let mut action = None;
    let ch = &theme.chrome;
    let panel = ui.max_rect();

    // Pane separator on the left edge.
    ui.painter().vline(
        panel.left() + 0.5,
        panel.y_range(),
        Stroke::new(1.0_f32, ch.sep()),
    );

    // --- head (`.memory-head`) --------------------------------------------
    ui.add_space(12.0);
    ui.horizontal(|ui| {
        ui.add_space(14.0);
        style::section_label(ui, "Claude Context", ch.text_3);
        ui.label(RichText::new(format!("{}", rows.len())).color(ch.muted).size(11.0));
    });
    ui.add_space(6.0);

    // --- search (`.memory-search`) ----------------------------------------
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        ui.add(
            TextEdit::singleline(filter)
                .hint_text("Search memory…")
                .desired_width(ui.available_width() - 12.0),
        );
    });
    ui.add_space(6.0);

    if rows.is_empty() {
        ui.add_space(10.0);
        ui.horizontal(|ui| {
            ui.add_space(14.0);
            ui.label(
                RichText::new(if filter.trim().is_empty() {
                    "Nothing learned yet — memories appear as you chat."
                } else {
                    "No matches."
                })
                .color(ch.muted)
                .size(12.0),
            );
        });
    }

    let footer_h = if electron_available || report.is_some() { 46.0 } else { 10.0 };

    // --- rows (`.ctx-row`) -------------------------------------------------
    egui::ScrollArea::vertical()
        .id_salt("memory-rows")
        .auto_shrink([false, false])
        .max_height((ui.available_height() - footer_h).max(40.0))
        .show(ui, |ui| {
            for mem in rows {
                let row_w = ui.available_width();
                let (rect, resp) = ui.allocate_exact_size(Vec2::new(row_w, 27.0), Sense::click());
                let row_rect = Rect::from_min_size(
                    rect.min + Vec2::new(8.0, 0.5),
                    Vec2::new(row_w - 16.0, 26.0),
                );
                if resp.hovered() {
                    ui.painter()
                        .rect_filled(row_rect, CornerRadius::from(5.0), ch.fill_h());
                }

                ui.painter().circle_filled(
                    Pos2::new(row_rect.min.x + 10.0, row_rect.center().y),
                    2.5,
                    type_dot(&mem.mtype, theme),
                );

                // Right side: pinned star + hover actions (pin / forget).
                let mut right_edge = row_rect.max.x - 8.0;
                if resp.hovered() {
                    for (glyph, act, on) in [
                        ("×", "forget", false),
                        (if mem.pinned { "★" } else { "☆" }, "pin", mem.pinned),
                    ] {
                        let a_rect = Rect::from_center_size(
                            Pos2::new(right_edge - 8.0, row_rect.center().y),
                            Vec2::splat(18.0),
                        );
                        let a_resp = ui.interact(a_rect, resp.id.with(act), Sense::click());
                        if a_resp.hovered() {
                            ui.painter().rect_filled(
                                a_rect,
                                CornerRadius::from(4.0),
                                ch.fill_a(),
                            );
                        }
                        let color = if on {
                            ch.amber
                        } else if a_resp.hovered() {
                            ch.text
                        } else {
                            ch.muted
                        };
                        ui.painter().text(
                            a_rect.center(),
                            Align2::CENTER_CENTER,
                            glyph,
                            FontId::proportional(11.5),
                            color,
                        );
                        if a_resp.clicked() {
                            action = Some(match act {
                                "pin" => MemoryAction::SetPinned(mem.id.clone(), !mem.pinned),
                                _ => MemoryAction::Forget(mem.id.clone()),
                            });
                        }
                        right_edge -= 20.0;
                    }
                } else {
                    if mem.pinned {
                        ui.painter().text(
                            Pos2::new(right_edge - 4.0, row_rect.center().y),
                            Align2::RIGHT_CENTER,
                            "★",
                            FontId::proportional(9.0),
                            ch.amber,
                        );
                        right_edge -= 14.0;
                    }
                    let tag = mem.mtype.chars().next().unwrap_or('f').to_uppercase().to_string();
                    ui.painter().text(
                        Pos2::new(right_edge - 2.0, row_rect.center().y),
                        Align2::RIGHT_CENTER,
                        tag,
                        FontId::monospace(9.0),
                        ch.muted,
                    );
                    right_edge -= 16.0;
                }

                let font = FontId::proportional(12.0);
                let text_w = right_edge - (row_rect.min.x + 20.0) - 4.0;
                let text = {
                    let mut s = mem.content.replace('\n', " ");
                    s.truncate(s.len().min(400));
                    s
                };
                let galley = ui.fonts(|f| {
                    f.layout_no_wrap(text.clone(), font.clone(), Color32::WHITE)
                });
                let text = if galley.rect.width() <= text_w {
                    text
                } else {
                    let mut t = text;
                    while !t.is_empty() {
                        t.pop();
                        let w = ui.fonts(|f| {
                            f.layout_no_wrap(format!("{t}…"), font.clone(), Color32::WHITE)
                                .rect
                                .width()
                        });
                        if w <= text_w {
                            break;
                        }
                    }
                    format!("{t}…")
                };
                ui.painter().text(
                    Pos2::new(row_rect.min.x + 20.0, row_rect.center().y),
                    Align2::LEFT_CENTER,
                    text,
                    font,
                    ch.text_2,
                );

                resp.clone().on_hover_text(format!(
                    "{}\n\n{} · {}{}",
                    mem.content,
                    mem.mtype,
                    mem.scope,
                    if mem.pinned { " · pinned" } else { "" }
                ));
                resp.context_menu(|ui| {
                    let pin_label = if mem.pinned { "Unpin" } else { "Pin" };
                    if ui.button(pin_label).clicked() {
                        action = Some(MemoryAction::SetPinned(mem.id.clone(), !mem.pinned));
                        ui.close();
                    }
                    if ui.button("Copy").clicked() {
                        ui.ctx().copy_text(mem.content.clone());
                        ui.close();
                    }
                    if ui.button("Forget").clicked() {
                        action = Some(MemoryAction::Forget(mem.id.clone()));
                        ui.close();
                    }
                });
            }
        });

    // --- footer (`.memory-foot`) -------------------------------------------
    if let Some(report) = report {
        style::hairline(ui, theme);
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.add_space(14.0);
            let r = ui.label(RichText::new(report).color(ch.green).size(10.5));
            if r.interact(Sense::click()).on_hover_text("Dismiss").clicked() {
                action = Some(MemoryAction::ClearReport);
            }
        });
    } else if electron_available {
        style::hairline(ui, theme);
        ui.add_space(7.0);
        ui.horizontal(|ui| {
            ui.add_space(12.0);
            let btn = egui::Button::new(
                RichText::new("⇣  Import from Zede (Electron)")
                    .color(ch.text_2)
                    .size(11.5),
            )
            .fill(ch.fill())
            .stroke(Stroke::NONE)
            .corner_radius(CornerRadius::from(6.0))
            .min_size(Vec2::new(ui.available_width() - 12.0, 26.0));
            if ui
                .add(btn)
                .on_hover_text("One-way copy of Spaces, memories and tombstones.\nThe Electron database is opened read-only and never modified.")
                .clicked()
            {
                action = Some(MemoryAction::Import);
            }
        });
    }

    action
}
