//! Sync wire format, ported from `src/main/sync/format.ts`: one markdown file
//! per memory (frontmatter + body) plus small JSON files. Pure and
//! deterministic — same DB state → byte-identical tree, so a no-op sync makes
//! no git commit.
//!
//! The native app manages: `zede.json`, `memories/`, `tombstones/`,
//! `spaces/`, `settings.json`. Categories it doesn't model yet (`links/`,
//! `membership.json`) are left untouched in the working tree so a native
//! machine never erases an Electron machine's data on push.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::db::{Db, FullMemoryRow, TombstoneRow};
use crate::redact;

pub const FORMAT_VERSION: i64 = 1;

/// Settings keys that travel across machines (machine-local and sync-state
/// keys deliberately excluded).
pub const SYNCED_SETTINGS: &[&str] = &[
    "theme", "fontFamily", "fontSize", "lineHeight", "letterSpacing",
    "scrollback", "cursorStyle", "cursorBlink", "bgOpacity", "bgBlur",
    "injectionAdapter", "extractionTier", "semanticEnabled", "embedTier",
];

const MEMORY_TYPES: &[&str] = &["fact", "decision", "preference", "entity", "todo"];
const MEMORY_STATUSES: &[&str] = &["active", "superseded", "tombstoned", "archived"];

pub const ENC_PREFIX: &str = "enc1:";

#[derive(Clone, Debug, PartialEq)]
pub struct SyncedSpace {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
pub struct SyncedSetting {
    pub value: String,
    pub edited_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Encryption {
    None,
    Aes256Gcm,
}

pub struct SyncTree {
    #[allow(dead_code)] // consulted when the cipher tier lands
    pub encryption: Encryption,
    pub memories: Vec<FullMemoryRow>,
    pub tombstones: Vec<TombstoneRow>,
    pub spaces: Vec<SyncedSpace>,
    pub settings: BTreeMap<String, SyncedSetting>,
}

/// Deterministic, filesystem-safe filename for an id. Clean ids map to
/// themselves; ids with special chars (`cc:…`) get sanitized + a hash suffix
/// so two distinct ids can never collide on the sanitized form.
pub fn safe_name(id: &str) -> String {
    let clean: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    if clean == id {
        return id.to_string();
    }
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("{clean}-{}", &hash[..8])
}

// --- memory file (frontmatter + body) ---------------------------------------

pub fn serialize_memory(m: &FullMemoryRow) -> String {
    let opt = |v: &Option<String>| v.clone().unwrap_or_else(|| "~".into());
    let conf = m
        .confidence
        .map(|c| {
            if c.fract() == 0.0 { format!("{}", c as i64) } else { format!("{c}") }
        })
        .unwrap_or_else(|| "~".into());
    format!(
        "---\nid: {}\nspace: {}\nscope: {}\ntype: {}\nstatus: {}\nconfidence: {}\npinned: {}\nsource_hash: {}\ncreated_at: {}\nedited_at: {}\n---\n{}\n",
        m.id,
        opt(&m.space_id),
        m.scope,
        m.mtype,
        m.status,
        conf,
        m.pinned,
        m.source_hash.clone().unwrap_or_default(),
        m.created_at,
        m.edited_at,
        m.content
    )
}

/// Defensive parse — never poison the store. Returns None on anything
/// malformed, or when the body is encrypted (no cipher support yet).
pub fn parse_memory_file(raw: &str) -> Option<FullMemoryRow> {
    let rest = raw.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let front = &rest[..end];
    let mut body = &rest[end + 4..];
    if let Some(stripped) = body.strip_prefix('\n') {
        body = stripped;
    }
    let body = body.trim_end_matches('\n');

    let field = |key: &str| -> Option<String> {
        front.lines().find_map(|l| {
            let l = l.trim();
            let value = l.strip_prefix(key)?.trim_start();
            let value = value.strip_prefix(':')?;
            Some(value.trim().to_string())
        })
    };
    let num = |key: &str| -> Option<i64> {
        let v = field(key)?;
        if v == "~" {
            return None;
        }
        v.parse::<f64>().ok().map(|n| n as i64)
    };

    let id = field("id").filter(|s| !s.is_empty())?;
    let created_at = num("created_at")?;
    let edited_at = num("edited_at")?;

    if body.starts_with(ENC_PREFIX) {
        return None; // encrypted bodies unsupported in the native app (yet)
    }
    let content = body.trim();
    if content.is_empty() {
        return None;
    }

    let status = field("status").unwrap_or_else(|| "active".into());
    if !MEMORY_STATUSES.contains(&status.as_str()) {
        return None;
    }
    let mtype = field("type").unwrap_or_else(|| "fact".into());
    let mtype = if MEMORY_TYPES.contains(&mtype.as_str()) { mtype } else { "fact".into() };
    let space = field("space");
    let confidence = field("confidence")
        .filter(|v| v != "~")
        .and_then(|v| v.parse::<f64>().ok());

    Some(FullMemoryRow {
        id,
        space_id: space.filter(|s| s != "~" && !s.is_empty()),
        scope: field("scope").filter(|s| !s.is_empty()).unwrap_or_else(|| "global".into()),
        mtype,
        content: content.to_string(),
        confidence,
        status,
        pinned: field("pinned").as_deref() == Some("true"),
        source_hash: field("source_hash").filter(|s| !s.is_empty()),
        created_at,
        edited_at,
    })
}

// --- export: DB -> deterministic file tree -----------------------------------

fn json_space(s: &SyncedSpace) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "id": s.id, "name": s.name, "icon": s.icon,
        "sortOrder": s.sort_order, "createdAt": s.created_at, "updatedAt": s.updated_at,
    }))
    .unwrap_or_default()
        + "\n"
}

fn json_tombstone(t: &TombstoneRow) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "fingerprint": t.fingerprint, "scope": t.scope, "spaceId": t.space_id,
        "reason": t.reason, "createdAt": t.created_at, "createdBy": t.created_by,
    }))
    .unwrap_or_default()
        + "\n"
}

/// BTreeMap keeps the tree ordering deterministic.
pub fn export_tree(db: &Db) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    files.insert(
        "zede.json".to_string(),
        serde_json::to_string_pretty(&serde_json::json!({
            "formatVersion": FORMAT_VERSION, "encryption": "none",
        }))
        .unwrap_or_default()
            + "\n",
    );

    // Memories — every status; belt-and-braces redaction on the way out.
    let mut memories = db.all_memories_sync();
    memories.sort_by(|a, b| a.id.cmp(&b.id));
    for m in &memories {
        let mut m = m.clone();
        m.content = redact::redact(&m.content).text;
        files.insert(format!("memories/{}.md", safe_name(&m.id)), serialize_memory(&m));
    }

    // Tombstones — one file per fingerprint; latest decision wins.
    let mut by_fp: BTreeMap<String, TombstoneRow> = BTreeMap::new();
    for t in db.all_tombstones() {
        match by_fp.get(&t.fingerprint) {
            Some(prev) if prev.created_at >= t.created_at => {}
            _ => {
                by_fp.insert(t.fingerprint.clone(), t);
            }
        }
    }
    for (fp, t) in &by_fp {
        files.insert(format!("tombstones/{}.json", safe_name(fp)), json_tombstone(t));
    }

    let mut spaces = db.list_spaces();
    spaces.sort_by(|a, b| a.id.cmp(&b.id));
    for s in &spaces {
        let synced = SyncedSpace {
            id: s.id.clone(),
            name: s.name.clone(),
            icon: s.icon.clone(),
            sort_order: s.sort_order,
            created_at: s.created_at,
            updated_at: s.updated_at,
        };
        files.insert(format!("spaces/{}.json", safe_name(&s.id)), json_space(&synced));
    }

    let mut settings = serde_json::Map::new();
    for key in SYNCED_SETTINGS {
        if let Some((value, updated_at)) = db.get_setting_row(key) {
            settings.insert(
                (*key).to_string(),
                serde_json::json!({ "value": value, "editedAt": updated_at }),
            );
        }
    }
    files.insert(
        "settings.json".to_string(),
        serde_json::to_string_pretty(&serde_json::Value::Object(settings)).unwrap_or_default() + "\n",
    );

    files
}

// --- import: file tree -> structured, validated SyncTree ---------------------

/// Parse a pulled tree. Corrupt or foreign files are skipped, never fatal.
/// Err on a newer format version or an encrypted repo (both need a newer /
/// fuller app, not silent data loss).
pub fn parse_tree(files: &BTreeMap<String, String>) -> Result<(SyncTree, usize), String> {
    let mut encryption = Encryption::None;
    if let Some(raw) = files.get("zede.json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(found) = v.get("formatVersion").and_then(|f| f.as_i64()) {
                if found > FORMAT_VERSION {
                    return Err(format!(
                        "sync repo uses format v{found}; this app supports up to v{FORMAT_VERSION} — update the app to sync"
                    ));
                }
            }
            if v.get("encryption").and_then(|e| e.as_str()) == Some("aes-256-gcm") {
                encryption = Encryption::Aes256Gcm;
            }
        }
    }
    if encryption == Encryption::Aes256Gcm {
        return Err(
            "this sync repo is encrypted; the native app doesn't support encrypted repos yet".into(),
        );
    }

    let mut tree = SyncTree {
        encryption,
        memories: Vec::new(),
        tombstones: Vec::new(),
        spaces: Vec::new(),
        settings: BTreeMap::new(),
    };
    let mut skipped = 0usize;

    for (path, raw) in files {
        if path.starts_with("memories/") && path.ends_with(".md") {
            match parse_memory_file(raw) {
                Some(m) => tree.memories.push(m),
                None => skipped += 1,
            }
        } else if path.starts_with("tombstones/") && path.ends_with(".json") {
            let parsed: Option<TombstoneRow> = serde_json::from_str::<serde_json::Value>(raw)
                .ok()
                .and_then(|v| {
                    Some(TombstoneRow {
                        fingerprint: v.get("fingerprint")?.as_str()?.to_string(),
                        scope: v.get("scope").and_then(|s| s.as_str()).map(String::from),
                        space_id: v.get("spaceId").and_then(|s| s.as_str()).map(String::from),
                        reason: v.get("reason").and_then(|s| s.as_str()).map(String::from),
                        created_at: v.get("createdAt")?.as_i64()?,
                        created_by: v.get("createdBy").and_then(|s| s.as_str()).map(String::from),
                    })
                });
            match parsed {
                Some(t) => tree.tombstones.push(t),
                None => skipped += 1,
            }
        } else if path.starts_with("spaces/") && path.ends_with(".json") {
            let parsed: Option<SyncedSpace> = serde_json::from_str::<serde_json::Value>(raw)
                .ok()
                .and_then(|v| {
                    Some(SyncedSpace {
                        id: v.get("id")?.as_str()?.to_string(),
                        name: v.get("name")?.as_str()?.to_string(),
                        icon: v.get("icon").and_then(|s| s.as_str()).map(String::from),
                        sort_order: v.get("sortOrder").and_then(|s| s.as_i64()).unwrap_or(0),
                        created_at: v.get("createdAt").and_then(|s| s.as_i64()).unwrap_or(0),
                        updated_at: v.get("updatedAt").and_then(|s| s.as_i64()).unwrap_or(0),
                    })
                });
            match parsed {
                Some(s) => tree.spaces.push(s),
                None => skipped += 1,
            }
        } else if path == "settings.json" {
            match serde_json::from_str::<serde_json::Value>(raw).ok().and_then(|v| v.as_object().cloned()) {
                Some(obj) => {
                    for (k, v) in obj {
                        let (Some(value), Some(edited_at)) = (
                            v.get("value").and_then(|x| x.as_str()),
                            v.get("editedAt").and_then(|x| x.as_i64()),
                        ) else {
                            continue;
                        };
                        tree.settings.insert(k, SyncedSetting { value: value.to_string(), edited_at });
                    }
                }
                None => skipped += 1,
            }
        }
        // zede.json handled above; anything else (links/, membership.json,
        // README…) is preserved on disk and ignored here.
    }
    Ok((tree, skipped))
}
