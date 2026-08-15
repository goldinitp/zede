//! Transcript reading for the prompt navigator (P5). Claude tab transcript
//! paths are deterministic (cwd + client-generated session id), so no
//! directory watcher is needed here — each feed stats its one file and reads
//! incrementally. Capture rules ported from the Electron app: read only
//! complete JSONL lines, at most 1 MiB per read, ignore `isMeta`/`isSidechain`
//! and non-user records, text blocks only.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;

pub const MAX_READ: usize = 1024 * 1024;
/// Cap stored prompt text so a giant paste can't flood the sidebar.
pub const PROMPT_CAP_CHARS: usize = 280;
const POLL_EVERY: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq)]
pub struct ChatPrompt {
    pub text: String,
}

/// Incremental reader over one session transcript.
pub struct PromptFeed {
    path: PathBuf,
    offset: u64,
    pub prompts: Vec<ChatPrompt>,
    last_poll: Option<Instant>,
}

impl PromptFeed {
    pub fn new(path: PathBuf) -> PromptFeed {
        PromptFeed { path, offset: 0, prompts: Vec::new(), last_poll: None }
    }

    /// Read any newly completed transcript lines (throttled). Returns true
    /// when new prompts were appended.
    pub fn poll(&mut self) -> bool {
        if let Some(at) = self.last_poll {
            if at.elapsed() < POLL_EVERY {
                return false;
            }
        }
        self.last_poll = Some(Instant::now());
        self.poll_now()
    }

    /// Unthrottled poll (tests and forced refreshes).
    pub fn poll_now(&mut self) -> bool {
        let Ok(meta) = std::fs::metadata(&self.path) else { return false };
        let size = meta.len();
        if size < self.offset {
            // Transcript replaced or truncated — start over.
            self.offset = 0;
            self.prompts.clear();
        }
        if size == self.offset {
            return false;
        }
        let Ok(mut file) = std::fs::File::open(&self.path) else { return false };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return false;
        }
        let mut buf = Vec::with_capacity(MAX_READ.min((size - self.offset) as usize));
        if file.take(MAX_READ as u64).read_to_end(&mut buf).is_err() {
            return false;
        }

        // Complete lines only: cut at the last newline in this window.
        let consumed = match buf.iter().rposition(|b| *b == b'\n') {
            Some(idx) => idx + 1,
            None => {
                if buf.len() >= MAX_READ {
                    // A single line larger than the window would wedge the
                    // feed forever; skip through it. The partial JSON parses
                    // to nothing, which is the right outcome for a monster
                    // line anyway.
                    self.offset += buf.len() as u64;
                }
                return false;
            }
        };

        let mut added = false;
        if let Ok(text) = std::str::from_utf8(&buf[..consumed]) {
            for line in text.lines() {
                if let Some(prompt) = prompt_from_line(line) {
                    self.prompts.push(ChatPrompt { text: prompt });
                    added = true;
                }
            }
        }
        self.offset += consumed as u64;
        added
    }
}

/// Extract the user prompt from one transcript JSONL record, applying the
/// Electron app's filters (meta/sidechain records, non-user roles, non-text
/// content, command echoes).
pub fn prompt_from_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if v["isMeta"].as_bool() == Some(true) || v["isSidechain"].as_bool() == Some(true) {
        return None;
    }
    if v["type"].as_str() != Some("user") {
        return None;
    }
    let content = &v["message"]["content"];
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect();
            if parts.is_empty() {
                return None; // tool_result-only records etc.
            }
            parts.join("\n")
        }
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty()
        || t.starts_with("<command-")
        || t.starts_with("<local-command")
        || t.starts_with("Caveat:")
    {
        return None;
    }
    Some(cap_chars(t, PROMPT_CAP_CHARS))
}

fn cap_chars(s: &str, cap: usize) -> String {
    let mut out: String = s.chars().take(cap).collect();
    if s.chars().nth(cap).is_some() {
        out.push('…');
    }
    out
}
