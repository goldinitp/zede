//! Heuristic memory extraction + the learn pipeline. Ported from
//! `src/main/extract/heuristic.ts` and `src/main/pipeline/fingerprint.ts`:
//! zero-dependency pattern matching over user prompts — lower recall than the
//! `claude -p` extractor (a later tier), but offline and deterministic.
//! Everything passes through redaction before storage, and fingerprints give
//! dedup + tombstone suppression ("forgotten memories never return").

use std::sync::OnceLock;

use regex::Regex;
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::redact;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScopeHint {
    Space,
    Global,
}

pub struct Candidate {
    pub mtype: &'static str,
    pub content: String,
    pub confidence: f64,
    pub scope_hint: ScopeHint,
}

struct Rule {
    re: Regex,
    mtype: &'static str,
    scope: ScopeHint,
    conf: f64,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let r = |re: &str, mtype: &'static str, scope: ScopeHint, conf: f64| Rule {
            re: Regex::new(re).expect("static extraction regex"),
            mtype,
            scope,
            conf,
        };
        vec![
            r(
                r"(?i)\b(?:i (?:prefer|like|always|usually|tend to)|please always|let'?s always)\b[^.!?\n]{0,120}",
                "preference", ScopeHint::Space, 0.6,
            ),
            r(
                r"(?i)\b(?:use|using)\s+[a-z0-9._-]+\s+(?:not|instead of|over)\s+[a-z0-9._-]+",
                "preference", ScopeHint::Space, 0.6,
            ),
            r(
                r"(?i)\b(?:we (?:decided|agreed|will|chose)|let'?s (?:go with|use)|going with|switch(?:ing)? to|adopt(?:ed)?)\b[^.!?\n]{0,120}",
                "decision", ScopeHint::Space, 0.62,
            ),
            r(
                r"(?i)\b(?:my name is|call me)\s+[A-Z][a-z]+",
                "entity", ScopeHint::Global, 0.7,
            ),
            r(
                r"(?i)\b[a-z0-9 _-]{2,40}\s+(?:is (?:located|at|in)|lives? (?:at|in))\s+[^.!?\n]{1,80}",
                "entity", ScopeHint::Space, 0.55,
            ),
            r(
                r"(?i)\b(?:todo|to-do|need to|remember to|don'?t forget to)\b[^.!?\n]{0,120}",
                "todo", ScopeHint::Space, 0.55,
            ),
        ]
    })
}

fn normalize_candidate(s: &str) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches([',', ';', ':']).trim().to_string();
    let mut chars = trimmed.chars();
    let mut t: String = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => return String::new(),
    };
    if !t.ends_with(['.', '!', '?']) {
        t.push('.');
    }
    t
}

/// Pattern-match a span for durable statements. Dedupes case-insensitively,
/// drops fragments (<8 chars) and run-ons (>160), caps at 20 candidates.
pub fn extract(span: &str) -> Vec<Candidate> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Candidate> = Vec::new();
    for rule in rules() {
        for m in rule.re.find_iter(span) {
            let content = normalize_candidate(m.as_str());
            let n = content.chars().count();
            if !(8..=160).contains(&n) {
                continue;
            }
            let key = content.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            out.push(Candidate {
                mtype: rule.mtype,
                content,
                confidence: rule.conf,
                scope_hint: rule.scope,
            });
            if out.len() >= 20 {
                return out;
            }
        }
    }
    out
}

/// Semantic fingerprint for dedup and tombstone matching: a re-derived memory
/// must hash the SAME as its tombstone so it stays suppressed.
pub fn normalize_fingerprint(content: &str) -> String {
    let lowered = content.to_lowercase();
    let stripped: String = lowered
        .chars()
        .filter(|c| !matches!(c, '`' | '\'' | '"'))
        .map(|c| if c.is_ascii_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn fingerprint(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize_fingerprint(content).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// The learn pipeline for one span of user text: redact -> extract ->
/// fingerprint-dedupe (existing rows AND tombstones) -> store. Returns the
/// number of memories stored.
pub fn learn_from_text(db: &Db, space_id: &str, text: &str) -> usize {
    let clean = redact::redact(text).text;
    let mut stored = 0;
    for cand in extract(&clean) {
        let fp = fingerprint(&cand.content);
        if db.has_memory_with_hash(&fp) || db.has_tombstone(&fp) {
            continue;
        }
        let (space, scope) = match cand.scope_hint {
            ScopeHint::Global => (None, "global"),
            ScopeHint::Space => (Some(space_id), "space"),
        };
        db.insert_memory(space, scope, cand.mtype, &cand.content, Some(cand.confidence), Some(&fp));
        stored += 1;
    }
    stored
}
