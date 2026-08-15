//! The terminal pane: paints the alacritty grid with egui's GPU painter and
//! feeds keyboard/mouse input back to the PTY. The grid lock is held only to
//! snapshot cell data; painting happens after it is released.

use std::time::Duration;

use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, CursorShape, NamedColor};
use egui::{
    Align2, Color32, CornerRadius, Event, EventFilter, FontId, ImeEvent, Pos2, Rect, Response,
    Sense, Stroke, StrokeKind, Ui, Vec2,
};

use crate::settings::Settings;
use crate::term::{keys, TermSession};
use crate::theme::{self, AppTheme};

const PAD: f32 = 8.0;
const RESIZE_DEBOUNCE_MS: u128 = 150;

struct GlyphDraw {
    pos: Pos2,
    ch: char,
    color: Color32,
}

struct LineDraw {
    from: Pos2,
    to: Pos2,
    color: Color32,
}

struct CursorDraw {
    rect: Rect,
    shape: CursorShape,
    ch: char,
}

pub fn terminal_view(
    ui: &mut Ui,
    session: &mut TermSession,
    theme: &'static AppTheme,
    settings: &Settings,
    request_focus: bool,
) -> Response {
    let font_id = FontId::monospace(settings.font_size);
    let (glyph_w, row_h) = ui.fonts(|f| (f.glyph_width(&font_id, 'M'), f.row_height(&font_id)));
    let cell_w = (glyph_w + settings.letter_spacing).max(1.0);
    let cell_h = (row_h * settings.line_height).max(1.0);

    let (rect, response) = ui.allocate_exact_size(ui.available_size(), Sense::click_and_drag());
    let content = rect.shrink(PAD);
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, CornerRadius::ZERO, theme.term.background);

    // --- grid sizing (debounced; a drag resize applies once, at the end) ----
    let cols = ((content.width() / cell_w).floor() as u16).max(2);
    let rows = ((content.height() / cell_h).floor() as u16).max(2);
    let desired = (cols, rows, cell_w.round() as u16, cell_h.round() as u16);
    if (cols, rows) != (session.cols, session.rows) {
        if !session.has_initial_resize {
            session.resize(desired.0, desired.1, desired.2, desired.3);
        } else {
            match session.debounce {
                Some((d, at)) if d == desired => {
                    if at.elapsed().as_millis() >= RESIZE_DEBOUNCE_MS {
                        session.resize(desired.0, desired.1, desired.2, desired.3);
                        session.debounce = None;
                    } else {
                        ui.ctx().request_repaint_after(Duration::from_millis(60));
                    }
                }
                _ => {
                    session.debounce = Some((desired, std::time::Instant::now()));
                    ui.ctx().request_repaint_after(Duration::from_millis(60));
                }
            }
        }
    } else {
        session.debounce = None;
    }
    session.maybe_flush_pending_resize();

    // --- focus --------------------------------------------------------------
    if response.clicked() || request_focus {
        response.request_focus();
    }
    let focused = response.has_focus();
    if focused {
        ui.memory_mut(|m| {
            m.set_focus_lock_filter(
                response.id,
                EventFilter {
                    tab: true,
                    horizontal_arrows: true,
                    vertical_arrows: true,
                    escape: true,
                },
            )
        });
    }
    let window_focused = ui.input(|i| i.focused);

    let mode = session.mode();

    // --- keyboard / clipboard ----------------------------------------------
    if focused && !session.is_dead() {
        let events = ui.input(|i| i.events.clone());
        let mut out: Vec<u8> = Vec::new();
        let mut typed = false;
        for event in &events {
            match event {
                Event::Text(text) => {
                    out.extend_from_slice(text.as_bytes());
                    typed = true;
                }
                Event::Key { key, pressed: true, modifiers, .. } => {
                    if let Some(bytes) = keys::encode_key(*key, *modifiers, mode) {
                        out.extend_from_slice(&bytes);
                        typed = true;
                    }
                }
                Event::Paste(text) => {
                    out.extend_from_slice(&keys::encode_paste(
                        text,
                        mode.contains(TermMode::BRACKETED_PASTE),
                    ));
                    typed = true;
                }
                Event::Copy => {
                    if let Some(text) = session.term.lock().selection_to_string() {
                        if !text.is_empty() {
                            ui.ctx().copy_text(text);
                        }
                    }
                }
                Event::Ime(ImeEvent::Commit(text)) => {
                    out.extend_from_slice(text.as_bytes());
                    typed = true;
                }
                _ => {}
            }
        }
        if typed {
            session.scroll_to_bottom();
        }
        if !out.is_empty() {
            session.write(&out);
        }
    }

    // --- wheel scrolling ----------------------------------------------------
    if response.hovered() {
        let dy = ui.input(|i| i.raw_scroll_delta.y);
        if dy != 0.0 {
            session.scroll_accum += dy / cell_h;
            let lines = session.scroll_accum.trunc() as i32;
            if lines != 0 {
                session.scroll_accum -= lines as f32;
                let alt = mode.contains(TermMode::ALT_SCREEN);
                let mouse = mode.intersects(TermMode::MOUSE_MODE);
                if alt && !mouse {
                    // Full-screen apps without mouse reporting get arrow keys.
                    let seq: &[u8] = if mode.contains(TermMode::APP_CURSOR) {
                        if lines > 0 { b"\x1bOA" } else { b"\x1bOB" }
                    } else if lines > 0 {
                        b"\x1b[A"
                    } else {
                        b"\x1b[B"
                    };
                    let mut bytes = Vec::new();
                    for _ in 0..lines.unsigned_abs() {
                        bytes.extend_from_slice(seq);
                    }
                    session.write(&bytes);
                } else {
                    session.scroll_display(lines);
                }
            }
        }
    }

    // --- selection ----------------------------------------------------------
    let to_grid = |pos: Pos2, display_offset: usize| -> (Point, Side) {
        let rel_x = ((pos.x - content.min.x) / cell_w).floor();
        let rel_y = ((pos.y - content.min.y) / cell_h).floor();
        let col = (rel_x.max(0.0) as usize).min(cols.saturating_sub(1) as usize);
        let vrow = (rel_y.max(0.0) as usize).min(rows.saturating_sub(1) as usize);
        let line = Line(vrow as i32 - display_offset as i32);
        let frac = ((pos.x - content.min.x) / cell_w) - rel_x;
        let side = if frac < 0.5 { Side::Left } else { Side::Right };
        (Point::new(line, Column(col)), side)
    };

    if let Some(pos) = response.interact_pointer_pos() {
        let start_selection = |session: &TermSession, ty: SelectionType| {
            let mut t = session.term.lock();
            let offset = t.grid().display_offset();
            let (point, side) = to_grid(pos, offset);
            t.selection = Some(Selection::new(ty, point, side));
        };
        if response.triple_clicked() {
            start_selection(session, SelectionType::Lines);
        } else if response.double_clicked() {
            start_selection(session, SelectionType::Semantic);
        } else if response.drag_started() {
            start_selection(session, SelectionType::Simple);
        } else if response.dragged() {
            let mut t = session.term.lock();
            let offset = t.grid().display_offset();
            let (point, side) = to_grid(pos, offset);
            if let Some(sel) = t.selection.as_mut() {
                sel.update(point, side);
            }
        } else if response.clicked() {
            session.term.lock().selection = None;
        }
    }

    // --- snapshot the grid under the lock, then paint -----------------------
    let mut bg_rects: Vec<(Rect, Color32)> = Vec::new();
    let mut sel_rects: Vec<Rect> = Vec::new();
    let mut glyphs: Vec<GlyphDraw> = Vec::new();
    let mut lines_draw: Vec<LineDraw> = Vec::new();
    let mut cursor: Option<CursorDraw> = None;
    let display_offset;
    {
        let term = session.term.lock();
        let info = term.renderable_content();
        display_offset = info.display_offset;
        let selection = info.selection;
        let colors = info.colors;
        let cursor_point = info.cursor.point;
        let mut cursor_shape = info.cursor.shape;
        if !info.mode.contains(TermMode::SHOW_CURSOR) {
            cursor_shape = CursorShape::Hidden;
        }
        let mut cursor_ch = ' ';

        let cell_pos = |vrow: i32, col: usize| -> Pos2 {
            Pos2::new(
                content.min.x + col as f32 * cell_w,
                content.min.y + vrow as f32 * cell_h,
            )
        };

        for indexed in info.display_iter {
            let cell = indexed.cell;
            let flags = cell.flags;
            if flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            let point = indexed.point;
            let vrow = point.line.0 + display_offset as i32;
            if vrow < 0 || vrow >= rows as i32 {
                continue;
            }
            let col = point.column.0;
            let pos = cell_pos(vrow, col);
            let width_cells = if flags.contains(Flags::WIDE_CHAR) { 2.0 } else { 1.0 };
            let cell_rect =
                Rect::from_min_size(pos, Vec2::new(cell_w * width_cells, cell_h));

            let (mut fg_src, mut bg_src) = (cell.fg, cell.bg);
            if flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg_src, &mut bg_src);
            }
            if flags.contains(Flags::BOLD) {
                fg_src = theme::bold_variant(fg_src);
            }
            let mut fg = theme::resolve_ansi(fg_src, colors, theme);
            if flags.contains(Flags::DIM) {
                fg = theme::dim(fg);
            }

            let bg_is_default =
                bg_src == AnsiColor::Named(NamedColor::Background) && !flags.contains(Flags::INVERSE);
            if !bg_is_default {
                let bg = theme::resolve_ansi(bg_src, colors, theme);
                if bg != theme.term.background {
                    bg_rects.push((cell_rect, bg));
                }
            }
            if selection.map_or(false, |range| range.contains(point)) {
                sel_rects.push(cell_rect);
            }

            let ch = cell.c;
            if point == cursor_point {
                cursor_ch = ch;
            }
            if ch != ' ' && ch != '\t' && !flags.contains(Flags::HIDDEN) {
                glyphs.push(GlyphDraw { pos, ch, color: fg });
            }
            if flags.intersects(Flags::ALL_UNDERLINES) {
                let y = pos.y + cell_h - 1.5;
                lines_draw.push(LineDraw {
                    from: Pos2::new(pos.x, y),
                    to: Pos2::new(pos.x + cell_w * width_cells, y),
                    color: fg,
                });
            }
            if flags.contains(Flags::STRIKEOUT) {
                let y = pos.y + cell_h * 0.55;
                lines_draw.push(LineDraw {
                    from: Pos2::new(pos.x, y),
                    to: Pos2::new(pos.x + cell_w * width_cells, y),
                    color: fg,
                });
            }
        }

        // Cursor (drawn last; hollow when the window is unfocused).
        let cursor_vrow = cursor_point.line.0 + display_offset as i32;
        if cursor_shape != CursorShape::Hidden && cursor_vrow >= 0 && cursor_vrow < rows as i32 {
            let pos = cell_pos(cursor_vrow, cursor_point.column.0);
            let shape = if window_focused { cursor_shape } else { CursorShape::HollowBlock };
            cursor = Some(CursorDraw {
                rect: Rect::from_min_size(pos, Vec2::new(cell_w, cell_h)),
                shape,
                ch: cursor_ch,
            });
        }
    }

    for (r, color) in bg_rects {
        painter.rect_filled(r, CornerRadius::ZERO, color);
    }
    for r in sel_rects {
        painter.rect_filled(r, CornerRadius::ZERO, theme.term.selection);
    }
    for g in glyphs {
        painter.text(g.pos, Align2::LEFT_TOP, g.ch, font_id.clone(), g.color);
    }
    for l in lines_draw {
        painter.line_segment([l.from, l.to], Stroke::new(1.0_f32, l.color));
    }

    if let Some(c) = cursor {
        let blink_visible = if settings.cursor_blink && window_focused && focused {
            let t = ui.input(|i| i.time);
            ui.ctx().request_repaint_after(Duration::from_millis(265));
            ((t * 1000.0) as u64 / 530) % 2 == 0
        } else {
            true
        };
        if blink_visible {
            match c.shape {
                CursorShape::Block => {
                    painter.rect_filled(c.rect, CornerRadius::ZERO, theme.term.cursor);
                    if c.ch != ' ' {
                        painter.text(
                            c.rect.min,
                            Align2::LEFT_TOP,
                            c.ch,
                            font_id.clone(),
                            theme.term.background,
                        );
                    }
                }
                CursorShape::HollowBlock => {
                    painter.rect_stroke(
                        c.rect.shrink(0.5),
                        CornerRadius::ZERO,
                        Stroke::new(1.0_f32, theme.term.cursor),
                        StrokeKind::Inside,
                    );
                }
                CursorShape::Underline => {
                    let r = Rect::from_min_max(
                        Pos2::new(c.rect.min.x, c.rect.max.y - 2.0),
                        c.rect.max,
                    );
                    painter.rect_filled(r, CornerRadius::ZERO, theme.term.cursor);
                }
                CursorShape::Beam => {
                    let r = Rect::from_min_max(
                        c.rect.min,
                        Pos2::new(c.rect.min.x + 2.0, c.rect.max.y),
                    );
                    painter.rect_filled(r, CornerRadius::ZERO, theme.term.cursor);
                }
                CursorShape::Hidden => {}
            }
        }
    }

    // Scrolled-back indicator.
    if display_offset > 0 {
        let text = format!("{display_offset} lines up");
        let pill_pos = Pos2::new(rect.max.x - 12.0, rect.min.y + 12.0);
        painter.text(
            pill_pos,
            Align2::RIGHT_TOP,
            text,
            FontId::proportional(11.0),
            theme.chrome.text_3,
        );
    }

    response
}
