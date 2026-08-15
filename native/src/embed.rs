//! Hashing embedder + supersede logic, ported from `src/main/embed/
//! {embedder,service}.ts`. Bag-of-tokens feature hashing (uni + bigrams) —
//! cosine reflects shared vocabulary; the honest zero-dependency floor, not a
//! MiniLM substitute. Cheap enough to compute on the fly, so no vector table.
//!
//! Only opinions get superseded; facts/entities/todos accumulate.

use crate::db::Db;

pub const DIM: usize = 256;
/// hashing-v1 threshold (the MiniLM tier uses 0.84).
pub const SUPERSEDE_THRESHOLD: f32 = 0.6;
const SUPERSEDE_TYPES: [&str; 2] = ["preference", "decision"];

/// FNV-1a 32-bit, matching the JS implementation exactly (ASCII tokens only,
/// so charCodeAt and byte iteration agree).
fn hash32(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn tokens(text: &str) -> Vec<String> {
    let lowered = text.to_lowercase();
    let mut out = Vec::new();
    let mut current = String::new();
    for c in lowered.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_alphanumeric() {
            current.push(c);
        } else if !current.is_empty() {
            if current.len() > 1 {
                out.push(current.clone());
            }
            current.clear();
        }
    }
    out
}

pub fn embed(text: &str) -> Vec<f32> {
    let mut v = vec![0.0f32; DIM];
    let toks = tokens(text);
    for (i, tok) in toks.iter().enumerate() {
        v[(hash32(tok) as usize) % DIM] += 1.0;
        if i > 0 {
            let bigram = format!("{} {}", toks[i - 1], tok);
            v[(hash32(&bigram) as usize) % DIM] += 0.5; // bigram, weaker
        }
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(f32::EPSILON);
    for x in &mut v {
        *x /= norm;
    }
    v
}

/// Both inputs pre-normalized — cosine is the dot product.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn supersedes_type(mtype: &str) -> bool {
    SUPERSEDE_TYPES.contains(&mtype)
}

/// After inserting a new opinion, supersede older near-duplicates (same
/// space + scope + type, different fingerprint) — the newer memory wins.
/// Returns how many rows were superseded.
pub fn supersede_near_duplicates(
    db: &Db,
    new_id: &str,
    space_id: Option<&str>,
    scope: &str,
    mtype: &str,
    content: &str,
    source_hash: &str,
    now: i64,
) -> usize {
    if !supersedes_type(mtype) {
        return 0;
    }
    let vec = embed(content);
    let mut superseded = 0;
    for cand in db.active_same_type(space_id, mtype, scope, new_id) {
        if cand.source_hash.as_deref() == Some(source_hash) {
            continue;
        }
        if cosine(&vec, &embed(&cand.content)) >= SUPERSEDE_THRESHOLD {
            db.set_memory_status(&cand.id, "superseded", now);
            superseded += 1;
        }
    }
    superseded
}

const DEDUPE_SYSTEM: &str = "You are given standing memories of one kind from one project space, one per line as 'key | content' (keys like m1, m2). \
Candidate groups are separated by blank lines; NEVER cluster keys from different blank-line groups. \
Within a group, identify entries that RESTATE THE SAME standing preference or decision. Different rules that merely share words are NOT duplicates — when unsure, do not cluster. \
Return ONLY JSON matching the schema: {\"clusters\":[{\"keep\":key,\"drop\":[keys]}]}. \
keep = the clearest, most complete statement's key; drop = the other keys restating it. Copy keys exactly; no prose.";

/// Low-recall gate: rows sharing this much vocabulary are worth showing to
/// the judge. Well below the 0.6 auto-supersede threshold on purpose.
const RECALL_THRESHOLD: f32 = 0.35;

const DEDUPE_SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"properties":{"clusters":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"keep":{"type":"string"},"drop":{"type":"array","items":{"type":"string"}}},"required":["keep","drop"]}}},"required":["clusters"]}"#;

/// One row as the judge saw it: short key -> real id, pinned, and the exact
/// (truncated, newline-collapsed) content line from the listing.
pub struct JudgeRow {
    pub id: String,
    pub pinned: bool,
    pub content: String,
}

/// Lowercase, alphanumeric-only, single-spaced — echoes survive punctuation
/// drift and truncation differences.
fn norm_echo(s: &str) -> String {
    let filtered: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    filtered.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The judge is asked for keys but often echoes (sometimes re-truncated or
/// re-punctuated) content instead — accept either, but only when the
/// resolution is unambiguous.
fn resolve_key<'a>(
    entry: &str,
    group: &'a std::collections::HashMap<String, JudgeRow>,
) -> Option<&'a str> {
    if group.contains_key(entry) {
        return group.get_key_value(entry).map(|(k, _)| k.as_str());
    }
    let needle = norm_echo(entry);
    if needle.len() < 12 {
        return None; // too short to identify a row safely
    }
    let mut hit: Option<&str> = None;
    for (key, row) in group {
        let content = norm_echo(&row.content);
        if content.starts_with(&needle) || needle.starts_with(&content) {
            if hit.is_some() {
                return None; // ambiguous echo
            }
            hit = Some(key.as_str());
        }
    }
    hit
}

/// Apply one claude-judged cluster payload. Hard validation: entries must
/// resolve to the group (by key or verbatim content echo); a dropped row must
/// actually be lexically similar to the keeper (the judge cannot delete an
/// unrelated rule); and a pinned row never loses to an unpinned keeper (the
/// keep swaps instead). Returns rows superseded.
pub fn apply_dedupe_clusters(
    db: &Db,
    group: &std::collections::HashMap<String, JudgeRow>,
    payload: &serde_json::Value,
    now: i64,
) -> usize {
    let Some(clusters) = payload.get("clusters").and_then(|c| c.as_array()) else { return 0 };
    let mut superseded = 0;
    for cluster in clusters {
        let Some(keep_raw) = cluster.get("keep").and_then(|k| k.as_str()) else { continue };
        let Some(drop) = cluster.get("drop").and_then(|d| d.as_array()) else { continue };
        let Some(keep) = resolve_key(keep_raw, group) else {
            continue; // hallucinated keeper — reject the whole cluster
        };
        let mut drop_keys: Vec<&str> = drop
            .iter()
            .filter_map(|d| d.as_str())
            .filter_map(|entry| resolve_key(entry, group))
            .filter(|k| *k != keep)
            .collect();
        drop_keys.dedup();
        if drop_keys.is_empty() {
            continue;
        }
        // Pinned rows win: if the keeper is unpinned but a dropped row is
        // pinned, that pinned row becomes the keeper.
        let mut keep = keep;
        if !group.get(keep).map(|r| r.pinned).unwrap_or(false) {
            if let Some(pinned_pos) = drop_keys
                .iter()
                .position(|k| group.get(*k).map(|r| r.pinned).unwrap_or(false))
            {
                let promoted = drop_keys.remove(pinned_pos);
                drop_keys.push(keep);
                keep = promoted;
            }
        }
        // Similarity floor: a drop must share real vocabulary with the keeper.
        let keeper_vec = group.get(keep).map(|r| embed(&r.content));
        for key in drop_keys {
            let (Some(row), Some(kv)) = (group.get(key), keeper_vec.as_ref()) else { continue };
            if cosine(kv, &embed(&row.content)) < RECALL_THRESHOLD {
                continue; // judge tried to drop an unrelated rule
            }
            db.set_memory_status(&row.id, "superseded", now);
            superseded += 1;
        }
    }
    superseded
}

/// Claude-judged dedupe over opinion groups with enough rows to matter.
/// Blocking (CLI / maintenance use). Returns (superseded, groups scanned);
/// Err only when claude cannot run at all.
pub fn llm_dedupe(db: &Db, now: i64) -> Result<(usize, usize), String> {
    use std::collections::HashMap;
    let mut rows = db.all_memories_sync();
    rows.retain(|r| r.status == "active" && supersedes_type(&r.mtype));

    let mut groups: HashMap<(Option<String>, String, String), Vec<&crate::db::FullMemoryRow>> =
        HashMap::new();
    for r in &rows {
        groups
            .entry((r.space_id.clone(), r.scope.clone(), r.mtype.clone()))
            .or_default()
            .push(r);
    }

    let mut superseded = 0;
    let mut scanned = 0;
    for (_, members) in groups {
        if members.len() < 2 {
            continue;
        }
        // Recall filter: greedy connected components on hashing cosine. Only
        // rows with at least one plausible duplicate reach the judge, so a
        // 200-row group usually becomes a couple of small components.
        let vecs: Vec<Vec<f32>> = members.iter().map(|m| embed(&m.content)).collect();
        let mut component: Vec<usize> = (0..members.len()).collect();
        for i in 0..members.len() {
            for j in (i + 1)..members.len() {
                if cosine(&vecs[i], &vecs[j]) >= RECALL_THRESHOLD {
                    let (a, b) = (component[i], component[j]);
                    if a != b {
                        for c in component.iter_mut() {
                            if *c == b {
                                *c = a;
                            }
                        }
                    }
                }
            }
        }
        let mut by_component: HashMap<usize, Vec<usize>> = HashMap::new();
        for (idx, c) in component.iter().enumerate() {
            by_component.entry(*c).or_default().push(idx);
        }
        let mut candidates: Vec<Vec<usize>> =
            by_component.into_values().filter(|c| c.len() >= 2).collect();
        candidates.sort_by_key(|c| std::cmp::Reverse(c.len()));
        if candidates.is_empty() {
            continue;
        }
        scanned += 1;

        // Batch whole components into calls (≤36 rows per call, ≤4 calls per
        // group — short keys and tight content keep each call fast).
        let mut batches: Vec<Vec<usize>> = vec![Vec::new()];
        for comp in candidates {
            let comp: Vec<usize> = comp.into_iter().take(36).collect();
            let last = batches.last_mut().expect("non-empty");
            if !last.is_empty() && last.len() + comp.len() + 1 > 36 {
                batches.push(comp);
            } else {
                if !last.is_empty() {
                    last.push(usize::MAX); // blank-line separator marker
                }
                last.extend(comp);
            }
        }
        for batch in batches.into_iter().take(4) {
            if batch.iter().filter(|i| **i != usize::MAX).count() < 2 {
                continue;
            }
            let mut listing = String::new();
            let mut group_map: HashMap<String, JudgeRow> = HashMap::new();
            let mut key_n = 0usize;
            for idx in &batch {
                if *idx == usize::MAX {
                    listing.push('\n');
                    continue;
                }
                key_n += 1;
                let key = format!("m{key_n}");
                let m = members[*idx];
                let content: String =
                    m.content.chars().take(120).collect::<String>().replace('\n', " ");
                listing.push_str(&format!("{key} | {content}\n"));
                group_map.insert(key, JudgeRow { id: m.id.clone(), pinned: m.pinned, content });
            }
            let Some(stdout) = crate::extract::claude_call(&listing, DEDUPE_SYSTEM, DEDUPE_SCHEMA)
            else {
                return Err("claude is not available for the deep dedupe".into());
            };
            let Some(payload) = crate::extract::envelope_payload(&stdout) else { continue };
            superseded += apply_dedupe_clusters(db, &group_map, &payload, now);
        }
    }
    Ok((superseded, scanned))
}

/// One-shot near-duplicate collapse over existing opinions (the imported
/// Electron set is full of restatements). Winners are pinned rows first,
/// then the most recently edited; losers become 'superseded'. Idempotent.
pub fn dedupe_pass(db: &Db, now: i64) -> usize {
    let mut rows = db.all_memories_sync();
    rows.retain(|r| r.status == "active" && supersedes_type(&r.mtype));

    // Winner order: pinned first, then newest edit clock.
    let pinned_of = |id: &str| {
        db.get_memory_pinned(id).unwrap_or(false)
    };
    rows.sort_by_key(|r| (!pinned_of(&r.id), std::cmp::Reverse(r.edited_at)));

    let mut kept: Vec<(Option<String>, String, String, Vec<f32>)> = Vec::new();
    let mut superseded = 0;
    for row in rows {
        let vec = embed(&row.content);
        let dup = kept.iter().any(|(space, scope, mtype, kv)| {
            *space == row.space_id
                && *scope == row.scope
                && *mtype == row.mtype
                && cosine(kv, &vec) >= SUPERSEDE_THRESHOLD
        });
        if dup {
            db.set_memory_status(&row.id, "superseded", now);
            superseded += 1;
        } else {
            kept.push((row.space_id.clone(), row.scope.clone(), row.mtype.clone(), vec));
        }
    }
    superseded
}
