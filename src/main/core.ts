import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dialog, safeStorage, shell, type WebContents } from 'electron'
import { openDatabase } from './db/database'
import { MemoryRepo } from './db/memories'
import { MemoryStore } from './pipeline/store'
import { ClaudeCodeExtractor } from './extract/claude'
import { HeuristicExtractor } from './extract/heuristic'
import { OllamaExtractor } from './extract/ollama'
import type { Extractor } from './extract/types'
import { CaptureService } from './capture/watcher'
import { userPrompts, type UserPrompt } from './capture/parser'
import { ConversationStore } from './conversations/store'
import { MirrorService, MIRROR_ID_PREFIX } from './memory/mirror'
import { SyncService } from './sync/service'
import type { ImportResult } from './sync/merge'
import { PtyManager } from './pty/manager'
import { processCwd } from './pty/cwd'
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
  TabKind,
  TabPrompts
} from '../shared/api'

const DEFAULT_SPACE = { id: 'default', name: 'Default', icon: '🧵' }
const FORGET_ABOUT_COSINE = 0.45

/** Where a tab lives when no cwd was chosen. A Finder/Dock-launched Electron
 *  inherits `/` as process.cwd() — unwritable (no context injection) and not
 *  where anyone works, so every session starts with a `cd` that walks out of
 *  the watched transcript dir. Home is the useful default. */
export function defaultTabCwd(): string {
  const cwd = process.cwd()
  return cwd === '/' ? homedir() : cwd
}

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
  /** discoverClaudeInternals is a synchronous ~/.claude + per-cwd filesystem
   *  sweep — too heavy to run on every memory:changed re-list from the panel
   *  (it blocks the main process, and with it every IPC including pty data).
   *  A short TTL keeps it off the hot path; internalSave invalidates. */
  private internalsCache: { key: string; at: number; snap: ClaudeInternalsSnapshot } | null = null

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
    this.capture = new CaptureService(
      this.repo,
      () => this.extractor,
      this.store,
      () => Date.now(),
      (msg) => console.log('[capture]', msg),
      () => this.send('prompts:changed', null)
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
    // Repair tabs created by older builds while process.cwd() was '/'.
    this.repo.retargetRootCwdTabs(defaultTabCwd())
    if (this.repo.countTabs(active) === 0) {
      this.repo.createTab({ id: randomUUID(), spaceId: active, kind: 'claude', title: 'claude', cwd: defaultTabCwd(), now })
    }
    this.applyTiers()
    this.runMaintenance()
    this.embed.backfillActive()
    this.maybeReseed() // one-time purge of debugging-era clutter + reseed from curated sources
    this.activateCapture(this.getActiveSpace()) // tail transcripts + mirror Claude Code memory
    // unref'd like the sync timer: selftest constructs Cores and must exit.
    this.cwdTimer = setInterval(() => void this.followLiveCwds(), 10_000)
    this.cwdTimer.unref()
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
    this.repo.createTab({ id: randomUUID(), spaceId: id, kind: 'claude', title: 'claude', cwd: defaultTabCwd(), now })
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
  async createTab(opts: TabCreateOptions): Promise<Tab> {
    const id = randomUUID()
    const kind: TabKind = opts.kind ?? 'claude'
    const title = opts.title ?? (kind === 'shell' ? 'shell' : kind === 'memory' ? 'memory' : kind === 'internal' ? 'context' : 'claude')
    const cwd = opts.cwd ?? (await this.inheritedCwd(opts.cwdFromTabId)) ?? defaultTabCwd()
    this.repo.createTab({
      id,
      spaceId: opts.spaceId,
      kind,
      title,
      cwd,
      ref: opts.ref ?? null,
      now: Date.now()
    })
    this.send('tab:changed', opts.spaceId)
    return this.repo.getTab(id) as Tab
  }

  /** Live cwd of another tab, terminal-style (⌘T opens where the active tab is
   *  now, not where it spawned). The OS answer wins; a dead or never-spawned
   *  tab falls back to its recorded cwd. Memory/internal tabs have no directory. */
  private async inheritedCwd(tabId?: string): Promise<string | null> {
    if (!tabId) return null
    const src = this.repo.getTab(tabId)
    if (!src || (src.kind !== 'claude' && src.kind !== 'shell')) return null
    const pid = this.pty.pid(tabId)
    const live = pid ? await processCwd(pid) : null
    return live ?? this.liveCwds.get(tabId) ?? src.cwd
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
        cwd: opts.cwd ?? defaultTabCwd(),
        now
      })
      tab = this.repo.getTab(opts.tabId) as Tab
    }

    const settings = this.getSettings()
    let appendFile: string | undefined
    // Shell tabs get the file-adapter artifact too: a `claude` the user starts
    // by hand in that cwd imports the same context via CLAUDE.md. (The flag
    // adapter can't reach a manual start — nothing appends the flag for it.)
    const wantsInjection = tab.kind === 'claude' || (tab.kind === 'shell' && settings.injectionAdapter === 'file')
    if (wantsInjection && !this.pty.has(tab.id)) {
      const { contextPath } = await this.writeInjection(tab.spaceId, tab.cwd)
      appendFile = tab.kind === 'claude' && settings.injectionAdapter === 'flag' ? contextPath : undefined
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
    }
    if (res.fresh && (tab.kind === 'claude' || tab.kind === 'shell')) {
      // Capture is bound to the cwd's transcript dir, not this one session — so a
      // tab the user never types into doesn't matter, and conversations run in an
      // external terminal (or a manually restarted `claude`) are captured too.
      // Shell tabs count: a `claude` the user starts by hand inside one writes to
      // the same transcript dir, and the watcher binds its session to this tab.
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
   *  AND shell tabs (a `claude` started by hand in a shell tab must be captured
   *  too), backfilling transcripts already on disk. Idempotent. */
  activateCapture(spaceId: string): void {
    const seen = new Set<string>()
    for (const t of this.repo.listTabs(spaceId)) {
      if ((t.kind !== 'claude' && t.kind !== 'shell') || seen.has(t.cwd)) continue
      seen.add(t.cwd)
      this.capture.trackProject(spaceId, t.cwd, t.id)
      this.mirror.track(spaceId, t.cwd) // mirror Claude Code's curated memory for this cwd
    }
  }

  /** Last cwd each live tab was re-tracked at, so a `cd` registers once. */
  private readonly liveCwds = new Map<string, string>()
  private cwdTimer: NodeJS.Timeout | null = null

  /** Capture follows the terminal, not just the tab row: after a `cd`, a
   *  hand-started `claude` writes transcripts under the NEW cwd's project dir,
   *  which spawn-time tracking never watches — its sessions (and their prompts)
   *  would stay invisible. Poll each live shell's real cwd and extend tracking
   *  when it moves. */
  private async followLiveCwds(): Promise<void> {
    const live = new Set(this.pty.liveTabIds())
    for (const tabId of this.liveCwds.keys()) if (!live.has(tabId)) this.liveCwds.delete(tabId)
    for (const tabId of live) {
      const tab = this.repo.getTab(tabId)
      if (!tab || (tab.kind !== 'claude' && tab.kind !== 'shell')) continue
      const pid = this.pty.pid(tabId)
      if (!pid) continue
      const cwd = await processCwd(pid)
      if (!cwd || cwd === this.liveCwds.get(tabId) || cwd === tab.cwd) continue
      this.liveCwds.set(tabId, cwd)
      this.capture.trackProject(tab.spaceId, cwd, tabId)
      this.mirror.track(tab.spaceId, cwd)
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
    const cwds = [defaultTabCwd(), ...this.repo.listTabs(spaceId).map((t) => t.cwd)]
    const key = cwds.join('\x00')
    const now = Date.now()
    if (this.internalsCache && this.internalsCache.key === key && now - this.internalsCache.at < 5000) {
      return this.internalsCache.snap
    }
    const snap = discoverClaudeInternals({ cwds, now })
    this.internalsCache = { key, at: now, snap }
    return snap
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
      this.internalsCache = null // an edited skill/plugin must re-list fresh
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

  // --- chat prompt navigator (sidebar "Prompts" section) ---
  /** Parsed prompts per transcript, invalidated by size/mtime — the sidebar
   *  refreshes after every PTY burst, and most transcripts haven't changed. */
  private readonly promptsCache = new Map<string, { size: number; mtimeMs: number; prompts: UserPrompt[] }>()

  /** Every user prompt in each of the Space's chats, grouped per tab. Same
   *  session resolution as saveConversation: live PTY binding for claude tabs,
   *  else the last recorded session (covers exited claudes and shell tabs
   *  where a hand-started claude was bound by the watcher). */
  listPrompts(spaceId: string): TabPrompts[] {
    const out: TabPrompts[] = []
    for (const t of this.repo.listTabs(spaceId)) {
      if (t.kind !== 'claude' && t.kind !== 'shell') continue
      const live = t.kind === 'claude' ? this.pty.get(t.id) : undefined
      const latest = this.repo.latestSessionForTab(t.id)?.transcriptPath
      // Both can hold prompts at once: the auto-spawned claude's transcript
      // (live PTY binding) plus a newer session the watcher bound to this tab
      // (claude exited to the shell and the user hand-started another). The
      // recorded row, when different, out-sorted the spawn row by started_at,
      // so live-then-latest is chronological — matching the terminal buffer,
      // which occurrence-based jumping scans.
      const paths = [...new Set([live?.transcriptPath, latest])].filter((p): p is string => !!p)
      // Single path keeps the cached array identity (cheap no-change refetch).
      const prompts = paths.length === 1 ? this.promptsFor(paths[0]) : paths.flatMap((p) => this.promptsFor(p))
      if (prompts.length) out.push({ tabId: t.id, tabTitle: t.title, prompts })
    }
    return out
  }

  private promptsFor(path: string): UserPrompt[] {
    let st: { size: number; mtimeMs: number }
    try {
      st = statSync(path)
    } catch {
      return [] // no transcript yet (fresh session) or pruned
    }
    const hit = this.promptsCache.get(path)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.prompts
    const prompts = userPrompts(readFileSync(path, 'utf8'))
    this.promptsCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, prompts })
    return prompts
  }

  // --- saved conversations (local JSON snapshots of a tab's transcript) ---
  saveConversation(tabId: string, title?: string): SavedConversation {
    const tab = this.repo.getTab(tabId)
    if (!tab) throw new Error('Tab not found')
    // Prefer the live PTY binding; fall back to the last recorded session so a
    // tab whose claude has exited can still be saved from its transcript. A
    // shell tab's PTY binding is a placeholder (no claude was auto-run there),
    // so only watcher-discovered sessions count for it.
    const live = tab.kind === 'claude' ? this.pty.get(tabId) : undefined
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
    if (this.cwdTimer) clearInterval(this.cwdTimer)
    this.capture.untrackAll()
    this.mirror.untrackAll()
    this.sync.dispose()
    this.pty.killAll()
  }
}
