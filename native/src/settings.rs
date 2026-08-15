//! Settings: same keys, ranges and string storage form as the Electron app
//! (`src/main/settings.ts`), so a future sync/import round-trips cleanly.

use crate::db::Db;
use crate::theme;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorStyleKind {
    Block,
    Underline,
    Bar,
}

impl CursorStyleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CursorStyleKind::Block => "block",
            CursorStyleKind::Underline => "underline",
            CursorStyleKind::Bar => "bar",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "block" => Some(CursorStyleKind::Block),
            "underline" => Some(CursorStyleKind::Underline),
            "bar" => Some(CursorStyleKind::Bar),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub restore_pinned_sessions: bool,
    /// "claude" (higher recall, calls the API) or "heuristic" (offline).
    /// Stored under the Electron key `extractionTier`; "ollama" (not yet
    /// ported) loads as heuristic behavior but round-trips unchanged.
    pub extraction_tier: String,
    pub font_size: f32,
    pub line_height: f32,
    pub letter_spacing: f32,
    pub scrollback: u32,
    pub theme: String,
    pub cursor_style: CursorStyleKind,
    pub cursor_blink: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            restore_pinned_sessions: true,
            extraction_tier: "claude".to_string(),
            font_size: 13.0,
            line_height: 1.0,
            letter_spacing: 0.0,
            scrollback: 1000,
            theme: theme::DEFAULT_THEME_ID.to_string(),
            cursor_style: CursorStyleKind::Block,
            cursor_blink: true,
        }
    }
}

const BOOLEAN_KEYS: &[&str] = &["semanticEnabled", "restorePinnedSessions", "cursorBlink", "bgBlur"];

fn clamp_number(value: &str, min: f64, max: f64, integer: bool) -> Option<String> {
    let parsed: f64 = value.trim().parse().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    let clamped = parsed.clamp(min, max);
    Some(if integer {
        format!("{}", clamped.round() as i64)
    } else {
        // Matches JS String(number): integral values print without a decimal.
        if clamped.fract() == 0.0 {
            format!("{}", clamped as i64)
        } else {
            format!("{clamped}")
        }
    })
}

/// Validate the string form stored in SQLite. Ported from
/// `normalizeSettingValue`; unknown keys are rejected.
pub fn normalize_setting_value(key: &str, value: &str) -> Option<String> {
    if BOOLEAN_KEYS.contains(&key) {
        return match value {
            "1" | "0" => Some(value.to_string()),
            _ => None,
        };
    }
    match key {
        "injectionAdapter" => matches!(value, "file" | "flag").then(|| value.to_string()),
        "extractionTier" => matches!(value, "claude" | "heuristic" | "ollama").then(|| value.to_string()),
        "cursorStyle" => matches!(value, "block" | "underline" | "bar").then(|| value.to_string()),
        "theme" => theme::themes().iter().any(|t| t.id == value).then(|| value.to_string()),
        "embedTier" => matches!(value, "hashing" | "transformers").then(|| value.to_string()),
        "fontFamily" => {
            let clean = value.trim();
            (!clean.is_empty() && clean.len() <= 256).then(|| clean.to_string())
        }
        "fontSize" => clamp_number(value, 9.0, 24.0, false),
        "lineHeight" => clamp_number(value, 1.0, 2.0, false),
        "letterSpacing" => clamp_number(value, 0.0, 4.0, false),
        "scrollback" => clamp_number(value, 500.0, 50_000.0, true),
        "bgOpacity" => clamp_number(value, 0.5, 1.0, false),
        _ => None,
    }
}

impl Settings {
    pub fn load(db: &Db) -> Settings {
        let d = Settings::default();
        let get = |key: &str| -> Option<String> {
            db.get_setting(key)
                .and_then(|v| normalize_setting_value(key, &v))
        };
        let num = |key: &str, dflt: f32| -> f32 {
            get(key).and_then(|v| v.parse().ok()).unwrap_or(dflt)
        };
        Settings {
            restore_pinned_sessions: get("restorePinnedSessions")
                .map(|v| v == "1")
                .unwrap_or(d.restore_pinned_sessions),
            extraction_tier: get("extractionTier").unwrap_or(d.extraction_tier),
            font_size: num("fontSize", d.font_size),
            line_height: num("lineHeight", d.line_height),
            letter_spacing: num("letterSpacing", d.letter_spacing),
            scrollback: num("scrollback", d.scrollback as f32) as u32,
            theme: get("theme").unwrap_or(d.theme),
            cursor_style: get("cursorStyle")
                .and_then(|v| CursorStyleKind::from_str(&v))
                .unwrap_or(d.cursor_style),
            cursor_blink: get("cursorBlink").map(|v| v == "1").unwrap_or(d.cursor_blink),
        }
    }
}

/// Normalize + persist one setting; returns false when the value is rejected.
pub fn save_setting(db: &Db, key: &str, raw: &str) -> bool {
    match normalize_setting_value(key, raw) {
        Some(v) => {
            db.set_setting(key, &v);
            true
        }
        None => false,
    }
}
