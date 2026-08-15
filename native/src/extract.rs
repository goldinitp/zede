//! Heuristic memory extraction + the learn pipeline. Ported from
//! `src/main/extract/heuristic.ts` and `src/main/pipeline/fingerprint.ts`:
//! zero-dependency pattern matching over user prompts — lower recall than the
//! `claude -p` extractor (a later tier), but offline and deterministic.
//! Everything passes through redaction before storage, and fingerprints give
//! dedup + tombstone suppression ("forgotten memories never return").

use std::sync::OnceLock;
use std::time::Duration;

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

/// Store candidates with fingerprint dedupe against existing rows AND
/// tombstones. UI thread only — the db has a single writer. Returns the
/// number stored.
pub fn store_candidates(db: &Db, space_id: &str, candidates: &[Candidate]) -> usize {
    let mut stored = 0;
    for cand in candidates {
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

/// Synchronous heuristic pipeline for one span: redact -> extract -> store.
pub fn learn_from_text(db: &Db, space_id: &str, text: &str) -> usize {
    let clean = redact::redact(text).text;
    let candidates = extract(&clean);
    store_candidates(db, space_id, &candidates)
}

// --- claude -p extractor tier ----------------------------------------------

pub const MEMORY_TYPES: [&str; 5] = ["fact", "decision", "preference", "entity", "todo"];

fn static_type(s: &str) -> Option<&'static str> {
    MEMORY_TYPES.iter().find(|t| **t == s).copied()
}

const SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"properties":{"memories":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"type":{"type":"string","enum":["fact","decision","preference","entity","todo"]},"content":{"type":"string"},"confidence":{"type":"number"},"scope_hint":{"type":"string","enum":["space","global"]}},"required":["type","content","confidence"]}}},"required":["memories"]}"#;

const SYSTEM: &str = "You extract DURABLE memories from a coding-session transcript span — things that will still matter weeks from now. \
Return ONLY structured JSON matching the schema: an object with a \"memories\" array. \
Each memory: {type, content, confidence 0..1, scope_hint}. type in {fact,decision,preference,entity,todo}. \
CAPTURE: stable facts about the user, project, or domain; architectural/product decisions and WHY; the user's standing \
preferences and conventions; important named entities (services, tools, people, key files); and genuine open tasks that outlive this session. \
DO NOT CAPTURE (omit entirely): transient or procedural steps (run/restart/rebuild/install commands, \"npm run dev\", git steps); \
ephemeral debugging notes, hypotheses, root-cause guesses, or the status of work in progress; anything about the assistant's own \
process or this memory tool itself; greetings, acknowledgements, and command/tool output noise; todos obsolete once this session ends. \
When unsure whether something is durable, OMIT it — prefer a few high-signal memories over many noisy ones. \
Each content is ONE concise, self-contained, present-tense sentence, no markdown. \
scope_hint \"global\" only for facts true across ALL projects (who the user is, cross-project preferences); otherwise \"space\".";

const CLAUDE_MODEL: &str = "claude-haiku-4-5-20251001";
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(60);

/// Strict parsing of `claude -p --output-format json` stdout; bad extractor
/// output must never reach the store. Handles the `structured_output` field,
/// a JSON-string `result`, and an object `result`.
pub fn parse_candidates(stdout: &str) -> Vec<Candidate> {
    let Ok(envelope) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    let mut payload = envelope.get("structured_output").cloned();
    if payload.is_none() || payload == Some(serde_json::Value::Null) {
        payload = match envelope.get("result") {
            Some(serde_json::Value::String(s)) => serde_json::from_str(s).ok(),
            Some(v @ serde_json::Value::Object(_)) => Some(v.clone()),
            _ => None,
        };
    }
    let Some(payload) = payload else { return Vec::new() };
    let list = payload
        .get("memories")
        .and_then(|m| m.as_array())
        .or_else(|| payload.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for item in list {
        let Some(content) = item.get("content").and_then(|c| c.as_str()) else { continue };
        if content.trim().is_empty() {
            continue;
        }
        let Some(mtype) = item.get("type").and_then(|t| t.as_str()).and_then(static_type) else {
            continue;
        };
        out.push(Candidate {
            mtype,
            content: content.to_string(),
            confidence: item.get("confidence").and_then(|c| c.as_f64()).unwrap_or(0.5),
            scope_hint: if item.get("scope_hint").and_then(|s| s.as_str()) == Some("global") {
                ScopeHint::Global
            } else {
                ScopeHint::Space
            },
        });
    }
    out
}

/// Sessions Zede itself starts (the `claude -p` extractor) must be invisible
/// to transcript discovery: re-capturing extractor output would feed the
/// extractor its own spans — an unbounded model-call loop. Callers register
/// the session id BEFORE spawning; discovery checks it. In-memory only: the
/// temp-dir cwd isolation is what keeps old extractor transcripts out of
/// reach across restarts.
fn internal_sessions() -> &'static std::sync::Mutex<Vec<String>> {
    static IDS: OnceLock<std::sync::Mutex<Vec<String>>> = OnceLock::new();
    IDS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

pub fn mark_internal_session(id: &str) {
    if let Ok(mut ids) = internal_sessions().lock() {
        ids.push(id.to_string());
    }
}

pub fn is_internal_session(id: &str) -> bool {
    internal_sessions()
        .lock()
        .map(|ids| ids.iter().any(|x| x == id))
        .unwrap_or(false)
}

/// Run `claude -p` over a redacted span. Blocking (called from the worker
/// thread). `None` = claude could not be run at all (caller may fall back);
/// `Some(vec)` = it ran, possibly finding nothing.
///
/// The child claude writes its own transcript under the temp dir's cwd slug —
/// never a watched project directory — and its session id is registered as
/// internal, so discovery can't re-distill extractor output.
pub fn claude_extract(span: &str) -> Option<Vec<Candidate>> {
    if span.trim().is_empty() {
        return Some(Vec::new());
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    mark_internal_session(&session_id);
    let mut child = std::process::Command::new("claude")
        .args([
            "-p", span,
            "--session-id", &session_id,
            "--output-format", "json",
            "--json-schema", SCHEMA,
            "--append-system-prompt", SYSTEM,
            "--model", CLAUDE_MODEL,
        ])
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut out = String::new();
        let _ = std::io::BufReader::new(stdout).read_to_string(&mut out);
        out
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > CLAUDE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => break,
        }
    }
    let out = reader.join().unwrap_or_default();
    Some(parse_candidates(&out))
}

// --- async extraction worker -------------------------------------------------

pub struct LearnRequest {
    pub space_id: String,
    pub span: String,
    /// Settings value at send time ("claude" | anything else = heuristic).
    pub tier: String,
}

pub struct LearnResult {
    pub space_id: String,
    pub candidates: Vec<Candidate>,
}

/// Extraction runs off the UI thread (a claude -p call takes seconds). The
/// worker redacts + extracts; the app stores results on the UI thread (the db
/// stays single-writer).
pub fn start_worker(
    ctx: Option<egui::Context>,
) -> (std::sync::mpsc::Sender<LearnRequest>, std::sync::mpsc::Receiver<LearnResult>) {
    let (req_tx, req_rx) = std::sync::mpsc::channel::<LearnRequest>();
    let (res_tx, res_rx) = std::sync::mpsc::channel::<LearnResult>();
    std::thread::Builder::new()
        .name("zede-extractor".into())
        .spawn(move || {
            while let Ok(req) = req_rx.recv() {
                let clean = redact::redact(&req.span).text;
                let candidates = if req.tier == "claude" {
                    // Spawn failure (claude not on PATH) falls back to the
                    // offline heuristics rather than learning nothing.
                    claude_extract(&clean).unwrap_or_else(|| extract(&clean))
                } else {
                    extract(&clean)
                };
                if res_tx
                    .send(LearnResult { space_id: req.space_id, candidates })
                    .is_err()
                {
                    break;
                }
                if let Some(ctx) = &ctx {
                    ctx.request_repaint();
                }
            }
        })
        .ok();
    (req_tx, res_rx)
}
