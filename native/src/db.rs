//! SQLite-backed app state: spaces, tabs, settings, meta. Single writer (the
//! UI thread); SQLite is compiled into the binary via rusqlite's bundled
//! feature, so there is no native-module ABI story at all.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::pty::TabKind;

pub struct Db {
    conn: Connection,
}

#[derive(Clone, Debug)]
pub struct SpaceRow {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    #[allow(dead_code)] // used by drag reordering (P5)
    pub sort_order: i64,
    pub is_default: bool,
}

#[derive(Clone, Debug)]
pub struct MemoryRow {
    pub id: String,
    #[allow(dead_code)] // space badge in detail view (P6 continuation)
    pub space_id: Option<String>,
    pub scope: String,
    pub mtype: String,
    pub content: String,
    pub pinned: bool,
    #[allow(dead_code)] // shown in detail view (P6 continuation)
    pub created_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub spaces: usize,
    pub memories: usize,
    pub tombstones: usize,
    pub skipped: usize,
}

#[derive(Clone, Debug)]
pub struct TabRow {
    pub id: String,
    #[allow(dead_code)] // used by tab move/duplicate (P5)
    pub space_id: String,
    pub kind: TabKind,
    pub title: String,
    pub cwd: String,
    pub pinned: bool,
    #[allow(dead_code)] // used by drag reordering (P5)
    pub sort_order: i64,
    pub last_session_id: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const LATEST_VERSION: i64 = 2;

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL,
  last_session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tabs_space ON tabs(space_id, sort_order);
";

// Memory layer, column-compatible with the Electron app's `memories` and
// `tombstones` tables (schema v6 shape) so import is 1:1 and future sync
// round-trips. Tombstones are append-only; never destructively migrated.
const SCHEMA_V2: &str = "
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  space_id TEXT, scope TEXT NOT NULL,
  type TEXT NOT NULL, content TEXT NOT NULL,
  confidence REAL, salience REAL,
  status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT,
  created_at INTEGER, updated_at INTEGER, edited_at INTEGER, last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_space_status ON memories(space_id, status);
CREATE TABLE IF NOT EXISTS tombstones (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  scope TEXT, space_id TEXT, reason TEXT,
  created_at INTEGER, created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_tombstones_fingerprint ON tombstones(fingerprint);
";

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        // Never touch a database we don't own (e.g. the Electron app's db,
        // which is at schema version 6+ with different tables). Refusing
        // beats silent misbehavior. The table check below closes the gap for
        // files that happen to share a low version number.
        if version > LATEST_VERSION {
            return Err(format!(
                "database has schema version {version} (ours is {LATEST_VERSION}) — \
                 this looks like another app's file; refusing to modify it"
            ));
        }
        if version >= 1 && !self.has_table("spaces").unwrap_or(false) {
            return Err("database is missing zede tables — not a zede-native db".to_string());
        }
        let steps: &[(i64, &str)] = &[(1, SCHEMA_V1), (2, SCHEMA_V2)];
        for (v, sql) in steps {
            if version < *v {
                self.conn.execute_batch(sql).map_err(|e| e.to_string())?;
                self.conn
                    .pragma_update(None, "user_version", *v)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn has_table(&self, name: &str) -> Result<bool, String> {
        let n: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    // --- settings / meta ---------------------------------------------------

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) {
        self.conn
            .execute(
                "INSERT INTO settings(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .ok();
    }

    pub fn meta_get(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .ok()
    }

    pub fn meta_set(&self, key: &str, value: &str) {
        self.conn
            .execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .ok();
    }

    // --- spaces ------------------------------------------------------------

    pub fn list_spaces(&self) -> Vec<SpaceRow> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, name, icon, sort_order, is_default FROM spaces ORDER BY sort_order, created_at",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok(SpaceRow {
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                sort_order: r.get(3)?,
                is_default: r.get::<_, i64>(4)? != 0,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn create_space(&self, name: &str, icon: Option<&str>) -> SpaceRow {
        let id = Uuid::new_v4().to_string();
        let sort: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM spaces", [], |r| r.get(0))
            .unwrap_or(1);
        self.conn
            .execute(
                "INSERT INTO spaces(id, name, icon, sort_order, is_default, created_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![id, name, icon, sort, now_ms()],
            )
            .ok();
        SpaceRow {
            id,
            name: name.to_string(),
            icon: icon.map(str::to_string),
            sort_order: sort,
            is_default: false,
        }
    }

    pub fn rename_space(&self, id: &str, name: &str) {
        self.conn
            .execute("UPDATE spaces SET name = ?2 WHERE id = ?1", params![id, name])
            .ok();
    }

    pub fn delete_space(&self, id: &str) {
        self.conn.execute("DELETE FROM spaces WHERE id = ?1", [id]).ok();
    }

    pub fn set_default_space(&self, id: &str) {
        self.conn.execute("UPDATE spaces SET is_default = 0", []).ok();
        self.conn
            .execute("UPDATE spaces SET is_default = 1 WHERE id = ?1", [id])
            .ok();
    }

    // --- tabs --------------------------------------------------------------

    pub fn list_tabs(&self, space_id: &str) -> Vec<TabRow> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, space_id, kind, title, cwd, pinned, sort_order, last_session_id
             FROM tabs WHERE space_id = ?1 ORDER BY sort_order, created_at",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([space_id], |r| {
            Ok(TabRow {
                id: r.get(0)?,
                space_id: r.get(1)?,
                kind: TabKind::from_str(&r.get::<_, String>(2)?),
                title: r.get(3)?,
                cwd: r.get(4)?,
                pinned: r.get::<_, i64>(5)? != 0,
                sort_order: r.get(6)?,
                last_session_id: r.get(7)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn create_tab(&self, space_id: &str, kind: TabKind, title: &str, cwd: &str) -> TabRow {
        let id = Uuid::new_v4().to_string();
        let sort: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tabs WHERE space_id = ?1",
                [space_id],
                |r| r.get(0),
            )
            .unwrap_or(1);
        self.conn
            .execute(
                "INSERT INTO tabs(id, space_id, kind, title, cwd, pinned, sort_order, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
                params![id, space_id, kind.as_str(), title, cwd, sort, now_ms()],
            )
            .ok();
        TabRow {
            id,
            space_id: space_id.to_string(),
            kind,
            title: title.to_string(),
            cwd: cwd.to_string(),
            pinned: false,
            sort_order: sort,
            last_session_id: None,
        }
    }

    pub fn delete_tab(&self, id: &str) {
        self.conn.execute("DELETE FROM tabs WHERE id = ?1", [id]).ok();
    }

    pub fn rename_tab(&self, id: &str, title: &str) {
        self.conn
            .execute("UPDATE tabs SET title = ?2 WHERE id = ?1", params![id, title])
            .ok();
    }

    pub fn set_tab_pinned(&self, id: &str, pinned: bool) {
        self.conn
            .execute(
                "UPDATE tabs SET pinned = ?2 WHERE id = ?1",
                params![id, pinned as i64],
            )
            .ok();
    }

    pub fn set_tab_last_session(&self, id: &str, session_id: &str) {
        self.conn
            .execute(
                "UPDATE tabs SET last_session_id = ?2 WHERE id = ?1",
                params![id, session_id],
            )
            .ok();
    }

    // --- memories -----------------------------------------------------------

    /// Active memories visible to a Space (its own + global rows), pinned
    /// first, most recently edited first. Capped like the Electron sidebar.
    pub fn list_memories(&self, space_id: &str) -> Vec<MemoryRow> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, space_id, scope, type, content, pinned, created_at
             FROM memories
             WHERE (space_id = ?1 OR space_id IS NULL) AND status = 'active'
             ORDER BY pinned DESC, COALESCE(edited_at, updated_at, created_at) DESC
             LIMIT 500",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([space_id], |r| {
            Ok(MemoryRow {
                id: r.get(0)?,
                space_id: r.get(1)?,
                scope: r.get(2)?,
                mtype: r.get(3)?,
                content: r.get(4)?,
                pinned: r.get::<_, i64>(5)? != 0,
                created_at: r.get(6)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn insert_memory(
        &self,
        space_id: Option<&str>,
        scope: &str,
        mtype: &str,
        content: &str,
    ) -> String {
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        self.conn
            .execute(
                "INSERT INTO memories(id, space_id, scope, type, content, status, pinned,
                                      use_count, created_at, updated_at, edited_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', 0, 0, ?6, ?6, ?6)",
                params![id, space_id, scope, mtype, content, now],
            )
            .ok();
        id
    }

    pub fn set_memory_pinned(&self, id: &str, pinned: bool) {
        self.conn
            .execute(
                "UPDATE memories SET pinned = ?2, edited_at = ?3 WHERE id = ?1",
                params![id, pinned as i64, now_ms()],
            )
            .ok();
    }

    /// Soft delete: status -> tombstoned plus an append-only tombstone row so
    /// the memory can never silently return (via sync, re-import or
    /// re-extraction).
    pub fn forget_memory(&self, id: &str, reason: &str) {
        let row: Option<(Option<String>, String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT space_id, scope, source_hash FROM memories WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        let Some((space_id, scope, source_hash)) = row else { return };
        let now = now_ms();
        self.conn
            .execute(
                "UPDATE memories SET status = 'tombstoned', edited_at = ?2 WHERE id = ?1",
                params![id, now],
            )
            .ok();
        let fingerprint = source_hash.unwrap_or_else(|| id.to_string());
        self.conn
            .execute(
                "INSERT INTO tombstones(id, fingerprint, scope, space_id, reason, created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'native')",
                params![Uuid::new_v4().to_string(), fingerprint, scope, space_id, reason, now],
            )
            .ok();
    }

    pub fn tombstone_count(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM tombstones", [], |r| r.get(0))
            .unwrap_or(0)
    }

    // --- Electron import ----------------------------------------------------

    /// One-way, read-only import from the Electron app's database (schema v6+):
    /// spaces, non-tombstoned memories, and the tombstone ledger. Idempotent —
    /// everything inserts by original id with OR IGNORE.
    pub fn import_from_electron(&self, source: &Path) -> Result<ImportReport, String> {
        let src = Connection::open_with_flags(
            source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("open {}: {e}", source.display()))?;

        let src_version: i64 = src
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if src_version < 6 {
            return Err(format!(
                "Electron db is schema v{src_version}; run the Electron app once to upgrade it to v6+"
            ));
        }

        let mut report = ImportReport::default();
        self.conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            // Spaces first so imported memories keep their space grouping.
            let mut stmt = src
                .prepare("SELECT id, name, icon, COALESCE(sort_order, 0), COALESCE(created_at, 0) FROM spaces")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.filter_map(Result::ok) {
                let (id, name, icon, sort, created) = row;
                let n = self
                    .conn
                    .execute(
                        "INSERT OR IGNORE INTO spaces(id, name, icon, sort_order, is_default, created_at)
                         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                        params![id, name, icon, sort + 100, created],
                    )
                    .map_err(|e| e.to_string())?;
                report.spaces += n;
            }

            let mut stmt = src
                .prepare(
                    "SELECT id, space_id, scope, type, content, confidence, salience, status,
                            COALESCE(pinned, 0), COALESCE(use_count, 0), source_hash,
                            created_at, updated_at, edited_at, last_used_at
                     FROM memories",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<f64>>(5)?,
                        r.get::<_, Option<f64>>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, i64>(8)?,
                        r.get::<_, i64>(9)?,
                        r.get::<_, Option<String>>(10)?,
                        r.get::<_, Option<i64>>(11)?,
                        r.get::<_, Option<i64>>(12)?,
                        r.get::<_, Option<i64>>(13)?,
                        r.get::<_, Option<i64>>(14)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.filter_map(Result::ok) {
                let (id, space_id, scope, mtype, content, confidence, salience, status,
                     pinned, use_count, source_hash, created, updated, edited, last_used) = row;
                if status == "tombstoned" {
                    report.skipped += 1;
                    continue;
                }
                let n = self
                    .conn
                    .execute(
                        "INSERT OR IGNORE INTO memories(id, space_id, scope, type, content,
                             confidence, salience, status, pinned, use_count, source_hash,
                             created_at, updated_at, edited_at, last_used_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                        params![id, space_id, scope, mtype, content, confidence, salience,
                                status, pinned, use_count, source_hash, created, updated,
                                edited, last_used],
                    )
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    report.skipped += 1;
                } else {
                    report.memories += n;
                }
            }

            let mut stmt = src
                .prepare(
                    "SELECT id, fingerprint, scope, space_id, reason, created_at, created_by
                     FROM tombstones",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<i64>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.filter_map(Result::ok) {
                let (id, fp, scope, space_id, reason, created, by) = row;
                let n = self
                    .conn
                    .execute(
                        "INSERT OR IGNORE INTO tombstones(id, fingerprint, scope, space_id, reason, created_at, created_by)
                         VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        params![id, fp, scope, space_id, reason, created, by],
                    )
                    .map_err(|e| e.to_string())?;
                report.tombstones += n;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(report)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// First run: one Space with one claude tab in the user's home directory.
    pub fn ensure_seed(&self) {
        if !self.list_spaces().is_empty() {
            return;
        }
        let home = dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());
        let space = self.create_space("Default", None);
        self.set_default_space(&space.id);
        self.create_tab(&space.id, TabKind::Claude, "Claude", &home);
        self.meta_set("active_space", &space.id);
    }
}
