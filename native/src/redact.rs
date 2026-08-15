//! Secret redaction — the main safety control before extraction and storage.
//! Applied both to transcript spans before they reach an extractor and to
//! candidate memory content before persistence. Pure + synchronous, ported
//! rule-for-rule from `src/main/pipeline/redact.ts`.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

struct Pattern {
    name: &'static str,
    re: Regex,
}

fn patterns() -> &'static [Pattern] {
    static PATTERNS: OnceLock<Vec<Pattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let p = |name: &'static str, re: &str| Pattern {
            name,
            re: Regex::new(re).expect("static redaction regex"),
        };
        vec![
            p("anthropic-key", r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
            p("openai-key", r"\bsk-[A-Za-z0-9]{20,}\b"),
            p("aws-akid", r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
            p("github-token", r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
            p("slack-token", r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
            p("google-key", r"\bAIza[A-Za-z0-9_-]{30,}\b"),
            p(
                "private-key",
                r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----",
            ),
            p(
                "jwt",
                r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
            ),
            p("bearer", r"\bBearer\s+[A-Za-z0-9._-]{12,}"),
            p(
                "secret-kv",
                r"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+",
            ),
        ]
    })
}

fn entropy_fallback_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b[A-Za-z0-9+/=_-]{32,}\b").expect("static regex"))
}

pub struct RedactResult {
    pub text: String,
    pub redactions: usize,
}

pub fn redact(input: &str) -> RedactResult {
    let mut text = input.to_string();
    let mut redactions = 0usize;

    for pattern in patterns() {
        text = pattern
            .re
            .replace_all(&text, |_: &regex::Captures| {
                redactions += 1;
                format!("[REDACTED:{}]", pattern.name)
            })
            .into_owned();
    }

    // High-entropy fallback: long opaque tokens no named rule caught.
    text = entropy_fallback_re()
        .replace_all(&text, |caps: &regex::Captures| {
            let tok = &caps[0];
            // Filesystem paths read as one long token because '/' is in the
            // charset, but they aren't secrets.
            if tok.contains("REDACTED") || tok.contains('/') {
                return tok.to_string();
            }
            if shannon_entropy(tok) >= 3.8 {
                redactions += 1;
                "[REDACTED:high-entropy]".to_string()
            } else {
                tok.to_string()
            }
        })
        .into_owned();

    RedactResult { text, redactions }
}

#[allow(dead_code)] // extractor pipeline entry point (P6 extraction)
pub fn redact_text(s: &str) -> String {
    redact(s).text
}

fn shannon_entropy(s: &str) -> f64 {
    let mut freq: HashMap<char, usize> = HashMap::new();
    let mut len = 0usize;
    for c in s.chars() {
        *freq.entry(c).or_insert(0) += 1;
        len += 1;
    }
    let mut h = 0.0f64;
    for n in freq.values() {
        let p = *n as f64 / len as f64;
        h -= p * p.log2();
    }
    h
}
