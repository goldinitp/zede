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
        const SCHEMA_VERSION: i64 = 1;
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        // Never touch a database we don't own (e.g. the Electron app's db,
        // which is at schema version 6+). Refusing beats silent misbehavior.
        if version > SCHEMA_VERSION {
            return Err(format!(
                "database has schema version {version} (ours is {SCHEMA_VERSION}) — \
                 this looks like another app's file; refusing to modify it"
            ));
        }
        if version < 1 {
            self.conn.execute_batch(SCHEMA_V1).map_err(|e| e.to_string())?;
            self.conn
                .pragma_update(None, "user_version", 1)
                .map_err(|e| e.to_string())?;
        }
        let has_spaces: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='spaces'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_spaces == 0 {
            return Err("database is missing zede tables — not a zede-native db".to_string());
        }
        Ok(())
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
