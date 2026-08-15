//! The design system, ported from `src/renderer/src/app.css` ("standard
//! terminal" look): egui visuals mapped to the theme's surface tiers, the
//! system UI font (SF Pro on macOS), and the small custom widgets the CSS
//! expresses natively (toggle switches, icon buttons, pill buttons).

use std::path::PathBuf;
use std::sync::Arc;

use egui::{
    Align2, Color32, Context, CornerRadius, FontId, Rect, Response, RichText, Sense, Shadow,
    Stroke, TextStyle, Ui, Vec2,
};

use crate::theme::AppTheme;

/// Match app.css: body 13px, controls 12.5px, small print 11px.
pub fn apply(ctx: &Context, t: &AppTheme) {
    let ch = &t.chrome;
    let mut style = (*ctx.style()).clone();

    style.text_styles = [
        (TextStyle::Heading, FontId::proportional(15.0)),
        (TextStyle::Body, FontId::proportional(13.0)),
        (TextStyle::Button, FontId::proportional(12.5)),
        (TextStyle::Small, FontId::proportional(11.0)),
        (TextStyle::Monospace, FontId::monospace(12.0)),
    ]
    .into();

    style.spacing.item_spacing = Vec2::new(8.0, 6.0);
    style.spacing.button_padding = Vec2::new(10.0, 5.0);
    style.spacing.menu_margin = egui::Margin::same(6);
    style.spacing.window_margin = egui::Margin::same(18);
    style.spacing.interact_size = Vec2::new(40.0, 24.0);
    style.spacing.scroll.bar_width = 8.0;
    style.spacing.scroll.floating = true;

    let v = &mut style.visuals;
    *v = egui::Visuals::dark();
    v.override_text_color = None;
    v.panel_fill = ch.chrome;
    v.window_fill = ch.chrome;
    v.window_stroke = Stroke::new(1.0_f32, ch.line_2());
    v.window_corner_radius = CornerRadius::from(14.0);
    v.window_shadow = Shadow {
        offset: [0, 12],
        blur: 36,
        spread: 0,
        color: Color32::from_black_alpha(150),
    };
    v.popup_shadow = Shadow {
        offset: [0, 8],
        blur: 24,
        spread: 0,
        color: Color32::from_black_alpha(130),
    };
    v.menu_corner_radius = CornerRadius::from(10.0);
    v.extreme_bg_color = ch.input_bg();
    v.faint_bg_color = ch.fill();
    v.hyperlink_color = ch.accent;
    v.slider_trailing_fill = true;

    v.selection.bg_fill = ch.accent_soft();
    v.selection.stroke = Stroke::new(1.0_f32, ch.accent);
    v.text_cursor.stroke = Stroke::new(2.0_f32, ch.accent);

    let radius = CornerRadius::from(6.0);
    let w = &mut v.widgets;
    w.noninteractive.bg_fill = Color32::TRANSPARENT;
    w.noninteractive.weak_bg_fill = Color32::TRANSPARENT;
    w.noninteractive.bg_stroke = Stroke::new(1.0_f32, ch.hairline());
    w.noninteractive.fg_stroke = Stroke::new(1.0_f32, ch.text_2);
    w.noninteractive.corner_radius = radius;

    w.inactive.bg_fill = ch.fill();
    w.inactive.weak_bg_fill = ch.fill();
    w.inactive.bg_stroke = Stroke::NONE;
    w.inactive.fg_stroke = Stroke::new(1.0_f32, ch.text_2);
    w.inactive.corner_radius = radius;

    w.hovered.bg_fill = ch.fill_a();
    w.hovered.weak_bg_fill = ch.fill_a();
    w.hovered.bg_stroke = Stroke::NONE;
    w.hovered.fg_stroke = Stroke::new(1.0_f32, ch.text);
    w.hovered.corner_radius = radius;

    w.active.bg_fill = ch.accent_soft();
    w.active.weak_bg_fill = ch.accent_soft();
    w.active.bg_stroke = Stroke::NONE;
    w.active.fg_stroke = Stroke::new(1.0_f32, ch.text);
    w.active.corner_radius = radius;

    w.open.bg_fill = ch.fill_a();
    w.open.weak_bg_fill = ch.fill_a();
    w.open.bg_stroke = Stroke::NONE;
    w.open.fg_stroke = Stroke::new(1.0_f32, ch.text);
    w.open.corner_radius = radius;

    ctx.set_style(style);
}

// --- fonts -------------------------------------------------------------------

/// System UI faces, best first. SFNS is a variable font; its default instance
/// is the Regular weight, which is exactly what we want.
fn ui_font_candidates() -> Vec<(PathBuf, u32)> {
    let mut c: Vec<(PathBuf, u32)> = Vec::new();
    if cfg!(target_os = "macos") {
        c.push((PathBuf::from("/System/Library/Fonts/SFNS.ttf"), 0));
        c.push((PathBuf::from("/System/Library/Fonts/SFNSDisplay.ttf"), 0));
        c.push((PathBuf::from("/System/Library/Fonts/HelveticaNeue.ttc"), 0));
    } else if cfg!(target_os = "windows") {
        c.push((PathBuf::from("C:\\Windows\\Fonts\\segoeui.ttf"), 0));
    } else {
        for p in [
            "/usr/share/fonts/truetype/inter/Inter-Regular.ttf",
            "/usr/share/fonts/inter/Inter-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ] {
            c.push((PathBuf::from(p), 0));
        }
    }
    c
}

/// A face egui would choke on must never reach `set_fonts` (that panics at
/// first layout), so parse-check with the same ttf-parser egui embeds.
fn load_valid_font(path: &std::path::Path, index: u32) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    let face = ttf_parser::Face::parse(&bytes, index).ok()?;
    face.glyph_index('a')?;
    Some(bytes)
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
    best.and_then(|(_, path)| load_valid_font(&path, 0))
}

pub fn install_fonts(ctx: &Context) {
    let mut defs = egui::FontDefinitions::default();

    // Chrome text: the platform UI font, exactly like the Electron app's
    // `-apple-system` stack.
    for (path, index) in ui_font_candidates() {
        if let Some(bytes) = load_valid_font(&path, index) {
            let mut data = egui::FontData::from_owned(bytes);
            data.index = index;
            defs.font_data.insert("ui-sans".to_string(), Arc::new(data));
            if let Some(family) = defs.families.get_mut(&egui::FontFamily::Proportional) {
                family.insert(0, "ui-sans".to_string());
            }
            break;
        }
    }

    if let Some(bytes) = find_nerd_font() {
        defs.font_data
            .insert("nerd".to_string(), Arc::new(egui::FontData::from_owned(bytes)));
        if let Some(family) = defs.families.get_mut(&egui::FontFamily::Monospace) {
            family.insert(0, "nerd".to_string());
        }
        // Fallback for the glyph icons the chrome uses (❯ ✳ ○ ★ …).
        if let Some(family) = defs.families.get_mut(&egui::FontFamily::Proportional) {
            family.push("nerd".to_string());
        }
    }
    ctx.set_fonts(defs);
}

// --- widgets -----------------------------------------------------------------

/// 26px hover-highlight icon button (`.icon-btn`).
pub fn icon_button(ui: &mut Ui, glyph: &str, size: f32, on: bool, t: &AppTheme) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(26.0), Sense::click());
    let fill = if on {
        t.chrome.fill_a()
    } else if resp.hovered() {
        Color32::from_rgba_unmultiplied(255, 255, 255, 20)
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, CornerRadius::from(6.0), fill);
    let color = if on || resp.hovered() { t.chrome.text } else { t.chrome.text_3 };
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        glyph,
        FontId::proportional(size),
        color,
    );
    resp
}

/// Titlebar sidebar toggle, drawn with primitives (no font dependency).
pub fn sidebar_toggle_button(ui: &mut Ui, on: bool, t: &AppTheme) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(26.0), Sense::click());
    let fill = if on {
        t.chrome.fill_a()
    } else if resp.hovered() {
        Color32::from_rgba_unmultiplied(255, 255, 255, 20)
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, CornerRadius::from(6.0), fill);
    let color = if on || resp.hovered() { t.chrome.text } else { t.chrome.text_3 };
    let icon = Rect::from_center_size(rect.center(), Vec2::new(14.0, 11.0));
    ui.painter().rect_stroke(
        icon,
        CornerRadius::from(3.0),
        Stroke::new(1.2_f32, color),
        egui::StrokeKind::Inside,
    );
    ui.painter().vline(
        icon.min.x + 5.0,
        egui::Rangef::new(icon.min.y + 1.0, icon.max.y - 1.0),
        Stroke::new(1.2_f32, color),
    );
    resp
}

/// The icon string only if the loaded fonts can actually shape it (Space
/// icons are arbitrary emoji; egui's mono emoji set misses many).
pub fn renderable_icon(ui: &Ui, icon: Option<String>, size: f32) -> Option<String> {
    let icon = icon.filter(|i| !i.trim().is_empty())?;
    let font = FontId::proportional(size);
    let ok = ui.fonts(|f| icon.chars().all(|c| f.has_glyph(&font, c)));
    ok.then_some(icon)
}

/// iOS-style toggle (`.toggle` rows use native checkboxes in CSS-land; the
/// desktop equivalent is a switch).
pub fn toggle(ui: &mut Ui, on: &mut bool, t: &AppTheme) -> Response {
    let size = Vec2::new(34.0, 20.0);
    let (rect, mut resp) = ui.allocate_exact_size(size, Sense::click());
    if resp.clicked() {
        *on = !*on;
        resp.mark_changed();
    }
    let how_on = ui.ctx().animate_bool_with_time(resp.id, *on, 0.12);
    let bg = crate::theme::mix(t.chrome.fill_a(), t.chrome.accent, how_on);
    ui.painter().rect_filled(rect, CornerRadius::from(10.0), bg);
    let knob_x = rect.min.x + 10.0 + how_on * (size.x - 20.0);
    ui.painter().circle_filled(
        egui::Pos2::new(knob_x, rect.center().y),
        7.0,
        Color32::from_rgb(245, 246, 250),
    );
    resp
}

/// Bordered pill (`.term-restart`, `.panes-empty-btn`). `accent` picks the
/// primary variant.
pub fn pill_button(ui: &mut Ui, text: &str, accent: bool, t: &AppTheme) -> Response {
    let ch = &t.chrome;
    let (fill, border, color) = if accent {
        (ch.accent_fill(), ch.accent_line(), ch.accent_bright())
    } else {
        (ch.fill(), ch.line_2(), ch.text_2)
    };
    let btn = egui::Button::new(RichText::new(text).color(color).size(12.5))
        .fill(fill)
        .stroke(Stroke::new(1.0_f32, border))
        .corner_radius(CornerRadius::from(8.0))
        .min_size(Vec2::new(0.0, 30.0));
    ui.add(btn)
}

/// Uppercase micro-header (`.section-head`, `.modal-group`).
pub fn section_label(ui: &mut Ui, text: &str, color: Color32) {
    ui.label(RichText::new(text.to_uppercase()).size(10.5).strong().color(color));
}

/// 1px in-panel divider (`--hairline`).
pub fn hairline(ui: &mut Ui, t: &AppTheme) {
    let w = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(Vec2::new(w, 1.0), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::ZERO, t.chrome.hairline());
}

/// Vertical gradient fill (the titlebar; egui has no gradient primitive).
pub fn gradient_rect(ui: &Ui, rect: Rect, top: Color32, bottom: Color32) {
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(rect.left_top(), top);
    mesh.colored_vertex(rect.right_top(), top);
    mesh.colored_vertex(rect.right_bottom(), bottom);
    mesh.colored_vertex(rect.left_bottom(), bottom);
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(0, 2, 3);
    ui.painter().add(mesh);
}
