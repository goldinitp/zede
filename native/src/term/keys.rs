//! Keyboard → escape-sequence encoding (xterm-compatible, matching what
//! xterm.js sent in the Electron app). Plain printable characters arrive as
//! egui `Text` events and are written through directly; this module handles
//! everything else.

use alacritty_terminal::term::TermMode;
use egui::{Key, Modifiers};

/// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
fn mod_param(mods: Modifiers) -> u8 {
    1 + u8::from(mods.shift) + 2 * u8::from(mods.alt) + 4 * u8::from(mods.ctrl)
}

fn csi(seq: &str) -> Option<Vec<u8>> {
    Some(format!("\x1b[{seq}").into_bytes())
}

fn ss3(ch: char) -> Option<Vec<u8>> {
    Some(format!("\x1bO{ch}").into_bytes())
}

/// Arrow/Home/End: CSI (or SS3 in application cursor mode); with modifiers
/// always CSI 1;<m><ch>.
fn cursor_key(ch: char, mods: Modifiers, mode: TermMode) -> Option<Vec<u8>> {
    let m = mod_param(mods);
    if m > 1 {
        csi(&format!("1;{m}{ch}"))
    } else if mode.contains(TermMode::APP_CURSOR) {
        ss3(ch)
    } else {
        csi(&ch.to_string())
    }
}

/// Editing keys: CSI <n>~ (with modifiers CSI <n>;<m>~).
fn tilde_key(n: u8, mods: Modifiers) -> Option<Vec<u8>> {
    let m = mod_param(mods);
    if m > 1 {
        csi(&format!("{n};{m}~"))
    } else {
        csi(&format!("{n}~"))
    }
}

fn ctrl_byte(b: u8) -> Option<Vec<u8>> {
    Some(vec![b])
}

/// Encode a non-text key press. Returns `None` when the key produces no PTY
/// bytes (plain printables — those arrive as `Text` events — and app-level
/// shortcuts, which are filtered before this is called).
pub fn encode_key(key: Key, mods: Modifiers, mode: TermMode) -> Option<Vec<u8>> {
    // Cmd combos are app shortcuts, never PTY input.
    if mods.mac_cmd || mods.command && !mods.ctrl {
        return None;
    }

    // Ctrl+letter and friends produce C0 control bytes.
    if mods.ctrl && !mods.alt {
        let byte = match key {
            Key::A => Some(0x01u8),
            Key::B => Some(0x02),
            Key::C => Some(0x03),
            Key::D => Some(0x04),
            Key::E => Some(0x05),
            Key::F => Some(0x06),
            Key::G => Some(0x07),
            Key::H => Some(0x08),
            Key::I => Some(0x09),
            Key::J => Some(0x0a),
            Key::K => Some(0x0b),
            Key::L => Some(0x0c),
            Key::M => Some(0x0d),
            Key::N => Some(0x0e),
            Key::O => Some(0x0f),
            Key::P => Some(0x10),
            Key::Q => Some(0x11),
            Key::R => Some(0x12),
            Key::S => Some(0x13),
            Key::T => Some(0x14),
            Key::U => Some(0x15),
            Key::V => Some(0x16),
            Key::W => Some(0x17),
            Key::X => Some(0x18),
            Key::Y => Some(0x19),
            Key::Z => Some(0x1a),
            Key::Space => Some(0x00),
            Key::OpenBracket => Some(0x1b),
            Key::Backslash => Some(0x1c),
            Key::CloseBracket => Some(0x1d),
            Key::Minus => Some(0x1f),
            Key::Slash => Some(0x1f),
            _ => None,
        };
        if let Some(b) = byte {
            return ctrl_byte(b);
        }
    }

    match key {
        Key::Enter => Some(b"\r".to_vec()),
        Key::Tab => {
            if mods.shift {
                csi("Z")
            } else {
                Some(b"\t".to_vec())
            }
        }
        Key::Backspace => Some(vec![0x7f]),
        Key::Escape => Some(vec![0x1b]),
        Key::ArrowUp => cursor_key('A', mods, mode),
        Key::ArrowDown => cursor_key('B', mods, mode),
        Key::ArrowRight => cursor_key('C', mods, mode),
        Key::ArrowLeft => cursor_key('D', mods, mode),
        Key::Home => cursor_key('H', mods, mode),
        Key::End => cursor_key('F', mods, mode),
        Key::PageUp => tilde_key(5, mods),
        Key::PageDown => tilde_key(6, mods),
        Key::Insert => tilde_key(2, mods),
        Key::Delete => tilde_key(3, mods),
        Key::F1 => ss3('P'),
        Key::F2 => ss3('Q'),
        Key::F3 => ss3('R'),
        Key::F4 => ss3('S'),
        Key::F5 => tilde_key(15, mods),
        Key::F6 => tilde_key(17, mods),
        Key::F7 => tilde_key(18, mods),
        Key::F8 => tilde_key(19, mods),
        Key::F9 => tilde_key(20, mods),
        Key::F10 => tilde_key(21, mods),
        Key::F11 => tilde_key(23, mods),
        Key::F12 => tilde_key(24, mods),
        _ => None,
    }
}

/// Prepare pasted text for the PTY. Bracketed paste wraps the payload and
/// strips any embedded end-marker (paste injection); plain paste normalizes
/// newlines to carriage returns like xterm.
pub fn encode_paste(text: &str, bracketed: bool) -> Vec<u8> {
    if bracketed {
        let sanitized = text.replace("\x1b[201~", "");
        let mut out = Vec::with_capacity(sanitized.len() + 12);
        out.extend_from_slice(b"\x1b[200~");
        out.extend_from_slice(sanitized.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}
