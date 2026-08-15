//! App + terminal themes, ported from `src/shared/themes.ts`.
//!
//! Each theme supplies the terminal palette (surface) and chrome tiers — the
//! terminal is the darkest surface, sidebar/context chrome one step lighter,
//! titlebar lighter still — plus a text ramp and accents.

use egui::Color32;

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor, Rgb as AnsiRgb};

pub const DEFAULT_THEME_ID: &str = "one-dark";

#[derive(Clone)]
pub struct TermPalette {
    pub background: Color32,
    pub foreground: Color32,
    pub cursor: Color32,
    pub selection: Color32,
    /// ANSI 0-7 normal, 8-15 bright.
    pub ansi: [Color32; 16],
}

#[derive(Clone)]
pub struct Chrome {
    #[allow(dead_code)] // `--editor-header` — reserved for the editor pane
    pub editor_header: Color32,
    pub chrome: Color32,
    pub titlebar_1: Color32,
    pub titlebar_2: Color32,
    pub text: Color32,
    pub text_2: Color32,
    pub text_3: Color32,
    pub muted: Color32,
    pub accent: Color32,
    #[allow(dead_code)] // status badges (P5)
    pub green: Color32,
    #[allow(dead_code)] // status badges (P5)
    pub amber: Color32,
    pub red: Color32,
}

/// Alpha-derived tokens from app.css (`color-mix` / rgba values there). These
/// are computed, not stored, so themes stay a 1:1 port of shared/themes.ts.
impl Chrome {
    /// rgba(255,255,255,.06) — resting control fill + in-panel hairlines.
    pub fn fill(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(255, 255, 255, 15)
    }
    /// rgba(255,255,255,.07) — row hover.
    pub fn fill_h(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(255, 255, 255, 18)
    }
    /// rgba(255,255,255,.10) — pressed / active control fill.
    pub fn fill_a(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(255, 255, 255, 26)
    }
    /// rgba(0,0,0,.28) — text inputs.
    pub fn input_bg(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(0, 0, 0, 71)
    }
    /// rgba(255,255,255,.06) — hairline dividers inside a panel.
    pub fn hairline(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(255, 255, 255, 15)
    }
    /// rgba(0,0,0,.45) — the 1px separators between panes.
    pub fn sep(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(0, 0, 0, 115)
    }
    /// rgba(255,255,255,.10) — control borders.
    pub fn line_2(&self) -> Color32 {
        Color32::from_rgba_unmultiplied(255, 255, 255, 26)
    }
    /// accent @ 20% — selected row fill.
    pub fn accent_soft(&self) -> Color32 {
        with_alpha(self.accent, 51)
    }
    /// accent @ 35% — accent borders.
    pub fn accent_line(&self) -> Color32 {
        with_alpha(self.accent, 89)
    }
    /// accent @ 10% — quiet accent fills.
    pub fn accent_fill(&self) -> Color32 {
        with_alpha(self.accent, 26)
    }
    /// accent @ 18% — hovered accent fills / active Space chip.
    pub fn accent_fill_h(&self) -> Color32 {
        with_alpha(self.accent, 46)
    }
    /// accent mixed 32% toward white — accent text on dark fills.
    pub fn accent_bright(&self) -> Color32 {
        mix(self.accent, Color32::WHITE, 0.32)
    }
    /// Fixed root token (app.css defines it outside the per-theme set).
    pub fn magenta(&self) -> Color32 {
        c(0xc678dd)
    }
}

pub fn with_alpha(color: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), a)
}

/// Linear per-channel mix, the same thing CSS `color-mix(in srgb, …)` does.
pub fn mix(a: Color32, b: Color32, t: f32) -> Color32 {
    let ch = |x: u8, y: u8| -> u8 { (x as f32 + (y as f32 - x as f32) * t).round() as u8 };
    Color32::from_rgb(ch(a.r(), b.r()), ch(a.g(), b.g()), ch(a.b(), b.b()))
}

#[derive(Clone)]
pub struct AppTheme {
    pub id: &'static str,
    pub name: &'static str,
    pub term: TermPalette,
    pub chrome: Chrome,
}

const fn c(rgb: u32) -> Color32 {
    Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}

fn ca(rgb: u32, a: u8) -> Color32 {
    let base = c(rgb);
    Color32::from_rgba_unmultiplied(base.r(), base.g(), base.b(), a)
}

pub fn themes() -> &'static [AppTheme] {
    use std::sync::OnceLock;
    static THEMES: OnceLock<Vec<AppTheme>> = OnceLock::new();
    THEMES.get_or_init(build_themes)
}

pub fn theme_by_id(id: &str) -> &'static AppTheme {
    themes().iter().find(|t| t.id == id).unwrap_or(&themes()[0])
}

fn build_themes() -> Vec<AppTheme> {
    vec![
        AppTheme {
            id: "one-dark",
            name: "One Dark",
            term: TermPalette {
                background: c(0x1e2228),
                foreground: c(0xabb2bf),
                cursor: c(0x61afef),
                selection: ca(0x61afef, 51),
                ansi: [
                    c(0x1e2228), c(0xe06c75), c(0x98c379), c(0xe5c07b),
                    c(0x61afef), c(0xc678dd), c(0x56b6c2), c(0xabb2bf),
                    c(0x5c6370), c(0xe06c75), c(0x98c379), c(0xe5c07b),
                    c(0x61afef), c(0xc678dd), c(0x56b6c2), c(0xffffff),
                ],
            },
            chrome: Chrome {
                editor_header: c(0x22262d),
                chrome: c(0x2c313a),
                titlebar_1: c(0x343a45),
                titlebar_2: c(0x2e333d),
                text: c(0xe6e9ef),
                text_2: c(0xb6bcc7),
                text_3: c(0x9aa2b1),
                muted: c(0x6f7686),
                accent: c(0x61afef),
                green: c(0x98c379),
                amber: c(0xe0aa48),
                red: c(0xe06c75),
            },
        },
        AppTheme {
            id: "zede-dark",
            name: "Zede Dark",
            term: TermPalette {
                background: c(0x0b0a10),
                foreground: c(0xecebf3),
                cursor: c(0x8b9bff),
                selection: c(0x2b2a44),
                ansi: [
                    c(0x16131f), c(0xff6f66), c(0x5ed09a), c(0xe8c479),
                    c(0x8b9bff), c(0xc49bff), c(0x74d0d6), c(0xd7d6e0),
                    c(0x4a4860), c(0xff8a82), c(0x7fe0b4), c(0xf2d79a),
                    c(0xa9b5ff), c(0xd4b8ff), c(0x9fe6ea), c(0xffffff),
                ],
            },
            chrome: Chrome {
                editor_header: c(0x131019),
                chrome: c(0x1c1a28),
                titlebar_1: c(0x262336),
                titlebar_2: c(0x1f1c2c),
                text: c(0xecebf3),
                text_2: c(0xc3c1d4),
                text_3: c(0xa3a1b4),
                muted: c(0x6f6d82),
                accent: c(0x8b9bff),
                green: c(0x5ed09a),
                amber: c(0xe0aa48),
                red: c(0xff6f66),
            },
        },
        AppTheme {
            id: "solarized-dark",
            name: "Solarized Dark",
            term: TermPalette {
                background: c(0x002b36),
                foreground: c(0x93a1a1),
                cursor: c(0x268bd2),
                selection: c(0x073642),
                ansi: [
                    c(0x073642), c(0xdc322f), c(0x859900), c(0xb58900),
                    c(0x268bd2), c(0xd33682), c(0x2aa198), c(0xeee8d5),
                    c(0x586e75), c(0xcb4b16), c(0x586e75), c(0x657b83),
                    c(0x839496), c(0x6c71c4), c(0x93a1a1), c(0xfdf6e3),
                ],
            },
            chrome: Chrome {
                editor_header: c(0x04333e),
                chrome: c(0x073642),
                titlebar_1: c(0x0a4453),
                titlebar_2: c(0x063d4a),
                text: c(0xeee8d5),
                text_2: c(0x93a1a1),
                text_3: c(0x839496),
                muted: c(0x657b83),
                accent: c(0x268bd2),
                green: c(0x859900),
                amber: c(0xb58900),
                red: c(0xdc322f),
            },
        },
        AppTheme {
            id: "dracula",
            name: "Dracula",
            term: TermPalette {
                background: c(0x282a36),
                foreground: c(0xf8f8f2),
                cursor: c(0xbd93f9),
                selection: c(0x44475a),
                ansi: [
                    c(0x21222c), c(0xff5555), c(0x50fa7b), c(0xf1fa8c),
                    c(0xbd93f9), c(0xff79c6), c(0x8be9fd), c(0xf8f8f2),
                    c(0x6272a4), c(0xff6e6e), c(0x69ff94), c(0xffffa5),
                    c(0xd6acff), c(0xff92df), c(0xa4ffff), c(0xffffff),
                ],
            },
            chrome: Chrome {
                editor_header: c(0x2e303c),
                chrome: c(0x343746),
                titlebar_1: c(0x3d4152),
                titlebar_2: c(0x343746),
                text: c(0xf8f8f2),
                text_2: c(0xc9ccdf),
                text_3: c(0xa9adc4),
                muted: c(0x6272a4),
                accent: c(0xbd93f9),
                green: c(0x50fa7b),
                amber: c(0xf1fa8c),
                red: c(0xff5555),
            },
        },
        AppTheme {
            id: "nord",
            name: "Nord",
            term: TermPalette {
                background: c(0x2e3440),
                foreground: c(0xd8dee9),
                cursor: c(0x88c0d0),
                selection: c(0x434c5e),
                ansi: [
                    c(0x3b4252), c(0xbf616a), c(0xa3be8c), c(0xebcb8b),
                    c(0x81a1c1), c(0xb48ead), c(0x88c0d0), c(0xe5e9f0),
                    c(0x4c566a), c(0xbf616a), c(0xa3be8c), c(0xebcb8b),
                    c(0x81a1c1), c(0xb48ead), c(0x8fbcbb), c(0xeceff4),
                ],
            },
            chrome: Chrome {
                editor_header: c(0x333a47),
                chrome: c(0x3b4252),
                titlebar_1: c(0x434c5e),
                titlebar_2: c(0x3b4252),
                text: c(0xeceff4),
                text_2: c(0xc9d0dc),
                text_3: c(0xabb4c4),
                muted: c(0x6b7488),
                accent: c(0x88c0d0),
                green: c(0xa3be8c),
                amber: c(0xebcb8b),
                red: c(0xbf616a),
            },
        },
    ]
}

// --- ANSI color resolution -------------------------------------------------

fn rgb32(rgb: AnsiRgb) -> Color32 {
    Color32::from_rgb(rgb.r, rgb.g, rgb.b)
}

pub fn to_ansi_rgb(c: Color32) -> AnsiRgb {
    AnsiRgb { r: c.r(), g: c.g(), b: c.b() }
}

pub fn dim(c: Color32) -> Color32 {
    Color32::from_rgb(
        (c.r() as u32 * 2 / 3) as u8,
        (c.g() as u32 * 2 / 3) as u8,
        (c.b() as u32 * 2 / 3) as u8,
    )
}

/// Standard xterm 256-color value for indexes >= 16 (16-231 color cube,
/// 232-255 grayscale ramp). 0-15 come from the theme.
pub fn xterm_256(idx: u8, theme: &AppTheme) -> Color32 {
    match idx {
        0..=15 => theme.term.ansi[idx as usize],
        16..=231 => {
            let n = idx as u32 - 16;
            let cube = |v: u32| -> u8 {
                if v == 0 { 0 } else { (v * 40 + 55) as u8 }
            };
            Color32::from_rgb(cube(n / 36), cube((n % 36) / 6), cube(n % 6))
        }
        232..=255 => {
            let v = 8 + 10 * (idx as u32 - 232);
            Color32::from_rgb(v as u8, v as u8, v as u8)
        }
    }
}

fn named_color(name: NamedColor, theme: &AppTheme) -> Color32 {
    let t = &theme.term;
    match name {
        NamedColor::Foreground | NamedColor::BrightForeground => t.foreground,
        NamedColor::Background => t.background,
        NamedColor::Cursor => t.cursor,
        NamedColor::DimForeground => dim(t.foreground),
        NamedColor::DimBlack => dim(t.ansi[0]),
        NamedColor::DimRed => dim(t.ansi[1]),
        NamedColor::DimGreen => dim(t.ansi[2]),
        NamedColor::DimYellow => dim(t.ansi[3]),
        NamedColor::DimBlue => dim(t.ansi[4]),
        NamedColor::DimMagenta => dim(t.ansi[5]),
        NamedColor::DimCyan => dim(t.ansi[6]),
        NamedColor::DimWhite => dim(t.ansi[7]),
        other => {
            let idx = other as usize;
            if idx < 16 { t.ansi[idx] } else { t.foreground }
        }
    }
}

/// Resolve a terminal cell color against OSC-set overrides, then the theme.
pub fn resolve_ansi(color: AnsiColor, colors: &Colors, theme: &AppTheme) -> Color32 {
    match color {
        AnsiColor::Spec(rgb) => rgb32(rgb),
        AnsiColor::Indexed(i) => colors[i as usize]
            .map(rgb32)
            .unwrap_or_else(|| xterm_256(i, theme)),
        AnsiColor::Named(n) => colors[n].map(rgb32).unwrap_or_else(|| named_color(n, theme)),
    }
}

/// Brighten ANSI 0-7 for bold text (xterm's drawBoldTextInBrightColors).
pub fn bold_variant(color: AnsiColor) -> AnsiColor {
    match color {
        AnsiColor::Named(n) => {
            let idx = n as usize;
            if idx < 8 {
                AnsiColor::Indexed(idx as u8 + 8)
            } else {
                AnsiColor::Named(n)
            }
        }
        AnsiColor::Indexed(i) if i < 8 => AnsiColor::Indexed(i + 8),
        other => other,
    }
}
