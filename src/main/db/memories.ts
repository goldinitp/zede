import type { DB } from './database'
import type { ForgottenItem, Memory, MemoryType, Scope, Space, Tab, TabKind } from '../../shared/api'

export interface MemoryRow {
  id: string
  space_id: string | null
  scope: Scope
  type: MemoryType
  content: string
  confidence: number | null
  salience: number | null
  status: string
  pinned: number
  use_count: number
  source_hash: string
  created_at: number
  updated_at: number
  edited_at: number | null
  last_used_at: number | null
}

export interface InsertMemoryParams {
  id: string
  spaceId: string | null
  scope: Scope
  type: MemoryType
  content: string
  confidence: number
  salience: number
  sourceHash: string
  now: number
}

export interface InsertSourceParams {
  memoryId: string
  sessionId: string
  transcriptPath: string
  spanStart: number
  spanEnd: number
  excerpt: string
}

export interface TombstoneRow {
  id: string
  fingerprint: string
  scope: string | null
  space_id: string | null
  reason: string | null
  created_at: number
  created_by: string | null
}

export interface LinkRow {
  id: string
  src_id: string
  dst_id: string
  rel: string
  created_at: number
}

export interface InsertSessionParams {
  id: string
  tabId: string | null
  ccSessionId: string
  transcriptPath: string
  startedAt: number
  status: string
}

/** All DB access for the memory + spatial tables. Single writer (Core). */
export class MemoryRepo {
  constructor(private readonly db: DB) {}

  transaction(fn: () => void): () => void {
    return this.db.transaction(fn)
  }

  // --- spatial bootstrap ---
  ensureSpace(id: string, name: string, now: number): void {
    this.db
      .prepare(`INSERT INTO spaces (id, name, sort_order, created_at) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO NOTHING`)
      .run(id, name, now)
  }

  ensureTab(id: string, spaceId: string, kind: string, title: string, cwd: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO tabs (id, space_id, kind, title, cwd, pinned, sort_order, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?) ON CONFLICT(id) DO NOTHING`
      )
      .run(id, spaceId, kind, title, cwd, now, now)
  }

  insertSession(p: InsertSessionParams): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, tab_id, cc_session_id, transcript_path, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
      )
      .run(p.id, p.tabId, p.ccSessionId, p.transcriptPath, p.startedAt, p.status)
  }

  /** Most recent Claude session recorded for a tab — the fallback when the
   *  tab's PTY has already exited and the live binding is gone. */
  latestSessionForTab(tabId: string): { ccSessionId: string; transcriptPath: string } | undefined {
    const row = this.db
      .prepare(`SELECT cc_session_id, transcript_path FROM sessions WHERE tab_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(tabId) as { cc_session_id: string; transcript_path: string } | undefined
    return row ? { ccSessionId: row.cc_session_id, transcriptPath: row.transcript_path } : undefined
  }

  // --- watermarks ---
  getWatermark(sessionId: string): number {
    const row = this.db.prepare(`SELECT last_offset FROM transcript_watermarks WHERE session_id = ?`).get(sessionId) as
      | { last_offset: number }
      | undefined
    return row?.last_offset ?? 0
  }

  setWatermark(sessionId: string, offset: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO transcript_watermarks (session_id, last_offset, last_processed_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_offset = excluded.last_offset, last_processed_at = excluded.last_processed_at`
      )
      .run(sessionId, offset, now)
  }

  // --- dedup / forgetting checks ---
  isTombstoned(fingerprint: string): boolean {
    return this.db.prepare(`SELECT 1 FROM tombstones WHERE fingerprint = ? LIMIT 1`).get(fingerprint) !== undefined
  }

  findActiveByFingerprint(fingerprint: string): MemoryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM memories WHERE source_hash = ? AND status = 'active' LIMIT 1`)
      .get(fingerprint) as MemoryRow | undefined
  }

  activesByFingerprint(fingerprint: string): MemoryRow[] {
    return this.db.prepare(`SELECT * FROM memories WHERE source_hash = ? AND status = 'active'`).all(fingerprint) as MemoryRow[]
  }

  // --- writes ---
  insertMemory(p: InsertMemoryParams): void {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, space_id, scope, type, content, confidence, salience, status, pinned, use_count, source_hash, created_at, updated_at, edited_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?, ?, NULL)`
      )
      .run(p.id, p.spaceId, p.scope, p.type, p.content, p.confidence, p.salience, p.sourceHash, p.now, p.now, p.now)
  }

  insertSource(p: InsertSourceParams): void {
    this.db
      .prepare(
        `INSERT INTO memory_sources (memory_id, session_id, transcript_path, span_start, span_end, excerpt)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(p.memoryId, p.sessionId, p.transcriptPath, p.spanStart, p.spanEnd, p.excerpt)
  }

  bumpUse(id: string, now: number): void {
    this.db
      .prepare(
        `UPDATE memories SET use_count = use_count + 1, salience = COALESCE(salience, 0) + 0.1, last_used_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(now, now, id)
  }

  markTombstoned(id: string, now: number): void {
    this.db
      .prepare(`UPDATE memories SET status = 'tombstoned', updated_at = ?, edited_at = ? WHERE id = ?`)
      .run(now, now, id)
  }

  insertTombstone(p: { id: string; fingerprint: string; scope: string; spaceId: string | null; reason: string; by: string; now: number }): void {
    this.db
      .prepare(
        `INSERT INTO tombstones (id, fingerprint, scope, space_id, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(p.id, p.fingerprint, p.scope, p.spaceId, p.reason, p.now, p.by)
  }

  insertAudit(p: { id: string; ts: number; action: string; targetType: string; targetId: string; detail: string }): void {
    this.db
      .prepare(`INSERT INTO audit_log (id, ts, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.id, p.ts, p.action, p.targetType, p.targetId, p.detail)
  }

  // --- reads ---
  getRow(id: string): MemoryRow | undefined {
    return this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined
  }

  getMemory(id: string): Memory | undefined {
    const row = this.getRow(id)
    return row ? toMemory(row) : undefined
  }

  /** Source spans behind a memory (transcript excerpts, or — for mirrored
   *  memories — the Claude Code .md file path + its body). For the detail tab. */
  listSources(memoryId: string): { sessionId: string; transcriptPath: string; spanStart: number; spanEnd: number; excerpt: string }[] {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, transcript_path AS transcriptPath,
                span_start AS spanStart, span_end AS spanEnd, excerpt
           FROM memory_sources WHERE memory_id = ?`
      )
      .all(memoryId) as { sessionId: string; transcriptPath: string; spanStart: number; spanEnd: number; excerpt: string }[]
  }

  clearSources(memoryId: string): void {
    this.db.prepare(`DELETE FROM memory_sources WHERE memory_id = ?`).run(memoryId)
  }

  /** Insert-or-update a global memory mirrored from Claude Code's memory store.
   *  Keyed by a deterministic id (e.g. `cc:user-profile`) so re-syncs update in
   *  place instead of duplicating. Bypasses tombstone/dedup: the .md file is the
   *  authoritative source of truth. Returns whether a new row was created. */
  upsertMirrored(p: { id: string; type: MemoryType; content: string; sourceHash: string; now: number }): 'inserted' | 'updated' {
    const existed = this.getRow(p.id) !== undefined
    this.db
      .prepare(
        `INSERT INTO memories
           (id, space_id, scope, type, content, confidence, salience, status, pinned, use_count, source_hash, created_at, updated_at, edited_at, last_used_at)
         VALUES (?, NULL, 'global', ?, ?, 0.95, 0.95, 'active', 0, 0, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type, content = excluded.content, source_hash = excluded.source_hash,
           status = 'active', salience = 0.95, updated_at = excluded.updated_at,
           edited_at = CASE WHEN content != excluded.content OR type != excluded.type OR status != 'active'
                            THEN excluded.edited_at ELSE edited_at END`
      )
      .run(p.id, p.type, p.content, p.sourceHash, p.now, p.now, p.now)
    return existed ? 'updated' : 'inserted'
  }

  /** Every memory row regardless of status — used by purge-and-reseed. */
  allRows(): MemoryRow[] {
    return this.db.prepare(`SELECT * FROM memories`).all() as MemoryRow[]
  }

  listActive(spaceId: string): Memory[] {
    return this.listActiveRows(spaceId).map(toMemory)
  }

  /** Raw active rows for a Space (+ global + multi-Space members). Ranker scores these. */
  listActiveRows(spaceId: string): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE status = 'active' AND (
           space_id = ? OR scope IN ('global', 'user') OR id IN (SELECT memory_id FROM space_membership WHERE space_id = ?)
         ) ORDER BY created_at DESC`
      )
      .all(spaceId, spaceId) as MemoryRow[]
  }

  /** Lexical hits via FTS5 bm25 (lower rank = better). Query is pre-sanitized. */
  searchFts(spaceId: string, matchQuery: string, limit = 200): { id: string; rank: number }[] {
    if (!matchQuery.trim()) return []
    try {
      return this.db
        .prepare(
          `SELECT m.id AS id, bm25(memories_fts) AS rank
             FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ? AND m.status = 'active' AND (m.space_id = ? OR m.scope IN ('global', 'user'))
            ORDER BY rank LIMIT ?`
        )
        .all(matchQuery, spaceId, limit) as { id: string; rank: number }[]
    } catch {
      return [] // malformed MATCH expression — fall back to non-lexical ranking
    }
  }

  // --- pin / edit / status ---
  setPinned(id: string, pinned: boolean, now: number): boolean {
    const r = this.db
      .prepare(`UPDATE memories SET pinned = ?, updated_at = ?, edited_at = ? WHERE id = ?`)
      .run(pinned ? 1 : 0, now, now, id)
    return r.changes > 0
  }

  setStatus(id: string, status: string, now: number): void {
    this.db.prepare(`UPDATE memories SET status = ?, updated_at = ?, edited_at = ? WHERE id = ?`).run(status, now, now, id)
  }

  editContent(id: string, content: string, sourceHash: string, now: number): void {
    this.db
      .prepare(`UPDATE memories SET content = ?, source_hash = ?, updated_at = ?, edited_at = ? WHERE id = ?`)
      .run(content, sourceHash, now, now, id)
  }

  // --- hard delete + undo ---
  hardDeleteRow(id: string): void {
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id) // cascades memory_sources
  }

  deleteTombstonesByFingerprint(fingerprint: string): void {
    this.db.prepare(`DELETE FROM tombstones WHERE fingerprint = ?`).run(fingerprint)
  }

  mostRecentForgotten(spaceId: string, limit = 25): ForgottenItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, action, target_id, detail_json FROM audit_log
          WHERE action IN ('memory.tombstone','memory.hard_delete') ORDER BY ts DESC LIMIT ?`
      )
      .all(limit * 4) as { id: string; ts: number; action: string; target_id: string; detail_json: string }[]
    const out: ForgottenItem[] = []
    for (const r of rows) {
      let d: { content?: string; type?: MemoryType; spaceId?: string | null; scope?: string } = {}
      try {
        d = JSON.parse(r.detail_json)
      } catch {
        /* ignore */
      }
      if (d.scope !== 'global' && d.scope !== 'user' && d.spaceId != null && d.spaceId !== spaceId) continue
      out.push({
        tombstoneId: r.id,
        memoryId: r.target_id,
        content: d.content ?? '(redacted)',
        type: d.type ?? null,
        forgottenAt: r.ts,
        reason: r.action === 'memory.hard_delete' ? 'hard delete' : 'forget'
      })
      if (out.length >= limit) break
    }
    return out
  }

  // --- spaces ---
  listSpaces(): Space[] {
    const rows = this.db
      .prepare(`SELECT id, name, icon, sort_order, created_at FROM spaces ORDER BY sort_order, created_at`)
      .all() as { id: string; name: string; icon: string | null; sort_order: number; created_at: number }[]
    return rows.map((r) => ({ id: r.id, name: r.name, icon: r.icon, sortOrder: r.sort_order, createdAt: r.created_at }))
  }

  createSpace(p: { id: string; name: string; icon: string | null; sortOrder: number; now: number }): void {
    this.db
      .prepare(`INSERT INTO spaces (id, name, icon, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.id, p.name, p.icon, p.sortOrder, p.now, p.now)
  }

  renameSpace(id: string, name: string, now: number = Date.now()): void {
    this.db.prepare(`UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, id)
  }

  setSpaceIcon(id: string, icon: string, now: number = Date.now()): void {
    this.db.prepare(`UPDATE spaces SET icon = ?, updated_at = ? WHERE id = ?`).run(icon, now, id)
  }

  deleteSpace(id: string): void {
    this.db.prepare(`DELETE FROM spaces WHERE id = ?`).run(id) // cascades tabs/sessions
  }

  reorderSpaces(ids: string[]): void {
    const upd = this.db.prepare(`UPDATE spaces SET sort_order = ? WHERE id = ?`)
    this.db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))()
  }

  maxSpaceOrder(): number {
    const r = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM spaces`).get() as { m: number }
    return r.m
  }

  // --- tabs ---
  listTabs(spaceId: string): Tab[] {
    const rows = this.db
      .prepare(
        `SELECT id, space_id, kind, title, cwd, ref, pinned, sort_order FROM tabs
          WHERE space_id = ? ORDER BY pinned DESC, sort_order, created_at`
      )
      .all(spaceId) as {
      id: string
      space_id: string
      kind: string
      title: string
      cwd: string
      ref: string | null
      pinned: number
      sort_order: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      spaceId: r.space_id,
      kind: (r.kind as TabKind) ?? 'claude',
      title: r.title,
      cwd: r.cwd,
      ref: r.ref,
      pinned: r.pinned === 1,
      sortOrder: r.sort_order
    }))
  }

  getTab(id: string): Tab | undefined {
    const r = this.db
      .prepare(`SELECT id, space_id, kind, title, cwd, ref, pinned, sort_order FROM tabs WHERE id = ?`)
      .get(id) as
      | { id: string; space_id: string; kind: string; title: string; cwd: string; ref: string | null; pinned: number; sort_order: number }
      | undefined
    if (!r) return undefined
    return {
      id: r.id,
      spaceId: r.space_id,
      kind: (r.kind as TabKind) ?? 'claude',
      title: r.title,
      cwd: r.cwd,
      ref: r.ref,
      pinned: r.pinned === 1,
      sortOrder: r.sort_order
    }
  }

  createTab(p: { id: string; spaceId: string; kind: TabKind; title: string; cwd: string; ref?: string | null; now: number }): void {
    const next = this.db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tabs WHERE space_id = ?`)
      .get(p.spaceId) as { n: number }
    this.db
      .prepare(
        `INSERT INTO tabs (id, space_id, kind, title, cwd, ref, pinned, sort_order, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(p.id, p.spaceId, p.kind, p.title, p.cwd, p.ref ?? null, next.n, p.now, p.now)
  }

  closeTab(id: string): void {
    this.db.prepare(`DELETE FROM tabs WHERE id = ?`).run(id) // cascades sessions + pty_snapshots
  }

  renameTab(id: string, title: string): void {
    this.db.prepare(`UPDATE tabs SET title = ? WHERE id = ?`).run(title, id)
  }

  setTabPinned(id: string, pinned: boolean): void {
    this.db.prepare(`UPDATE tabs SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id)
  }

  reorderTabs(ids: string[]): void {
    const upd = this.db.prepare(`UPDATE tabs SET sort_order = ? WHERE id = ?`)
    this.db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))()
  }

  moveTab(id: string, spaceId: string): void {
    const next = this.db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tabs WHERE space_id = ?`)
      .get(spaceId) as { n: number }
    this.db.prepare(`UPDATE tabs SET space_id = ?, sort_order = ? WHERE id = ?`).run(spaceId, next.n, id)
  }

  countTabs(spaceId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM tabs WHERE space_id = ?`).get(spaceId) as { c: number }).c
  }

  // --- app settings (key/value) ---
  getSetting(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined
    return r?.value
  }

  getSettingRow(key: string): { value: string; updatedAt: number } | undefined {
    const r = this.db.prepare(`SELECT value, updated_at FROM app_settings WHERE key = ?`).get(key) as
      | { value: string; updated_at: number | null }
      | undefined
    return r ? { value: r.value, updatedAt: r.updated_at ?? 0 } : undefined
  }

  setSetting(key: string, value: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now)
  }

  // --- terminal snapshots (visual restore; spec §8) ---
  getSnapshot(tabId: string): { scrollback: string; cols: number; rows: number } | undefined {
    const r = this.db.prepare(`SELECT scrollback, cols, rows FROM pty_snapshots WHERE tab_id = ?`).get(tabId) as
      | { scrollback: string; cols: number; rows: number }
      | undefined
    return r
  }

  setSnapshot(p: { tabId: string; cwd: string; scrollback: string; cols: number; rows: number; now: number }): void {
    this.db
      .prepare(
        `INSERT INTO pty_snapshots (tab_id, cwd, scrollback, cols, rows, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tab_id) DO UPDATE SET cwd=excluded.cwd, scrollback=excluded.scrollback,
           cols=excluded.cols, rows=excluded.rows, updated_at=excluded.updated_at`
      )
      .run(p.tabId, p.cwd, p.scrollback, p.cols, p.rows, p.now)
  }

  // --- embeddings (M3; brute-force cosine) ---
  upsertEmbedding(memoryId: string, model: string, dim: number, vec: Buffer, now: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_embeddings (memory_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec, created_at=excluded.created_at`
      )
      .run(memoryId, model, dim, vec, now)
  }

  getEmbedding(memoryId: string): { model: string; vec: Buffer } | undefined {
    return this.db.prepare(`SELECT model, vec FROM memory_embeddings WHERE memory_id = ?`).get(memoryId) as
      | { model: string; vec: Buffer }
      | undefined
  }

  /** Active memories of a Space (+ global) that have an embedding for `model`. */
  listEmbeddings(spaceId: string, model: string): { id: string; vec: Buffer }[] {
    return this.db
      .prepare(
        `SELECT m.id AS id, e.vec AS vec FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
          WHERE e.model = ? AND m.status = 'active' AND (m.space_id = ? OR m.scope IN ('global', 'user'))`
      )
      .all(model, spaceId) as { id: string; vec: Buffer }[]
  }

  /** Active same-type memories in the same scope bucket — supersede candidates. */
  activeSameType(spaceId: string, type: string, scope: string, excludeId: string): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memories WHERE status = 'active' AND type = ? AND scope = ? AND id != ?
           AND (space_id = ? OR scope IN ('global', 'user'))`
      )
      .all(type, scope, excludeId, spaceId) as MemoryRow[]
  }

  // --- links ---
  insertLink(p: { id: string; srcId: string; dstId: string; rel: string; now: number }): void {
    this.db
      .prepare(`INSERT INTO memory_links (id, src_id, dst_id, rel, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(p.id, p.srcId, p.dstId, p.rel, p.now)
  }

  // --- salience decay / auto-archive (spec §11) ---
  allActiveRows(): MemoryRow[] {
    return this.db.prepare(`SELECT * FROM memories WHERE status = 'active'`).all() as MemoryRow[]
  }

  updateSalience(id: string, salience: number, now: number): void {
    this.db.prepare(`UPDATE memories SET salience = ?, updated_at = ? WHERE id = ?`).run(salience, now, id)
  }

  // --- edit history (M4 diff view) ---
  insertEdit(p: { id: string; memoryId: string; before: string; after: string; now: number; by: string }): void {
    this.db
      .prepare(`INSERT INTO memory_edits (id, memory_id, before, after, edited_at, edited_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.id, p.memoryId, p.before, p.after, p.now, p.by)
  }

  listEdits(memoryId: string): { before: string; after: string; editedAt: number }[] {
    return this.db
      .prepare(`SELECT before, after, edited_at AS editedAt FROM memory_edits WHERE memory_id = ? ORDER BY edited_at DESC`)
      .all(memoryId) as { before: string; after: string; editedAt: number }[]
  }

  // --- multi-Space membership (M4) ---
  addMembership(memoryId: string, spaceId: string): void {
    this.db
      .prepare(`INSERT INTO space_membership (memory_id, space_id) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .run(memoryId, spaceId)
  }

  removeMembership(memoryId: string, spaceId: string): void {
    this.db.prepare(`DELETE FROM space_membership WHERE memory_id = ? AND space_id = ?`).run(memoryId, spaceId)
  }

  listMemberships(memoryId: string): string[] {
    return (
      this.db.prepare(`SELECT space_id FROM space_membership WHERE memory_id = ?`).all(memoryId) as { space_id: string }[]
    ).map((r) => r.space_id)
  }

  // --- cross-machine sync (full-table reads for export, guarded writes for import) ---
  allSpaceRows(): { id: string; name: string; icon: string | null; sort_order: number; created_at: number; updated_at: number | null }[] {
    return this.db.prepare(`SELECT id, name, icon, sort_order, created_at, updated_at FROM spaces`).all() as {
      id: string
      name: string
      icon: string | null
      sort_order: number
      created_at: number
      updated_at: number | null
    }[]
  }

  allTombstoneRows(): TombstoneRow[] {
    return this.db.prepare(`SELECT * FROM tombstones`).all() as TombstoneRow[]
  }

  allLinkRows(): LinkRow[] {
    return this.db.prepare(`SELECT * FROM memory_links`).all() as LinkRow[]
  }

  allMembershipRows(): { memory_id: string; space_id: string }[] {
    return this.db.prepare(`SELECT memory_id, space_id FROM space_membership`).all() as { memory_id: string; space_id: string }[]
  }

  /** Union semantics for synced forgets. A fingerprint already covered by an
   *  equal-or-newer local tombstone is a no-op; a NEWER remote forget is added so
   *  both machines converge on the same (max) forget clock — export keeps the
   *  latest per fingerprint, so differing clocks would ping-pong forever. */
  insertTombstoneIfAbsent(p: { id: string; fingerprint: string; scope: string | null; spaceId: string | null; reason: string | null; by: string | null; now: number }): boolean {
    const latest = this.db.prepare(`SELECT MAX(created_at) AS m FROM tombstones WHERE fingerprint = ?`).get(p.fingerprint) as { m: number | null }
    if (latest.m !== null && latest.m >= p.now) return false
    this.db
      .prepare(`INSERT INTO tombstones (id, fingerprint, scope, space_id, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, p.fingerprint, p.scope, p.spaceId, p.reason, p.now, p.by)
    return true
  }

  insertLinkIfAbsent(p: { id: string; srcId: string; dstId: string; rel: string; createdAt: number }): boolean {
    const r = this.db
      .prepare(`INSERT INTO memory_links (id, src_id, dst_id, rel, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(p.id, p.srcId, p.dstId, p.rel, p.createdAt)
    return r.changes > 0
  }

  /** Apply a remote memory's durable fields (LWW decided by the caller). Local
   *  ranking signals — salience, use_count, last_used_at — are never overwritten. */
  upsertSynced(p: {
    id: string
    spaceId: string | null
    scope: Scope
    type: MemoryType
    content: string
    confidence: number | null
    status: string
    pinned: boolean
    sourceHash: string
    createdAt: number
    editedAt: number
    now: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, space_id, scope, type, content, confidence, salience, status, pinned, use_count, source_hash, created_at, updated_at, edited_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           space_id = excluded.space_id, scope = excluded.scope, type = excluded.type,
           content = excluded.content, confidence = excluded.confidence, status = excluded.status,
           pinned = excluded.pinned, source_hash = excluded.source_hash, created_at = excluded.created_at,
           updated_at = excluded.updated_at, edited_at = excluded.edited_at`
      )
      .run(
        p.id, p.spaceId, p.scope, p.type, p.content, p.confidence, p.confidence ?? 0.5,
        p.status, p.pinned ? 1 : 0, p.sourceHash, p.createdAt, p.now, p.editedAt
      )
  }

  /** Apply a remote Space's fields (LWW decided by the caller). */
  upsertSyncedSpace(p: { id: string; name: string; icon: string | null; sortOrder: number; createdAt: number; updatedAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO spaces (id, name, icon, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, icon = excluded.icon, sort_order = excluded.sort_order,
           created_at = excluded.created_at, updated_at = excluded.updated_at`
      )
      .run(p.id, p.name, p.icon, p.sortOrder, p.createdAt, p.updatedAt)
  }
}

export function toMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    spaceId: r.space_id,
    scope: r.scope,
    type: r.type,
    content: r.content,
    confidence: r.confidence,
    salience: r.salience,
    status: r.status as Memory['status'],
    pinned: r.pinned === 1,
    useCount: r.use_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at
  }
}
