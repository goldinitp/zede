export interface Migration {
  version: number
  sql: string
}

// Ordered, append-only. Driven by PRAGMA user_version. tombstones + audit_log
// must NEVER be destructively migrated (spec §11). Inlined as strings so the
// bundled Electron main needs no runtime file resolution.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: /* sql */ `
      -- Spatial layer ---------------------------------------------------------
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT,
        settings_json TEXT, sort_order INTEGER, created_at INTEGER
      );
      CREATE TABLE tabs (
        id TEXT PRIMARY KEY,
        space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
        kind TEXT, title TEXT, cwd TEXT,
        pinned INTEGER DEFAULT 0, sort_order INTEGER,
        created_at INTEGER, last_active_at INTEGER
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        tab_id TEXT REFERENCES tabs(id) ON DELETE CASCADE,
        cc_session_id TEXT, transcript_path TEXT,
        started_at INTEGER, ended_at INTEGER, status TEXT
      );
      CREATE TABLE transcript_watermarks (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        last_offset INTEGER, last_processed_at INTEGER
      );

      -- Memory layer ----------------------------------------------------------
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        space_id TEXT, scope TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL,
        confidence REAL, salience REAL,
        status TEXT NOT NULL, pinned INTEGER DEFAULT 0, use_count INTEGER DEFAULT 0,
        source_hash TEXT,
        created_at INTEGER, updated_at INTEGER, last_used_at INTEGER
      );
      CREATE INDEX idx_memories_space_status ON memories(space_id, status);
      CREATE INDEX idx_memories_hash ON memories(source_hash);

      CREATE TABLE memory_sources (
        memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        session_id TEXT, transcript_path TEXT,
        span_start INTEGER, span_end INTEGER, excerpt TEXT
      );
      CREATE INDEX idx_memory_sources_memory ON memory_sources(memory_id);

      -- Forgetting layer ------------------------------------------------------
      CREATE TABLE tombstones (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        scope TEXT, space_id TEXT, reason TEXT,
        created_at INTEGER, created_by TEXT
      );
      CREATE INDEX idx_tombstones_fingerprint ON tombstones(fingerprint);

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, ts INTEGER, action TEXT,
        target_type TEXT, target_id TEXT, detail_json TEXT
      );

      -- Lexical search (external-content FTS5 over memories.content) ----------
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `
  },
  {
    // M2: spatial model + closed loop. Adds tab ordering helpers, terminal
    // snapshots (state/history restore, not live PIDs — spec §8), and an
    // app-level key/value store (active space, injection adapter, tiers — §13.1).
    version: 2,
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS idx_tabs_space_order ON tabs(space_id, pinned DESC, sort_order);

      -- Visual restore on launch: scrollback + geometry + cwd per tab (§8).
      CREATE TABLE pty_snapshots (
        tab_id TEXT PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
        cwd TEXT, scrollback TEXT, cols INTEGER, rows INTEGER, updated_at INTEGER
      );

      -- App/runtime settings (active space, injection adapter, extraction tier…).
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    `
  },
  {
    // M3: semantic tier. Embeddings (brute-force cosine; sqlite-vec deferred to a
    // signed build) + typed links for supersede/conflict (spec §6.3, §13.2).
    version: 3,
    sql: /* sql */ `
      CREATE TABLE memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT, dim INTEGER, vec BLOB, created_at INTEGER
      );

      CREATE TABLE memory_links (
        id TEXT PRIMARY KEY,
        src_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        dst_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        rel TEXT, created_at INTEGER
      );
      CREATE INDEX idx_memory_links_src ON memory_links(src_id);
      CREATE INDEX idx_memory_links_dst ON memory_links(dst_id);
    `
  },
  {
    // M4: edit history (diff view) + multi-Space membership (spec §11, §13.3).
    version: 4,
    sql: /* sql */ `
      CREATE TABLE memory_edits (
        id TEXT PRIMARY KEY,
        memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        before TEXT, after TEXT, edited_at INTEGER, edited_by TEXT
      );
      CREATE INDEX idx_memory_edits_memory ON memory_edits(memory_id);

      CREATE TABLE space_membership (
        memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
        PRIMARY KEY (memory_id, space_id)
      );
      CREATE INDEX idx_space_membership_space ON space_membership(space_id);
    `
  },
  {
    // M5: memory-detail tabs. A tab can now display a single memory (kind
    // 'memory'); `ref` holds that memory's id. NULL for claude/shell tabs.
    version: 5,
    sql: /* sql */ `
      ALTER TABLE tabs ADD COLUMN ref TEXT;
    `
  },
  {
    // M6: sync clocks. `edited_at` is the last-write-wins clock for cross-machine
    // sync: it moves only on durable mutations (edit/pin/status/tombstone/mirror),
    // never on salience decay or use bumps — `updated_at` is bumped by every
    // launch's maintenance pass, so LWW on it would mean "most recently launched
    // machine wins". Spaces and settings get their own LWW clocks.
    version: 6,
    sql: /* sql */ `
      ALTER TABLE memories ADD COLUMN edited_at INTEGER;
      UPDATE memories SET edited_at = updated_at;
      ALTER TABLE spaces ADD COLUMN updated_at INTEGER;
      UPDATE spaces SET updated_at = created_at;
      ALTER TABLE app_settings ADD COLUMN updated_at INTEGER;
    `
  }
]
