//! Memory sidebar (⌘M): the active Space's memories plus global rows, with
//! search, pin, forget, and the one-way Electron importer.

use egui::{
    Align2, CornerRadius, FontId, Rect, RichText, Sense, TextEdit, Ui, Vec2,
};

use crate::db::MemoryRow;
use crate::theme::AppTheme;

pub enum MemoryAction {
    SetPinned(String, bool),
    Forget(String),
    Import,
    ClearReport,
}

fn type_badge(mtype: &str, theme: &AppTheme) -> (&'static str, egui::Color32) {
    match mtype {
        "decision" => ("D", theme.chrome.green),
        "preference" => ("P", theme.chrome.amber),
        "entity" => ("E", theme.chrome.text_2),
        "todo" => ("T", theme.chrome.red),
        _ => ("F", theme.chrome.accent), // fact
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

    ui.add_space(10.0);
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        ui.label(
            RichText::new(format!("Memory · {}", rows.len()))
                .color(theme.chrome.text)
                .size(14.0)
                .strong(),
        );
    });
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.add(
            TextEdit::singleline(filter)
                .hint_text("Search memory…")
                .desired_width(ui.available_width() - 10.0),
        );
    });
    ui.add_space(8.0);

    let needle = filter.trim().to_lowercase();
    let visible: Vec<&MemoryRow> = rows
        .iter()
        .filter(|m| needle.is_empty() || m.content.to_lowercase().contains(&needle))
        .collect();

    if rows.is_empty() {
        ui.add_space(12.0);
        ui.vertical_centered(|ui| {
            ui.label(
                RichText::new("Nothing learned yet")
                    .color(theme.chrome.muted)
                    .size(12.0),
            );
        });
    }

    egui::ScrollArea::vertical()
        .id_salt("memory-rows")
        .auto_shrink([false, false])
        .max_height(ui.available_height() - if electron_available || report.is_some() { 64.0 } else { 8.0 })
        .show(ui, |ui| {
            for mem in visible {
                let row_w = ui.available_width();
                let (rect, resp) = ui.allocate_exact_size(Vec2::new(row_w, 28.0), Sense::click());
                let row_rect = Rect::from_min_size(
                    rect.min + Vec2::new(6.0, 1.0),
                    Vec2::new(row_w - 12.0, 26.0),
                );
                if resp.hovered() {
                    ui.painter().rect_filled(
                        row_rect,
                        CornerRadius::from(6.0),
                        theme.chrome.titlebar_2,
                    );
                }
                let (badge, badge_color) = type_badge(&mem.mtype, theme);
                ui.painter().text(
                    Rect::from_min_size(row_rect.min, Vec2::new(24.0, 26.0)).center(),
                    Align2::CENTER_CENTER,
                    badge,
                    FontId::proportional(10.5),
                    badge_color,
                );
                if mem.pinned {
                    ui.painter().circle_filled(
                        egui::Pos2::new(row_rect.max.x - 10.0, row_rect.center().y),
                        2.5,
                        theme.chrome.accent,
                    );
                }
                let max_chars = ((row_rect.width() - 44.0) / 6.2).max(4.0) as usize;
                let mut text: String = mem.content.chars().take(max_chars).collect();
                if text.chars().count() < mem.content.chars().count() {
                    text.push('…');
                }
                ui.painter().text(
                    Rect::from_min_size(row_rect.min + Vec2::new(24.0, 0.0), Vec2::new(0.0, 26.0))
                        .center(),
                    Align2::LEFT_CENTER,
                    text,
                    FontId::proportional(11.5),
                    theme.chrome.text_2,
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

    if let Some(report) = report {
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.add_space(10.0);
            let r = ui.label(
                RichText::new(report).color(theme.chrome.green).size(10.5),
            );
            if r.interact(Sense::click()).clicked() {
                action = Some(MemoryAction::ClearReport);
            }
        });
    } else if electron_available {
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.add_space(10.0);
            let btn = egui::Button::new(
                RichText::new("Import from Zede (Electron)")
                    .color(theme.chrome.text_2)
                    .size(11.0),
            )
            .fill(theme.chrome.titlebar_2)
            .corner_radius(CornerRadius::from(6.0));
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
