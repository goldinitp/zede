import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { dialog, safeStorage, shell, type WebContents } from 'electron'
import { openDatabase } from './db/database'
import { MemoryRepo } from './db/memories'
import { MemoryStore } from './pipeline/store'
import { ClaudeCodeExtractor } from './extract/claude'
import { HeuristicExtractor } from './extract/heuristic'
import { OllamaExtractor } from './extract/ollama'
import type { Extractor } from './extract/types'
import { CaptureService } from './capture/watcher'
import { ConversationStore } from './conversations/store'
import { MirrorService, MIRROR_ID_PREFIX } from './memory/mirror'
import { SyncService } from './sync/service'
import type { ImportResult } from './sync/merge'
import { PtyManager } from './pty/manager'
import { Retriever } from './retrieve/ranker'
import { ContextWriter, renderContext } from './inject/context'
import { EmbeddingService } from './embed/service'
import { HashingEmbedder, TransformersEmbedder, blobToVec, cosine, type Embedder } from './embed/embedder'
import { discoverClaudeInternals } from './internals/discover'
import { redact } from './pipeline/redact'
import { fingerprint } from './pipeline/fingerprint'
import { DEFAULT_THEME_ID, NERD_FONT_STACK } from '../shared/themes'
import type {
  ClaudeInternalDetail,
  ClaudeInternalsSnapshot,
  ForgottenItem,
  InjectionPreview,
  Memory,
  MemoryDetail,
  PtySnapshot,
  SavedConversation,
  Settings,
  Space,
  Tab,
  TabCreateOptions,
  TabKind
} from '../shared/api'

const DEFAULT_SPACE = { id: 'default', name: 'Default', icon: '🧵' }
const FORGET_ABOUT_COSINE = 0.45

// Wires the whole pipeline (spec §4): DB + pty + capture + extract + store +
// retrieve + inject + embed. Single DB writer. Emits change events to the renderer.
export class Core {
  readonly repo: MemoryRepo
  readonly store: MemoryStore
  readonly capture: CaptureService
  readonly pty: PtyManager
  readonly retriever: Retriever
  readonly embed: EmbeddingService
  readonly mirror: MirrorService
  readonly conversations: ConversationStore
  readonly sync: SyncService
  private readonly inject = new ContextWriter()
  private extractor: Extractor = new ClaudeCodeExtractor()
  private embedder: Embedder = new HashingEmbedder()

  constructor(
    dbPath: string,
    private readonly getSender: () => WebContents | undefined
  ) {
    const db = openDatabase(dbPath)
    this.repo = new MemoryRepo(db)
    this.embed = new EmbeddingService(this.repo, () => this.embedder, () => Date.now(), () => this.send('memory:changed', null))
    this.store = new MemoryStore(
      this.repo,
      (m) => this.handleLearned(m),
      (id) => this.send('memory:forgotten', { id })
    )
    this.retriever = new Retriever(this.repo)
    this.capture = new CaptureService(this.repo, () => this.extractor, this.store, () => Date.now(), (msg) =>
      console.log('[capture]', msg)
    )
    this.pty = new PtyManager(() => this.getSender())
    this.conversations = new ConversationStore(join(dirname(dbPath), 'conversations'))
    this.mirror = new MirrorService(
      this.repo,
      () => Date.now(),
      (inserted, updated) => this.handleMirrored(inserted, updated),
      (msg) => console.log('[mirror]', msg)
    )
    this.sync = new SyncService(
      this.repo,
      join(dirname(dbPath), 'sync'),
      () => Date.now(),
      {
        onImported: (r) => this.handleSyncImported(r),
        onStatus: () => this.send('sync:status', this.sync.status()),
        openExternal: (url) => void shell.openExternal(url)
      },
      (msg) => console.log('[sync]', msg)
    )
    this.bootstrap()
  }

  private send(channel: string, payload: unknown): void {
    this.getSender()?.send(channel, payload)
  }

  private handleLearned(m: Memory): void {
    this.send('memory:learned', m)
    this.embed.enqueue(m) // vectorize off the hot path; may trigger supersede
  }

  private handleMirrored(inserted: Memory[], updated: Memory[]): void {
    for (const m of [...inserted, ...updated]) this.embed.enqueue(m) // searchable like any memory
    // The panel's onChanged handler re-lists, so new + refreshed mirrored rows
    // both appear without a bespoke "learned" event (which would double-append).
    this.send('memory:changed', null)
  }

  private handleSyncImported(r: ImportResult): void {
    for (const id of r.changedMemoryIds) {
      const m = this.repo.getMemory(id)
      if (m) this.embed.enqueue(m) // imported content gets local embeddings/FTS
    }
    this.send('memory:changed', null)
    if (r.spacesChanged) this.send('space:changed', null)
    if (r.settingsChanged) this.send('settings:changed', this.getSettings())
  }

  private bootstrap(): void {
    const now = Date.now()
    if (!this.repo.listSpaces().length) {
      this.repo.createSpace({ id: DEFAULT_SPACE.id, name: DEFAULT_SPACE.name, icon: DEFAULT_SPACE.icon, sortOrder: 0, now })
    }
    if (!this.repo.getSetting('activeSpace')) this.repo.setSetting('activeSpace', this.repo.listSpaces()[0].id)
    // If a default Space is set and still exists, open it on launch.
    const def = this.repo.getSetting('defaultSpace')
    if (def && this.repo.listSpaces().some((s) => s.id === def)) this.repo.setSetting('activeSpace', def)
    const active = this.repo.getSetting('activeSpace') as string
    if (this.repo.countTabs(active) === 0) {
      this.repo.createTab({ id: randomUUID(), spaceId: active, kind: 'claude', title: 'claude', cwd: process.cwd(), now })
    }
    this.applyTiers()
    this.runMaintenance()
    this.embed.backfillActive()
    this.maybeReseed() // one-time purge of debugging-era clutter + reseed from curated sources
    this.activateCapture(this.getActiveSpace()) // tail transcripts + mirror Claude Code memory
    if (this.repo.getSetting('syncEnabled') === '1') {
      // On-launch sync, off the startup hot path. unref'd so it never holds the
      // process open (selftest constructs Cores and exits).
      setTimeout(() => void this.sync.syncNow(), 5000).unref()
    }
  }

  // --- spaces ---
  listSpaces(): Space[] {
    const def = this.repo.getSetting('defaultSpace')
    return this.repo.listSpaces().map((s) => ({ ...s, isDefault: s.id === def }))
  }
  setDefaultSpace(id: string): void {
    this.repo.setSetting('defaultSpace', id)
    this.send('space:changed', null)
  }
  createSpace(name: string, icon?: string): Space {
    const id = randomUUID()
    const now = Date.now()
    this.repo.createSpace({ id, name: name.trim() || 'Untitled', icon: icon ?? '🗂', sortOrder: this.repo.maxSpaceOrder() + 1, now })
    this.repo.createTab({ id: randomUUID(), spaceId: id, kind: 'claude', title: 'claude', cwd: process.cwd(), now })
    this.send('space:changed', null)
    return this.repo.listSpaces().find((s) => s.id === id) as Space
  }
  renameSpace(id: string, name: string): void {
    this.repo.renameSpace(id, name.trim() || 'Untitled')
    this.send('space:changed', null)
  }
  setSpaceIcon(id: string, icon: string): void {
    this.repo.setSpaceIcon(id, icon)
    this.send('space:changed', null)
  }
  removeSpace(id: string): void {
    if (this.repo.listSpaces().length <= 1) return // keep at least one Space
    for (const t of this.repo.listTabs(id)) this.pty.kill(t.id)
    this.repo.deleteSpace(id)
    if (this.repo.getSetting('activeSpace') === id) this.repo.setSetting('activeSpace', this.repo.listSpaces()[0].id)
    if (this.repo.getSetting('defaultSpace') === id) this.repo.setSetting('defaultSpace', '') // default removed
    this.send('space:changed', null)
  }
  reorderSpaces(ids: string[]): void {
    this.repo.reorderSpaces(ids)
    this.send('space:changed', null)
  }
  getActiveSpace(): string {
    return (this.repo.getSetting('activeSpace') as string) ?? this.repo.listSpaces()[0]?.id ?? DEFAULT_SPACE.id
  }
  setActiveSpace(id: string): void {
    this.repo.setSetting('activeSpace', id)
    this.activateCapture(id) // begin tailing + backfilling this Space's transcript dirs
    this.send('space:changed', null)
  }

  // --- tabs ---
  listTabs(spaceId: string): Tab[] {
    return this.repo.listTabs(spaceId)
  }
  createTab(opts: TabCreateOptions): Tab {
    const id = randomUUID()
    const now = Date.now()
    const kind: TabKind = opts.kind ?? 'claude'
    const title = opts.title ?? (kind === 'shell' ? 'shell' : kind === 'memory' ? 'memory' : kind === 'internal' ? 'context' : 'claude')
    this.repo.createTab({
      id,
      spaceId: opts.spaceId,
      kind,
      title,
      cwd: opts.cwd ?? process.cwd(),
      ref: opts.ref ?? null,
      now
    })
    this.send('tab:changed', opts.spaceId)
    return this.repo.getTab(id) as Tab
  }
  closeTab(id: string): void {
    const tab = this.repo.getTab(id)
    if (!tab) return
    // Snapshot the slot order so a pinned tab can be rebuilt in its exact place.
    const order = this.repo.listTabs(tab.spaceId).map((t) => t.id)
    this.pty.kill(id)
    this.repo.closeTab(id)
    if (tab.pinned) {
      // Pinned tabs are persistent (Arc-style): closing ends the running session
      // but keeps the pinned slot — a fresh tab takes its exact place.
      const newId = randomUUID()
      this.repo.createTab({ id: newId, spaceId: tab.spaceId, kind: tab.kind, title: tab.title, cwd: tab.cwd, now: Date.now() })
      this.repo.setTabPinned(newId, true)
      this.repo.reorderTabs(order.map((x) => (x === id ? newId : x)))
    }
    this.send('tab:changed', tab.spaceId)
  }
  /** Close every unpinned tab in the Space, keeping pinned ones. One event. */
  closeAllTabs(spaceId: string): void {
    let closed = 0
    for (const t of this.repo.listTabs(spaceId)) {
      if (t.pinned) continue
      this.pty.kill(t.id)
      this.repo.closeTab(t.id)
      closed++
    }
    if (closed) this.send('tab:changed', spaceId)
  }
  renameTab(id: string, title: string): void {
    this.repo.renameTab(id, title)
    const tab = this.repo.getTab(id)
    if (tab) this.send('tab:changed', tab.spaceId)
  }
  setTabPinned(id: string, pinned: boolean): void {
    this.repo.setTabPinned(id, pinned)
    const tab = this.repo.getTab(id)
    if (tab) this.send('tab:changed', tab.spaceId)
  }
  reorderTabs(spaceId: string, ids: string[]): void {
    this.repo.reorderTabs(ids)
    this.send('tab:changed', spaceId)
  }
  /** Duplicate a tab (same kind + cwd + title) into the same Space. */
  duplicateTab(id: string): Tab | undefined {
    const src = this.repo.getTab(id)
    if (!src) return undefined
    const newId = randomUUID()
    this.repo.createTab({ id: newId, spaceId: src.spaceId, kind: src.kind, title: src.title, cwd: src.cwd, now: Date.now() })
    this.send('tab:changed', src.spaceId)
    return this.repo.getTab(newId)
  }
  /** Move a tab to another Space (lands at the end of that Space's list). */
  moveTab(id: string, spaceId: string): void {
    const src = this.repo.getTab(id)
    if (!src || src.spaceId === spaceId) return
    this.repo.moveTab(id, spaceId)
    this.send('tab:changed', src.spaceId) // old Space loses it
    this.send('tab:changed', spaceId) // new Space gains it
  }

  // --- spawn (orchestrates injection + capture binding) ---
  async spawnTab(opts: {
    tabId: string
    spaceId?: string
    cwd?: string
    kind?: TabKind
    autoClaude?: boolean
    /** Title for a tab this spawn has to create (defaults to the kind's name). */
    title?: string
    /** Resume this Claude session instead of starting a fresh one (main-only —
     *  set by loadConversation, never by the renderer). */
    resumeSessionId?: string
  }): Promise<{
    sessionId: string
    /** false when re-attaching to a still-live PTY (Space switch); true for a
     *  brand-new PTY. The renderer uses this to decide whether replaying the
     *  saved scrollback is a faithful bridge or a stale, distorted ghost. */
    fresh: boolean
  }> {
    let tab = this.repo.getTab(opts.tabId)
    if (!tab) {
      const now = Date.now()
      const spaceId = opts.spaceId ?? this.getActiveSpace()
      this.repo.createTab({
        id: opts.tabId,
        spaceId,
        kind: opts.kind ?? 'claude',
        title: opts.title ?? (opts.kind === 'shell' ? 'shell' : 'claude'),
        cwd: opts.cwd ?? process.cwd(),
        now
      })
      tab = this.repo.getTab(opts.tabId) as Tab
    }

    const settings = this.getSettings()
    let appendFile: string | undefined
    if (tab.kind === 'claude' && !this.pty.has(tab.id)) {
      const { contextPath } = await this.writeInjection(tab.spaceId, tab.cwd)
      appendFile = settings.injectionAdapter === 'flag' ? contextPath : undefined
    }

    // A pinned tab's first spawn this run picks its previous session back up —
    // quit + reopen restores the conversation instead of starting cold.
    const resumeSessionId = opts.resumeSessionId ?? this.resumeCandidateFor(tab)
    this.spawnedThisRun.add(tab.id)

    const res = this.pty.spawn({
      tabId: tab.id,
      cwd: tab.cwd,
      kind: tab.kind,
      autoClaude: opts.autoClaude ?? true,
      appendSystemPromptFile: appendFile,
      resumeSessionId
    })

    if (res.fresh && tab.kind === 'claude') {
      this.repo.insertSession({
        id: res.sessionId,
        tabId: tab.id,
        ccSessionId: res.sessionId,
        transcriptPath: res.transcriptPath,
        startedAt: Date.now(),
        status: 'live'
      })
      // Capture is bound to the cwd's transcript dir, not this one session — so a
      // tab the user never types into doesn't matter, and conversations run in an
      // external terminal (or a manually restarted `claude`) are captured too.
      this.capture.trackProject(tab.spaceId, tab.cwd, tab.id)
    }
    return { sessionId: res.sessionId, fresh: res.fresh }
  }

  /** Tabs that have spawned (or re-attached) at least once this app run.
   *  Auto-restore only applies before a tab's first spawn — respawning after
   *  the user exits a session mid-run starts fresh, as it always did. */
  private readonly spawnedThisRun = new Set<string>()

  /** The session a pinned Claude tab should resume on its first spawn this
   *  run: its most recent recorded session, if the transcript is still on
   *  disk. Undefined = start a fresh session. */
  resumeCandidateFor(tab: Tab): string | undefined {
    if (!this.getSettings().restorePinnedSessions) return undefined
    if (tab.kind !== 'claude' || !tab.pinned || this.spawnedThisRun.has(tab.id)) return undefined
    const last = this.repo.latestSessionForTab(tab.id)
    return last && existsSync(last.transcriptPath) ? last.ccSessionId : undefined
  }

  /** Start project-dir capture for every distinct cwd among a Space's claude
   *  tabs, backfilling transcripts already on disk. Idempotent. */
  activateCapture(spaceId: string): void {
    const seen = new Set<string>()
    for (const t of this.repo.listTabs(spaceId)) {
      if (t.kind !== 'claude' || seen.has(t.cwd)) continue
      seen.add(t.cwd)
      this.capture.trackProject(spaceId, t.cwd, t.id)
      this.mirror.track(spaceId, t.cwd) // mirror Claude Code's curated memory for this cwd
    }
  }

  /** One-time cleanup chosen by the user (2026-06-27): purge the debugging-era
   *  distilled clutter and reseed from curated sources. Guarded so it runs once. */
  private maybeReseed(): void {
    if (this.repo.getSetting('reseededV1') === '1') return
    try {
      const n = this.purgeAndReseed(this.getActiveSpace())
      console.log(`[memory] reseed: purged distilled clutter; mirrored ${n} curated memories`)
    } catch (e) {
      console.error('[memory] reseed failed', e)
    }
    this.repo.setSetting('reseededV1', '1')
  }

  /** Purge distilled memories (tombstoning their fingerprints so they can't be
   *  re-derived), keep + refresh mirrored (`cc:…`) rows, then re-mirror curated
   *  sources. Returns the mirrored count. */
  purgeAndReseed(spaceId: string): number {
    const now = Date.now()
    this.repo.transaction(() => {
      for (const r of this.repo.allRows()) {
        if (r.id.startsWith(MIRROR_ID_PREFIX)) continue // curated — keep
        this.repo.insertTombstone({
          id: randomUUID(),
          fingerprint: r.source_hash,
          scope: r.scope,
          spaceId: r.space_id,
          reason: 'reseed purge',
          by: 'system',
          now
        })
        this.repo.hardDeleteRow(r.id) // no audit entry — keeps the "recently forgotten" pane clean
      }
    })()
    const mirrored = this.resyncMirror(spaceId)
    this.send('memory:changed', null)
    return mirrored
  }

  /** Re-sync curated memories from Claude Code's store (non-destructive). */
  resyncMirror(spaceId: string): number {
    let n = 0
    const seen = new Set<string>()
    for (const t of this.repo.listTabs(spaceId)) {
      if (seen.has(t.cwd)) continue
      seen.add(t.cwd)
      const r = this.mirror.sync(t.cwd)
      n += r.inserted + r.updated
    }
    return n
  }

  /** Compute the ranked set and write the injection artifact (spec §6.4–6.5). */
  private async writeInjection(spaceId: string, cwd: string): Promise<{ contextPath: string; tokens: number }> {
    const space = this.repo.listSpaces().find((s) => s.id === spaceId)
    const seed = [basename(cwd), space?.name ?? '', ...this.repo.listTabs(spaceId).map((t) => t.title)].join(' ')
    const sim = await this.semanticSim(spaceId, seed)
    const { selected, tokens } = this.retriever.select({ spaceId, seed, now: Date.now() }, sim)
    const { contextPath } = this.inject.write(cwd, selected, space?.name ?? 'Space', this.getSettings().injectionAdapter)
    return { contextPath, tokens }
  }

  // --- pty snapshots (visual restore; spec §8) ---
  saveSnapshot(tabId: string, snap: PtySnapshot): void {
    const tab = this.repo.getTab(tabId)
    if (!tab) return // tab was closed; its snapshot row is gone (FK) — nothing to persist
    this.repo.setSnapshot({ tabId, cwd: tab.cwd, scrollback: snap.scrollback, cols: snap.cols, rows: snap.rows, now: Date.now() })
  }
  getSnapshot(tabId: string): PtySnapshot | null {
    const s = this.repo.getSnapshot(tabId)
    return s ? { scrollback: s.scrollback, cols: s.cols, rows: s.rows } : null
  }

  // --- memory ops ---
  listInternals(spaceId: string): ClaudeInternalsSnapshot {
    const cwds = [process.cwd(), ...this.repo.listTabs(spaceId).map((t) => t.cwd)]
    return discoverClaudeInternals({ cwds, now: Date.now() })
  }
  /** Item + full file content + nested items, for the internal detail tab. The
   *  path always comes from a fresh discovery snapshot (never the renderer),
   *  so only files Zede itself surfaced can be read or written. */
  internalDetail(spaceId: string, id: string): ClaudeInternalDetail | null {
    const { items } = this.listInternals(spaceId)
    const item = items.find((i) => i.id === id)
    if (!item) return null
    let content: string | null = null
    let editable = false
    if (item.path) {
      try {
        if (lstatSync(item.path).isFile()) {
          content = readFileSync(item.path, 'utf8')
          editable = true
        }
      } catch {
        /* unreadable → shown view-only */
      }
    }
    return { item, content, editable, children: items.filter((i) => i.parentId === id) }
  }
  internalSave(spaceId: string, id: string, content: string): boolean {
    const item = this.listInternals(spaceId).items.find((i) => i.id === id)
    if (!item?.path) return false
    try {
      if (!lstatSync(item.path).isFile()) return false
      writeFileSync(item.path, content, 'utf8')
      return true
    } catch {
      return false
    }
  }

  listMemories(spaceId: string): Memory[] {
    return this.repo.listActive(spaceId)
  }
  /** Memory + its sources + edit history, for the detail tab. */
  memoryDetail(id: string): MemoryDetail | null {
    const memory = this.repo.getMemory(id)
    if (!memory) return null
    return {
      memory,
      sources: this.repo.listSources(id),
      edits: this.repo.listEdits(id),
      origin: id.startsWith(MIRROR_ID_PREFIX) ? 'claude-memory' : 'distilled'
    }
  }
  async searchMemories(spaceId: string, q: string): Promise<Memory[]> {
    const seed = q.trim()
    if (!seed) return this.listMemories(spaceId)
    const ranked = this.retriever.rank({ spaceId, seed, now: Date.now() }, await this.semanticSim(spaceId, seed))
    return ranked
      .slice(0, 50)
      .map((r) => this.repo.getMemory(r.row.id))
      .filter((m): m is Memory => !!m)
  }
  deleteMemory(id: string, hard = false): boolean {
    const ok = hard ? this.store.hardDelete(id, Date.now()) : this.store.softDelete(id, Date.now())
    if (ok) this.send('memory:changed', null)
    return ok
  }
  undoMemory(id: string): boolean {
    const m = this.store.undo(id, Date.now())
    if (m) this.send('memory:changed', null)
    return !!m
  }
  setMemoryPinned(id: string, pinned: boolean): boolean {
    const ok = this.store.setPinned(id, pinned, Date.now())
    if (ok) this.send('memory:changed', null)
    return ok
  }
  editMemory(id: string, content: string): Memory | null {
    const row = this.repo.getRow(id)
    if (!row) return null
    const clean = redact(content).text.trim()
    if (!clean) return null
    const now = Date.now()
    this.repo.transaction(() => {
      this.repo.insertEdit({ id: randomUUID(), memoryId: id, before: row.content, after: clean, now, by: 'user' })
      this.repo.insertAudit({
        id: randomUUID(),
        ts: now,
        action: 'memory.edit',
        targetType: 'memory',
        targetId: id,
        detail: JSON.stringify({ before: row.content, after: clean })
      })
      this.repo.editContent(id, clean, fingerprint(clean), now)
    })()
    const m = this.repo.getMemory(id)
    if (m) this.embed.enqueue(m) // re-embed edited content
    this.send('memory:changed', null)
    return m ?? null
  }

  history(id: string): { before: string; after: string; editedAt: number }[] {
    return this.repo.listEdits(id)
  }

  shareToSpace(id: string, spaceId: string): void {
    this.repo.addMembership(id, spaceId)
    this.send('memory:changed', null)
  }

  // --- saved conversations (local JSON snapshots of a tab's transcript) ---
  saveConversation(tabId: string, title?: string): SavedConversation {
    const tab = this.repo.getTab(tabId)
    if (!tab) throw new Error('Tab not found')
    // Prefer the live PTY binding; fall back to the last recorded session so a
    // tab whose claude has exited can still be saved from its transcript.
    const live = this.pty.get(tabId)
    const past = this.repo.latestSessionForTab(tabId)
    const sessionId = live?.sessionId ?? past?.ccSessionId
    const transcriptPath = live?.transcriptPath ?? past?.transcriptPath
    if (!sessionId || !transcriptPath) throw new Error('No Claude session recorded for this tab yet')
    return this.conversations.save({ title: title?.trim() || tab.title, sessionId, cwd: tab.cwd, transcriptPath })
  }

  listConversations(): SavedConversation[] {
    return this.conversations.list()
  }

  deleteConversation(id: string): boolean {
    return this.conversations.remove(id)
  }

  /** Restore a saved conversation: put its transcript back on disk, open a new
   *  tab in its cwd and resume the Claude session there. With `compact`, send
   *  `/compact` once the resumed TUI settles so the reloaded context is
   *  immediately compacted (long conversations come back lean). */
  async loadConversation(id: string, opts: { spaceId?: string; compact?: boolean } = {}): Promise<Tab> {
    const rec = this.conversations.get(id)
    if (!rec) throw new Error('Saved conversation not found')
    this.conversations.restoreTranscript(rec)

    const spaceId = opts.spaceId ?? this.getActiveSpace()
    const tabId = randomUUID()
    // Spawn BEFORE announcing the tab: the renderer's TerminalPane calls
    // pty:spawn on mount, and spawn idempotency means whoever goes first wins —
    // this way the pane re-attaches to the resumed PTY instead of racing it
    // with a fresh session.
    await this.spawnTab({ tabId, spaceId, cwd: rec.cwd, kind: 'claude', title: rec.title, resumeSessionId: rec.sessionId })
    this.send('tab:changed', spaceId)

    if (opts.compact) {
      void this.pty.whenQuiet(tabId).then(() => {
        this.pty.input(tabId, '/compact')
        // Enter goes separately so the TUI has registered the slash command first.
        setTimeout(() => this.pty.input(tabId, '\r'), 300)
      })
    }
    return this.repo.getTab(tabId) as Tab
  }

  async exportSave(spaceId: string, format: 'json' | 'markdown'): Promise<string | null> {
    const content = this.exportAll(spaceId, format)
    const ext = format === 'json' ? 'json' : 'md'
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `zede-memories-${spaceId}.${ext}`,
      filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [ext] }]
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, content, 'utf8')
    return filePath
  }

  async previewInjection(spaceId: string): Promise<InjectionPreview> {
    const space = this.repo.listSpaces().find((s) => s.id === spaceId)
    const seed = [space?.name ?? '', ...this.repo.listTabs(spaceId).map((t) => t.title)].join(' ')
    const { selected, tokens } = this.retriever.select({ spaceId, seed, now: Date.now() }, await this.semanticSim(spaceId, seed))
    return {
      memories: selected.map((r) => this.repo.getMemory(r.id)).filter((m): m is Memory => !!m),
      tokens,
      adapter: this.getSettings().injectionAdapter
    }
  }

  recentlyForgotten(spaceId: string): ForgottenItem[] {
    return this.repo.mostRecentForgotten(spaceId)
  }

  exportAll(spaceId: string, format: 'json' | 'markdown'): string {
    const mems = this.repo.listActive(spaceId)
    if (format === 'json') return JSON.stringify(mems, null, 2)
    const space = this.repo.listSpaces().find((s) => s.id === spaceId)
    const rows = mems.map((m) => this.repo.getRow(m.id)).filter((r): r is NonNullable<typeof r> => !!r)
    return renderContext(rows, space?.name ?? 'Space')
  }

  // --- "forget about X": semantic family when enabled, lexical otherwise (spec §7) ---
  async forgetAboutPreview(spaceId: string, query: string): Promise<Memory[]> {
    const sim = await this.semanticSim(spaceId, query)
    if (sim) {
      return [...sim.entries()]
        .filter(([, c]) => c >= FORGET_ABOUT_COSINE)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([id]) => this.repo.getMemory(id))
        .filter((m): m is Memory => !!m)
    }
    return (await this.searchMemories(spaceId, query)).slice(0, 25)
  }
  async forgetAboutConfirm(spaceId: string, query: string): Promise<number> {
    const targets = await this.forgetAboutPreview(spaceId, query)
    let n = 0
    for (const m of targets) if (this.store.softDelete(m.id, Date.now())) n++
    if (n) this.send('memory:changed', null)
    return n
  }

  /** Embedding cosine map for ranking/search (M3). undefined when semantic is off. */
  protected async semanticSim(spaceId: string, seed: string): Promise<Map<string, number> | undefined> {
    if (!this.getSettings().semanticEnabled || !seed.trim()) return undefined
    try {
      const qv = await this.embedder.embed(seed)
      const map = new Map<string, number>()
      for (const { id, vec } of this.repo.listEmbeddings(spaceId, this.embedder.model)) map.set(id, cosine(qv, blobToVec(vec)))
      return map
    } catch {
      return undefined
    }
  }

  /** Salience decay + auto-archive below a floor (spec §11). Archive ≠ forget:
   *  no tombstone, so an archived fact can re-derive if it recurs. */
  runMaintenance(now = Date.now()): { archived: number } {
    const HALF_LIFE_DAYS = 30
    const FLOOR = 0.05
    const MIN_AGE_DAYS = 14
    let archived = 0
    for (const row of this.repo.allActiveRows()) {
      if (row.pinned) continue
      const last = row.last_used_at ?? row.updated_at ?? row.created_at
      const days = Math.max(0, (now - last) / 86_400_000)
      const base = row.salience ?? row.confidence ?? 0.5
      const decayed = base * Math.pow(0.5, days / HALF_LIFE_DAYS)
      this.repo.updateSalience(row.id, decayed, now)
      const ageDays = (now - row.created_at) / 86_400_000
      if (decayed < FLOOR && (row.use_count ?? 0) === 0 && ageDays > MIN_AGE_DAYS) {
        this.repo.setStatus(row.id, 'archived', now)
        archived++
      }
    }
    if (archived) this.send('memory:changed', null)
    return { archived }
  }

  // --- settings ---
  getSettings(): Settings {
    const g = (k: string): string | undefined => this.repo.getSetting(k)
    const num = (k: string, dflt: number): number => {
      const n = Number(g(k))
      return Number.isFinite(n) && g(k) !== undefined && g(k) !== '' ? n : dflt
    }
    return {
      injectionAdapter: (g('injectionAdapter') as Settings['injectionAdapter']) ?? 'file',
      extractionTier: (g('extractionTier') as Settings['extractionTier']) ?? 'claude',
      semanticEnabled: g('semanticEnabled') === '1',
      encryptionEnabled: g('encryptionEnabled') === '1',
      pinnedTabPinsMemory: g('pinnedTabPinsMemory') === '1',
      restorePinnedSessions: g('restorePinnedSessions') === undefined ? true : g('restorePinnedSessions') === '1',
      fontFamily: g('fontFamily') ?? NERD_FONT_STACK,
      fontSize: num('fontSize', 13),
      lineHeight: num('lineHeight', 1),
      letterSpacing: num('letterSpacing', 0),
      scrollback: num('scrollback', 1000),
      theme: g('theme') ?? DEFAULT_THEME_ID,
      cursorStyle: (g('cursorStyle') as Settings['cursorStyle']) ?? 'block',
      cursorBlink: g('cursorBlink') === undefined ? true : g('cursorBlink') === '1',
      bgOpacity: num('bgOpacity', 1),
      bgBlur: g('bgBlur') === '1'
    }
  }
  setSettings(patch: Partial<Settings>): Settings {
    for (const [k, v] of Object.entries(patch)) {
      this.repo.setSetting(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
    }
    if (patch.encryptionEnabled) this.enableEncryptionKey()
    this.applyTiers()
    const next = this.getSettings()
    this.send('settings:changed', next)
    return next
  }

  private applyTiers(): void {
    const s = this.getSettings()
    this.extractor =
      s.extractionTier === 'heuristic'
        ? new HeuristicExtractor()
        : s.extractionTier === 'ollama'
          ? new OllamaExtractor()
          : new ClaudeCodeExtractor()
    // Embedder: hashing floor by default; opt into MiniLM via the embedTier key.
    this.embedder = this.repo.getSetting('embedTier') === 'transformers' ? new TransformersEmbedder() : new HashingEmbedder()
  }

  /** Generate an OS-keychain-protected key (spec §9). Full at-rest encryption
   *  needs the SQLCipher build of better-sqlite3 — see docs; this wires the key. */
  private enableEncryptionKey(): void {
    try {
      if (!this.repo.getSetting('encKey') && safeStorage.isEncryptionAvailable()) {
        const key = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
        this.repo.setSetting('encKey', safeStorage.encryptString(key).toString('base64'))
      }
    } catch {
      /* keychain unavailable (headless) — leave disabled */
    }
  }

  dispose(): void {
    this.capture.untrackAll()
    this.mirror.untrackAll()
    this.sync.dispose()
    this.pty.killAll()
  }
}
