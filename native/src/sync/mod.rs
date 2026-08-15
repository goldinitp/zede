//! User-owned git-backed sync (P7), ported from `src/main/sync/service.ts`.
//! Cycle order is load-bearing: fetch → import → export → commit → push.
//! The working copy lives in a directory literally named `sync` (the
//! hard-reset guard depends on it) and is regenerable from the DB at any time.
//!
//! Auth modes ported: `git` (whatever credentials git already has — ssh, a
//! NAS, a local bare repo) and `gh-cli`. The GitHub-App device flow needs a
//! registered client id and stays with the Electron app for now.

pub mod format;
pub mod git;
pub mod merge;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::db::Db;
use merge::ImportCounts;

pub const META_ENABLED: &str = "sync_enabled";
pub const META_AUTH_MODE: &str = "sync_auth_mode";
pub const META_REMOTE_URL: &str = "sync_remote_url";
pub const META_LAST_AT: &str = "sync_last_at";
pub const META_LAST_RESULT: &str = "sync_last_result";

const MAX_FILE: u64 = 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct SyncResult {
    pub ok: bool,
    pub error: Option<String>,
    /// Fetch/push failed but the local commit is safe — it ships next sync.
    pub offline: bool,
    pub pushed: bool,
    pub counts: ImportCounts,
    pub skipped: usize,
}

fn fail(msg: impl Into<String>) -> SyncResult {
    SyncResult { ok: false, error: Some(msg.into()), ..Default::default() }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn hostname() -> String {
    let mut buf = [0u8; 256];
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
    if !ok {
        return "zede".into();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(not(unix))]
fn hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "zede".into())
}

pub struct SyncStatus {
    pub configured: bool,
    #[allow(dead_code)] // richer status panel (P7 continuation)
    pub auth_mode: String,
    #[allow(dead_code)]
    pub remote_url: Option<String>,
    #[allow(dead_code)]
    pub last_at: Option<i64>,
    pub last_result: Option<String>,
}

pub fn status(db: &Db) -> SyncStatus {
    SyncStatus {
        configured: db.meta_get(META_ENABLED).as_deref() == Some("1"),
        auth_mode: db.meta_get(META_AUTH_MODE).unwrap_or_else(|| "git".into()),
        remote_url: db.meta_get(META_REMOTE_URL),
        last_at: db.meta_get(META_LAST_AT).and_then(|v| v.parse().ok()),
        last_result: db.meta_get(META_LAST_RESULT),
    }
}

pub fn setup(db: &Db, data_root: &Path, remote_url: &str, auth_mode: &str) -> SyncResult {
    let url = remote_url.trim();
    if url.is_empty() {
        return fail("enter a git remote URL (GitHub, GitLab, a NAS over ssh, or a local bare repo)");
    }
    if !git::git_available() {
        return fail("git is not installed");
    }
    db.meta_set(META_REMOTE_URL, url);
    db.meta_set(META_AUTH_MODE, if auth_mode == "gh-cli" { "gh-cli" } else { "git" });
    db.meta_set(META_ENABLED, "1");
    sync_now(db, data_root)
}

pub fn disconnect(db: &Db) {
    db.meta_set(META_ENABLED, "0");
    db.meta_set(META_LAST_RESULT, "disconnected");
}

pub fn sync_now(db: &Db, data_root: &Path) -> SyncResult {
    if db.meta_get(META_ENABLED).as_deref() != Some("1") {
        return fail("sync is not set up yet");
    }
    if !git::git_available() {
        return fail("git is not installed");
    }
    let res = cycle(db, &data_root.join("sync"));
    db.meta_set(META_LAST_AT, &now_ms().to_string());
    let summary = res
        .error
        .clone()
        .unwrap_or_else(|| summarize(&res));
    db.meta_set(META_LAST_RESULT, &summary);
    res
}

fn auth_of(db: &Db) -> git::GitAuth {
    if db.meta_get(META_AUTH_MODE).as_deref() == Some("gh-cli") {
        git::GitAuth::GhCli
    } else {
        git::GitAuth::Git
    }
}

fn cycle(db: &Db, dir: &PathBuf) -> SyncResult {
    let Some(remote_url) = db.meta_get(META_REMOTE_URL) else {
        return fail("sync remote is missing — set up sync again");
    };
    if std::fs::create_dir_all(dir).is_err() {
        return fail("could not create the sync directory");
    }
    if let Some(err) = git::ensure_repo(dir, &remote_url) {
        return fail(err);
    }
    let auth = auth_of(db);

    let mut counts = ImportCounts::default();
    let mut skipped = 0usize;

    for attempt in 1..=3 {
        let mut offline = false;
        match git::fetch_main(dir, auth) {
            git::FetchOutcome::Ok => {
                match git::reset_to_remote(dir) {
                    Ok(true) => {}
                    Ok(false) => return fail("git reset failed"),
                    Err(e) => return fail(e),
                }
                let files = read_tree_files(dir);
                let (tree, skip) = match format::parse_tree(&files) {
                    Ok(v) => v,
                    Err(e) => return fail(e),
                };
                skipped = skip;
                let res = merge::import_tree(db, &tree, now_ms());
                counts = add_counts(counts, res);
            }
            git::FetchOutcome::NoRemoteBranch => {}
            git::FetchOutcome::Offline => offline = true,
        }

        let exported = format::export_tree(db);
        write_tree_files(dir, &exported);
        let committed = match git::commit_all(dir, &format!("sync {} {}", hostname(), now_ms())) {
            Ok(c) => c,
            Err(e) => return fail(format!("git commit failed: {e}")),
        };

        if offline {
            return SyncResult { ok: true, offline: true, counts, skipped, ..Default::default() };
        }
        match git::push(dir, auth) {
            git::PushOutcome::Ok => {
                return SyncResult { ok: true, pushed: committed, counts, skipped, ..Default::default() }
            }
            git::PushOutcome::Offline => {
                return SyncResult { ok: true, offline: true, counts, skipped, ..Default::default() }
            }
            git::PushOutcome::Auth => {
                return fail("git authentication failed — check your credentials")
            }
            git::PushOutcome::Rejected => {
                // Another machine pushed between our fetch and push — loop
                // pulls + remerges.
                if attempt == 3 {
                    return fail("another machine is syncing right now — try again in a moment");
                }
            }
        }
    }
    unreachable!("bounded retry loop");
}

fn add_counts(a: ImportCounts, b: ImportCounts) -> ImportCounts {
    ImportCounts {
        memories_added: a.memories_added + b.memories_added,
        memories_updated: a.memories_updated + b.memories_updated,
        tombstones_added: a.tombstones_added + b.tombstones_added,
        tombstones_applied: a.tombstones_applied + b.tombstones_applied,
        spaces_changed: a.spaces_changed + b.spaces_changed,
        settings_changed: a.settings_changed + b.settings_changed,
    }
}

pub fn summarize(res: &SyncResult) -> String {
    let c = &res.counts;
    let mut bits: Vec<String> = Vec::new();
    if res.pushed {
        bits.push("pushed".into());
    }
    if c.memories_added > 0 {
        bits.push(format!("{} new", c.memories_added));
    }
    if c.memories_updated > 0 {
        bits.push(format!("{} updated", c.memories_updated));
    }
    if c.tombstones_applied > 0 {
        bits.push(format!("{} forgotten", c.tombstones_applied));
    }
    if c.spaces_changed > 0 {
        bits.push(format!("{} spaces", c.spaces_changed));
    }
    if c.settings_changed > 0 {
        bits.push(format!("{} settings", c.settings_changed));
    }
    if res.offline {
        bits.push("offline — will push next sync".into());
    }
    if res.skipped > 0 {
        bits.push(format!("{} files skipped", res.skipped));
    }
    if bits.is_empty() {
        "up to date".into()
    } else {
        bits.join(" · ")
    }
}

// --- managed file IO ---------------------------------------------------------

const MANAGED_DIRS: &[&str] = &["memories", "tombstones", "spaces"];
const MANAGED_FILES: &[&str] = &["zede.json", "settings.json"];

fn read_tree_files(dir: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let mut read_one = |rel: String| {
        let full = dir.join(&rel);
        let Ok(meta) = std::fs::metadata(&full) else { return };
        if !meta.is_file() || meta.len() > MAX_FILE {
            return;
        }
        if let Ok(content) = std::fs::read_to_string(&full) {
            files.insert(rel, content);
        }
    };
    for name in MANAGED_FILES {
        read_one((*name).to_string());
    }
    for sub in MANAGED_DIRS {
        let Ok(entries) = std::fs::read_dir(dir.join(sub)) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            read_one(format!("{sub}/{name}"));
        }
    }
    files
}

/// Write managed files that changed; delete managed files no longer exported.
/// Unmanaged paths (links/, membership.json, README…) are never touched.
fn write_tree_files(dir: &Path, files: &BTreeMap<String, String>) -> usize {
    let mut changed = 0usize;
    for (rel, content) in files {
        let full = dir.join(rel);
        if let Some(parent) = full.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let same = std::fs::read_to_string(&full).map(|c| c == *content).unwrap_or(false);
        if !same && std::fs::write(&full, content).is_ok() {
            changed += 1;
        }
    }
    for sub in MANAGED_DIRS {
        let Ok(entries) = std::fs::read_dir(dir.join(sub)) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = format!("{sub}/{name}");
            if !files.contains_key(&rel) {
                let _ = std::fs::remove_file(dir.join(&rel));
                changed += 1;
            }
        }
    }
    changed
}
