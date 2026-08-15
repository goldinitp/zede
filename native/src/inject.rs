//! Context injection: rank the Space's memories into a ~1.5k-token budget and
//! write `.zede/context.md`, wiring `CLAUDE.md` to import it (a managed,
//! replaceable block) and `.gitignore` to exclude it. Ported from
//! `src/main/inject/context.ts` + `src/main/retrieve/ranker.ts` (the FTS and
//! semantic terms of the score are not yet grafted in — pin, recency,
//! frequency, scope and salience are).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::db::MemoryRow;

const BEGIN: &str = "<!-- zede:begin (managed — do not edit) -->";
const END: &str = "<!-- zede:end -->";
const IMPORT_LINE: &str = "@.zede/context.md";
// Pre-rename blocks (the app was called Loom) import stale memory forever if
// left in place — strip them on sight.
const LEGACY_BEGIN: &str = "<!-- loom:begin (managed — do not edit) -->";
const LEGACY_END: &str = "<!-- loom:end -->";

const TOKEN_BUDGET: usize = 1500;
const PIN_SUBBUDGET: usize = 600;
const RECENCY_HALF_LIFE_MS: f64 = 1000.0 * 60.0 * 60.0 * 24.0 * 14.0;

pub fn est_tokens(s: &str) -> usize {
    s.len().div_ceil(4)
}

fn scope_boost(scope: &str) -> f64 {
    let normalized: String = scope
        .trim()
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    match normalized.as_str() {
        "session" => 0.8,
        "branch" => 0.65,
        "repo" | "repository" | "space" => 0.5,
        "project" | "workspace" | "team" | "org" | "organization" => 0.35,
        "user" | "global" => 0.2,
        _ => 0.3,
    }
}

/// Turn free text (cwd + space name + tab titles) into a safe FTS5 MATCH
/// expression: unique lowercase alphanumeric tokens of 3+ chars, quoted,
/// OR-joined, capped at 16.
pub fn build_match_query(seed: &str) -> String {
    let lowered = seed.to_lowercase();
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    for c in lowered.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_alphanumeric() {
            current.push(c);
        } else if !current.is_empty() {
            if current.len() >= 3 && !tokens.contains(&current) {
                tokens.push(current.clone());
                if tokens.len() >= 16 {
                    break;
                }
            }
            current.clear();
        }
    }
    tokens
        .iter()
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn score(row: &MemoryRow, now_ms: i64, fts: &HashMap<String, f64>, fts_worst: f64) -> f64 {
    let mut s = 0.0;
    if row.pinned {
        s += 5.0;
    }
    if fts_worst > 0.0 {
        if let Some(mag) = fts.get(&row.id) {
            s += 2.0 * (mag / fts_worst);
        }
    }
    let basis = row
        .last_used_at
        .or(row.updated_at)
        .or(row.created_at)
        .unwrap_or(0);
    let age = (now_ms - basis).max(0) as f64;
    s += 1.5 * 0.5f64.powf(age / RECENCY_HALF_LIFE_MS);
    s += (0.3 * row.use_count as f64).min(1.5);
    s += scope_boost(&row.scope);
    s += 0.5 * row.salience.or(row.confidence).unwrap_or(0.0);
    s
}

/// Greedy token-budget fill: pinned first (capped at a pin sub-budget), then
/// by score. `fts` maps memory id -> bm25 magnitude for the current seed
/// (empty map = no lexical term).
pub fn select(rows: &[MemoryRow], now_ms: i64, fts: &HashMap<String, f64>) -> Vec<MemoryRow> {
    let fts_worst = fts.values().cloned().fold(0.0f64, f64::max);
    let mut ranked: Vec<(&MemoryRow, f64)> = rows
        .iter()
        .map(|r| (r, score(r, now_ms, fts, fts_worst)))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut selected: Vec<MemoryRow> = Vec::new();
    let mut tokens = 0usize;
    let mut pin_tokens = 0usize;
    for (row, _) in ranked.iter().filter(|(r, _)| r.pinned) {
        let t = est_tokens(&row.content);
        if pin_tokens + t > PIN_SUBBUDGET {
            continue;
        }
        selected.push((*row).clone());
        tokens += t;
        pin_tokens += t;
    }
    for (row, _) in ranked.iter().filter(|(r, _)| !r.pinned) {
        let t = est_tokens(&row.content);
        if tokens + t > TOKEN_BUDGET {
            continue;
        }
        selected.push((*row).clone());
        tokens += t;
    }
    selected
}

const TYPE_ORDER: [(&str, &str); 5] = [
    ("preference", "Preferences"),
    ("decision", "Decisions"),
    ("fact", "Facts"),
    ("entity", "Entities"),
    ("todo", "Open items"),
];

pub fn render_context(rows: &[MemoryRow], space_name: &str) -> String {
    let mut lines: Vec<String> = vec![
        format!("# Zede memory — {space_name}"),
        String::new(),
        "_Durable context distilled from earlier Claude Code sessions in this Space._".into(),
        "_Deletions in Zede are authoritative: removed items will not reappear here._".into(),
        String::new(),
    ];
    for (mtype, heading) in TYPE_ORDER {
        let group: Vec<&MemoryRow> = rows.iter().filter(|r| r.mtype == mtype).collect();
        if group.is_empty() {
            continue;
        }
        lines.push(format!("## {heading}"));
        for r in group {
            let pin = if r.pinned { "📌 " } else { "" };
            lines.push(format!("- {pin}{}", r.content));
        }
        lines.push(String::new());
    }
    if rows.is_empty() {
        lines.push("_(no memories yet)_".into());
    }
    lines.join("\n") + "\n"
}

/// Adapter A (default, inspectable): write the artifact and (best-effort)
/// wire gitignore + CLAUDE.md. Injection is best-effort by design — a fresh
/// session simply gets no prior context on failure.
pub fn write_context(cwd: &str, rows: &[MemoryRow], space_name: &str) -> PathBuf {
    let dir = Path::new(cwd).join(".zede");
    let context_path = dir.join("context.md");
    let attempt = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&context_path, render_context(rows, space_name))?;
        ensure_gitignore(Path::new(cwd));
        ensure_claude_md(Path::new(cwd));
        Ok(())
    })();
    let _ = attempt;
    context_path
}

fn ensure_gitignore(cwd: &Path) {
    let gi = cwd.join(".gitignore");
    let has_git = cwd.join(".git").exists();
    if gi.exists() {
        let Ok(body) = std::fs::read_to_string(&gi) else { return };
        let present = body
            .lines()
            .any(|l| matches!(l.trim(), ".zede/" | ".zede"));
        if !present {
            let _ = std::fs::write(&gi, format!("{}\n.zede/\n", body.trim_end()));
        }
    } else if has_git {
        let _ = std::fs::write(&gi, ".zede/\n");
    }
}

fn ensure_claude_md(cwd: &Path) {
    let path = cwd.join("CLAUDE.md");
    let block = format!("{BEGIN}\n{IMPORT_LINE}\n{END}");
    if !path.exists() {
        let _ = std::fs::write(&path, format!("{block}\n"));
        return;
    }
    let Ok(original) = std::fs::read_to_string(&path) else { return };
    let body = strip_between(&original, LEGACY_BEGIN, LEGACY_END);
    let next = if body.contains(BEGIN) && body.contains(END) {
        replace_between(&body, BEGIN, END, &block)
    } else {
        format!("{}\n\n{block}\n", body.trim_end())
            .trim_start_matches('\n')
            .to_string()
    };
    if next != original {
        let _ = std::fs::write(&path, next);
    }
}

/// Remove `begin..=end` (plus one trailing newline) if both markers exist.
fn strip_between(text: &str, begin: &str, end: &str) -> String {
    let (Some(b), Some(e)) = (text.find(begin), text.find(end)) else {
        return text.to_string();
    };
    if e < b {
        return text.to_string();
    }
    let mut after = e + end.len();
    if text[after..].starts_with('\n') {
        after += 1;
    }
    format!("{}{}", &text[..b], &text[after..])
}

fn replace_between(text: &str, begin: &str, end: &str, replacement: &str) -> String {
    let (Some(b), Some(e)) = (text.find(begin), text.find(end)) else {
        return text.to_string();
    };
    if e < b {
        return text.to_string();
    }
    format!("{}{}{}", &text[..b], replacement, &text[e + end.len()..])
}
