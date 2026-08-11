import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dialog, shell, type WebContents } from 'electron'
import { openDatabase } from './db/database'
import { MemoryRepo } from './db/memories'
import { MemoryStore } from './pipeline/store'
import { ClaudeCodeExtractor } from './extract/claude'
import { HeuristicExtractor } from './extract/heuristic'
import { OllamaExtractor } from './extract/ollama'
import type { Extractor } from './extract/types'
import { CaptureService } from './capture/watcher'
import { CLAUDE_PROC_RE, SHELL_PROC_RE, decideSessionTab, procBase, type BindClaim, type BindingView } from './capture/binding'
import { promptOfRecord, readFrom, type UserPrompt } from './capture/parser'
import { ConversationStore } from './conversations/store'
import { MirrorService, MIRROR_ID_PREFIX } from './memory/mirror'
import { SyncService } from './sync/service'
import type { ImportResult } from './sync/merge'
import { PtyManager } from './pty/manager'
import { foregroundProc, processCwd } from './pty/cwd'
import { Retriever } from './retrieve/ranker'
import { ContextWriter, renderContext } from './inject/context'
import { EmbeddingService } from './embed/service'
import { HashingEmbedder, TransformersEmbedder, blobToVec, cosine, type Embedder } from './embed/embedder'
import { discoverClaudeInternals } from './internals/discover'
import { normalizeSettingsPatch, normalizeSettingValue } from './settings'
import { redact } from './pipeline/redact'
import { fingerprint } from './pipeline/fingerprint'
import { DEFAULT_THEME_ID, NERD_FONT_STACK, STALE_NERD_FONT_STACKS } from '../shared/themes'
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

// Wires the whole pipeline: DB + PTY + capture + extract + store +
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
  private readonly semanticCache = new Map<string, { at: number; value: Map<string, number> }>()
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
      () => this.send('prompts:changed', null),
      (p) => this.claimTabForSession(p)
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
    // Repair tabs created by older builds while process.cwd() was '/'.
    this.repo.retargetRootCwdTabs(defaultTabCwd())
    // A tab-less Space is NOT seeded here: first launch (and an all-tabs-closed
    // relaunch) lands on the renderer's welcome screen, where the user picks a
    // Claude or shell tab themselves — instead of a shell tab popping open over
    // the welcome flash. (createSpace still seeds: a just-created Space should
    // be immediately usable.)
    this.applyTiers()
    this.runMaintenance()
    this.embed.backfillActive()
    this.maybeReseed() // one-time purge of debugging-era clutter + reseed from curated sources
    this.activateCapture(this.getActiveSpace()) // tail transcripts + mirror Claude Code memory
    // unref'd like the sync timer: selftest constructs Cores and must exit.
    this.cwdTimer = setInterval(() => void this.followLiveCwds(), 10_000)
    this.cwdTimer.unref()
    // Faster than the cwd poll: reading node-pty's foreground-process getter is
    // a cheap native call, and the icon swap should land within a couple of
    // seconds of `claude` starting, not ten.
    this.procTimer = setInterval(() => void this.followLiveProcs(), 2000)
    this.procTimer.unref()
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
    this.repo.createTab({ id: randomUUID(), spaceId: id, kind: 'shell', title: 'shell', cwd: defaultTabCwd(), now })
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
    for (const t of this.repo.listTabs(id)) {
      this.pty.kill(t.id)
      this.capture.releaseTab(t.id) // deleteSpace cascades the tab rows below
    }
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
    // Enriched with the live terminal state the DB can't know: what the PTY is
    // running right now (sidebar swaps a shell tab's icon to claude on it) and
    // where it has cd'd to (the row's identifying description).
    return this.repo.listTabs(spaceId).map((t) => ({
      ...t,
      proc: this.liveProcs.get(t.id) ?? this.pty.processName(t.id) ?? null,
      liveCwd: this.liveCwds.get(t.id) ?? null
    }))
  }
  async createTab(opts: TabCreateOptions): Promise<Tab> {
    const id = randomUUID()
    const kind: TabKind = opts.kind ?? 'shell'
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
      this.capture.rebindTab(id, newId)
    } else {
      this.capture.releaseTab(id)
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
      this.capture.releaseTab(t.id)
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

    if (res.fresh) {
      // A brand-new PTY paints a blank screen: everything the previous one had
      // on it — its claude, a hand-started session, the prompts in its
      // scrollback — is gone with it.
      this.spawnEnded.delete(tab.id)
      this.sawClaude.delete(tab.id)
      this.handSessions.delete(tab.id)
      this.claudeSince.delete(tab.id)
      this.clearScreenSessions(tab.id)
    }
    if (res.fresh && tab.kind === 'claude') {
      this.repo.insertSession({
        id: res.sessionId,
        tabId: tab.id,
        ccSessionId: res.sessionId,
        transcriptPath: res.transcriptPath,
        startedAt: Date.now(),
        status: 'live'
      })
      // insertSession is ON CONFLICT DO NOTHING, so a RESUMED session (the row
      // already exists, possibly bound to another tab or to none) would keep
      // its old tab_id and never attach here.
      this.repo.bindSession(res.sessionId, tab.id)
      this.noteOnScreen(tab.id, res.sessionId, res.transcriptPath, !!resumeSessionId)
    }
    if (res.fresh && (tab.kind === 'claude' || tab.kind === 'shell')) {
      // Capture is bound to the cwd's transcript dir, not this one session — so a
      // tab the user never types into doesn't matter, and conversations run in an
      // external terminal (or a manually restarted `claude`) are captured too.
      // Shell tabs count: a `claude` the user starts by hand inside one writes to
      // the same transcript dir, and the arbiter binds its session to this tab
      // (external-app sessions in the same dir are captured but stay unbound).
      this.capture.trackProject(tab.spaceId, tab.cwd, tab.id)
      // Mirror too: bootstrap no longer seeds a tab, so on a fresh install the
      // first user-created tab is what kicks off mirroring Claude Code's own
      // memory files (previously the seeded shell tab did via activateCapture).
      this.mirror.track(tab.spaceId, tab.cwd)
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

  /** Raw pty.process value last seen per live tab — the cheap change signal.
   *  It reports the foreground TITLE, which claude rewrites to a bare version
   *  string ("2.1.220"), so it can't be shown or matched directly. */
  private readonly rawProcs = new Map<string, string>()
  /** OS-resolved foreground executable per live tab (tpgid → comm) — what
   *  listTabs serves. A change (shell → claude, claude exits back to shell,
   *  vim opens…) pushes tab:changed so the sidebar refetches and the row's
   *  icon + description track what's actually running. */
  private readonly liveProcs = new Map<string, string>()
  private procTimer: NodeJS.Timeout | null = null
  private procsBusy = false

  /** Claude tabs whose auto-spawned claude has exited back to the shell
   *  (`claude …; exec $SHELL -il`). Until then, any OTHER session writing to
   *  the tab's project dir is by definition from another app; after, a claude
   *  on this tab's screen must be hand-started. Reset on fresh spawn. */
  private readonly spawnEnded = new Set<string>()
  /** tabId → the discovered session claimed as the tab's on-screen
   *  hand-started claude. Held until that claude leaves the screen for a
   *  shell, so a concurrent external session can't ride along. */
  private readonly handSessions = new Map<string, string>()
  /** Tabs where claude has been seen in the foreground at least once during
   *  this PTY's life — without it, the login shell a claude tab starts in
   *  reads as "the spawned claude already exited". */
  private readonly sawClaude = new Set<string>()
  /** tabId → when claude first appeared in the foreground of this pane (and
   *  still is). Undefined once it leaves. */
  private readonly claudeSince = new Map<string, number>()

  private async followLiveProcs(): Promise<void> {
    if (this.procsBusy) return // ps lookups outliving the 2s tick must not stack
    this.procsBusy = true
    try {
      const live = new Set(this.pty.liveTabIds())
      const dirty = new Set<string>()
      for (const tabId of [...this.rawProcs.keys()]) {
        if (live.has(tabId)) continue
        // PTY gone (exit / tab close): the row survives with proc=null, so its
        // icon and description need one last refresh to drop the stale program.
        this.rawProcs.delete(tabId)
        this.liveProcs.delete(tabId)
        this.spawnEnded.delete(tabId)
        this.sawClaude.delete(tabId)
        this.handSessions.delete(tabId)
        this.claudeSince.delete(tabId)
        const tab = this.repo.getTab(tabId)
        if (tab) dirty.add(tab.spaceId)
      }
      const ids = [...live]
      for (let i = 0; i < ids.length; i += 4) {
        await Promise.all(
          ids.slice(i, i + 4).map(async (tabId) => {
            const raw = this.pty.processName(tabId) ?? ''
            if (this.rawProcs.get(tabId) === raw) return
            this.rawProcs.set(tabId, raw)
            const pid = this.pty.pid(tabId)
            const resolved = (pid ? await foregroundProc(pid) : null) ?? raw
            if (this.liveProcs.get(tabId) === resolved) return // title churn, same program
            this.liveProcs.set(tabId, resolved)
            const tab = this.repo.getTab(tabId)
            const base = procBase(resolved)
            if (!SHELL_PROC_RE.test(base)) this.pty.flushPendingResize(tabId)
            // LEVEL-triggered, not edge-triggered: a shell on screen proves the
            // pane's claude ended, even when a 2s poll misses the transition.
            if (SHELL_PROC_RE.test(base)) {
              this.handSessions.delete(tabId)
              if (tab?.kind === 'claude' && this.sawClaude.has(tabId)) this.spawnEnded.add(tabId)
            } else if (CLAUDE_PROC_RE.test(base)) {
              this.sawClaude.add(tabId)
              if (!this.claudeSince.has(tabId)) this.claudeSince.set(tabId, Date.now())
            }
            if (!CLAUDE_PROC_RE.test(base)) this.claudeSince.delete(tabId)
            if (tab) dirty.add(tab.spaceId)
          })
        )
      }
      for (const spaceId of dirty) this.send('tab:changed', spaceId)
    } finally {
      this.procsBusy = false
    }
  }

  /** Arbiter behind CaptureService: which tab (if any) does a discovered
   *  transcript session run in? Applies decideSessionTab's verdict to live
   *  state (hand-session claims, stale-binding self-heal). Public for selftest. */
  claimTabForSession(p: BindClaim): string | null {
    // Windows has no foreground-process resolution (ConPTY reports the spawned
    // shell), so the arbiter would refuse everything — keep blind rep binding.
    if (process.platform === 'win32') return p.repTabId
    const d = decideSessionTab(this.bindingView(), p)
    if (d.handClaim) this.handSessions.set(d.handClaim, p.sessionId)
    if (d.unbindFrom) this.repo.unbindSession(p.sessionId, d.unbindFrom)
    if (d.tabId) {
      // A session claude was ALREADY writing before it appeared in this pane is
      // a resume (`claude --resume`/`-c` by hand), which repaints only the tail.
      const since = this.claudeSince.get(d.tabId)
      let resumed = false
      try {
        resumed = since !== undefined && statSync(p.transcriptPath).birthtimeMs < since
      } catch {
        /* transcript vanished — treat as fresh */
      }
      this.noteOnScreen(d.tabId, p.sessionId, p.transcriptPath, resumed)
    }
    return d.tabId
  }

  private bindingView(): BindingView {
    return {
      tab: (id) => this.repo.getTab(id),
      // One transcript directory can be open in more than one Space. Search
      // every tab so switching Spaces cannot hide the PTY that owns a session.
      tabsInSpace: () => this.repo.listSpaces().flatMap((space) => this.repo.listTabs(space.id)),
      liveSessionId: (id) => this.pty.get(id)?.sessionId,
      foregroundBase: (id) => procBase(this.liveProcs.get(id)),
      spawnEnded: (id) => this.spawnEnded.has(id),
      handSession: (id) => this.handSessions.get(id),
      liveCwd: (id) => this.liveCwds.get(id),
      boundTab: (sessionId) => this.repo.sessionTab(sessionId),
      claudeSince: (id) => this.claudeSince.get(id),
      transcriptBornAt: (path) => {
        try {
          return statSync(path).birthtimeMs || undefined // 0 = filesystem doesn't record it
        } catch {
          return undefined
        }
      }
    }
  }

  /** Capture follows the terminal, not just the tab row: after a `cd`, a
   *  hand-started `claude` writes transcripts under the NEW cwd's project dir,
   *  which spawn-time tracking never watches — its sessions (and their prompts)
   *  would stay invisible. Poll each live shell's real cwd and extend tracking
   *  when it moves. */
  private cwdsBusy = false

  private async followLiveCwds(): Promise<void> {
    if (this.cwdsBusy) return // lsof lookups outliving the 10s tick must not stack
    this.cwdsBusy = true
    try {
      const live = new Set(this.pty.liveTabIds())
      for (const tabId of this.liveCwds.keys()) if (!live.has(tabId)) this.liveCwds.delete(tabId)
      const ids = [...live]
      for (let i = 0; i < ids.length; i += 4) {
        await Promise.all(
          ids.slice(i, i + 4).map(async (tabId) => {
            const tab = this.repo.getTab(tabId)
            if (!tab || (tab.kind !== 'claude' && tab.kind !== 'shell')) return
            const pid = this.pty.pid(tabId)
            if (!pid) return
            const cwd = await processCwd(pid)
            if (!cwd || cwd === this.liveCwds.get(tabId) || cwd === tab.cwd) return
            this.liveCwds.set(tabId, cwd)
            this.capture.trackProject(tab.spaceId, cwd, tabId)
            this.mirror.track(tab.spaceId, cwd)
          })
        )
      }
    } finally {
      this.cwdsBusy = false
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

  /** Compute the ranked set and write the injection artifact. */
  private async writeInjection(spaceId: string, cwd: string): Promise<{ contextPath: string; tokens: number }> {
    const space = this.repo.listSpaces().find((s) => s.id === spaceId)
    const seed = [basename(cwd), space?.name ?? '', ...this.repo.listTabs(spaceId).map((t) => t.title)].join(' ')
    const sim = await this.semanticSim(spaceId, seed)
    const { selected, tokens } = this.retriever.select({ spaceId, seed, now: Date.now() }, sim)
    const { contextPath } = this.inject.write(cwd, selected, space?.name ?? 'Space', this.getSettings().injectionAdapter)
    return { contextPath, tokens }
  }

  // --- PTY snapshots (visual restore) ---
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
      this.send('internals:changed', null)
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
  /** Parsed prompts per rendered span (keyed `${from}:${path}`) plus the byte
   *  offset already consumed. A live transcript grows every few seconds while
   *  claude streams, so a size+mtime cache alone misses on every refetch — and
   *  synchronously re-reading a multi-MB file each second stalled the main
   *  process, and with it every PTY input/output/resize IPC. Only the appended
   *  bytes are read; the quiet case still short-circuits on size+mtime. */
  private readonly promptsCache = new Map<
    string,
    { size: number; mtimeMs: number; offset: number; caughtUp: boolean; prompts: UserPrompt[] }
  >()

  /** tabId → sessionId → the span of that transcript this tab's CURRENT
   *  terminal has rendered. Cleared whenever a fresh PTY replaces the screen;
   *  survives a Space switch, where the same PTY is re-attached and its
   *  scrollback replayed. The prompt sidebar reads only this. */
  private readonly screenSessions = new Map<string, Map<string, { path: string; from: number }>>()

  private clearScreenSessions(tabId: string): void {
    const sessions = this.screenSessions.get(tabId)
    if (sessions) {
      for (const span of sessions.values()) this.promptsCache.delete(`${span.from}:${span.path}`)
    }
    this.screenSessions.delete(tabId)
  }

  /** Every prompt this tab's CURRENT terminal actually put on screen, grouped
   *  per tab and in conversation order.
   *
   *  Deliberately built from run state (`screenSessions`), never from
   *  `sessions.tab_id`. A DB binding answers "which conversation belongs to
   *  this tab", which outlives the terminal that rendered it; the sidebar needs
   *  "what is in this pane's scrollback right now", which no persisted row can
   *  claim. Conflating the two is what let a claude driven from another app on
   *  the same project list its prompts here — and what made every jump into a
   *  previous run's conversation miss, since a fresh PTY replays nothing. */
  listPrompts(spaceId: string): TabPrompts[] {
    const out: TabPrompts[] = []
    for (const t of this.repo.listTabs(spaceId)) {
      if (t.kind !== 'claude' && t.kind !== 'shell') continue
      const onScreen = this.screenSessions.get(t.id)
      if (!onScreen?.size) continue
      const spans = [...onScreen.values()]
      // One span keeps the cached array identity (cheap no-change refetch).
      const prompts = spans.length === 1 ? this.promptsFor(spans[0]) : spans.flatMap((s) => this.promptsFor(s))
      if (prompts.length) out.push({ tabId: t.id, tabTitle: t.title, prompts })
    }
    return out
  }

  /** A transcript, and the byte offset from which this terminal rendered it.
   *  `from` is 0 for a session that STARTED on this screen; for a resumed one
   *  it is the file size at resume, because `claude --resume` repaints only
   *  the tail — listing the history it never redrew would promise jumps that
   *  cannot land. */
  private screenSpanFor(path: string, resumed: boolean): { path: string; from: number } {
    if (!resumed) return { path, from: 0 }
    try {
      return { path, from: statSync(path).size }
    } catch {
      return { path, from: 0 } // no transcript yet — nothing to skip
    }
  }

  /** Record that a session is now rendering into a tab's terminal. Keyed by
   *  session so re-claims are idempotent; insertion order is conversation
   *  order (a hand-restarted claude follows the one it replaced). Called by
   *  spawnTab and the binding arbiter — the only two moments a conversation
   *  can reach a screen. Public for selftest, which has no real PTYs. */
  noteOnScreen(tabId: string, sessionId: string, path: string, resumed: boolean): void {
    let m = this.screenSessions.get(tabId)
    if (!m) {
      m = new Map()
      this.screenSessions.set(tabId, m)
    }
    if (!m.has(sessionId)) m.set(sessionId, this.screenSpanFor(path, resumed))
    while (m.size > 25) {
      const oldest = m.entries().next().value as [string, { path: string; from: number }] | undefined
      if (!oldest) break
      m.delete(oldest[0])
      this.promptsCache.delete(`${oldest[1].from}:${oldest[1].path}`)
    }
  }

  private promptsFor(span: { path: string; from: number }): UserPrompt[] {
    let st: { size: number; mtimeMs: number }
    try {
      st = statSync(span.path)
    } catch {
      return [] // no transcript yet (fresh session) or pruned
    }
    const key = `${span.from}:${span.path}`
    const hit = this.promptsCache.get(key)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.caughtUp) return hit.prompts
    let prior = hit?.prompts ?? []
    let read = readFrom(span.path, hit?.offset ?? span.from, 1024 * 1024)
    if (read.reset) {
      // File shrank (truncation/rotation) — re-baseline from the span start.
      prior = []
      read = readFrom(span.path, span.from, 1024 * 1024)
      // Shrunk below even the span start: nothing this screen rendered exists
      // anymore. Hold at span.from rather than 0 — falling back to the top
      // would list history this terminal never drew.
      if (read.reset) read = { reset: true, records: [], newOffset: span.from, hasMore: false }
    }
    const fresh = read.records.map(promptOfRecord).filter((p): p is UserPrompt => p !== null)
    const prompts = fresh.length ? prior.concat(fresh) : prior
    this.promptsCache.set(key, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      offset: read.newOffset,
      caughtUp: !read.hasMore,
      prompts
    })
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

  // --- "forget about X": semantic family when enabled, lexical otherwise ---
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
    const key = `${this.embedder.model}\x00${spaceId}\x00${seed}`
    const cached = this.semanticCache.get(key)
    if (cached && Date.now() - cached.at < 1000) {
      this.semanticCache.delete(key)
      this.semanticCache.set(key, cached) // true LRU: refresh insertion order
      return new Map(cached.value)
    }
    try {
      const qv = await this.embedder.embed(seed)
      const map = new Map<string, number>()
      for (const { id, vec } of this.repo.listEmbeddings(spaceId, this.embedder.model)) map.set(id, cosine(qv, blobToVec(vec)))
      this.semanticCache.set(key, { at: Date.now(), value: map })
      while (this.semanticCache.size > 8) this.semanticCache.delete(this.semanticCache.keys().next().value as string)
      return new Map(map)
    } catch {
      return undefined
    }
  }

  /** Salience decay + auto-archive below a floor. Archive ≠ forget:
   *  no tombstone, so an archived fact can re-derive if it recurs. */
  runMaintenance(now = Date.now()): { archived: number } {
    const HALF_LIFE_DAYS = 30
    const FLOOR = 0.05
    const MIN_AGE_DAYS = 14
    let archived = 0
    this.repo.transaction(() => {
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
    })()
    if (archived) this.send('memory:changed', null)
    return { archived }
  }

  // --- settings ---
  // A stack persisted before the Nerd Fonts v3 rename resolves to no installed
  // family, so the prompt renders as tofu. Treat those stored values as unset.
  private liveFontFamily(stored: string | undefined): string {
    if (stored === undefined || STALE_NERD_FONT_STACKS.includes(stored)) return NERD_FONT_STACK
    return stored
  }
  getSettings(): Settings {
    const g = (k: string): string | undefined => {
      const value = this.repo.getSetting(k)
      return value === undefined ? undefined : normalizeSettingValue(k, value)
    }
    const num = (k: string, dflt: number): number => {
      const n = Number(g(k))
      return Number.isFinite(n) && g(k) !== undefined && g(k) !== '' ? n : dflt
    }
    return {
      injectionAdapter: (g('injectionAdapter') as Settings['injectionAdapter']) ?? 'file',
      extractionTier: (g('extractionTier') as Settings['extractionTier']) ?? 'claude',
      semanticEnabled: g('semanticEnabled') === '1',
      restorePinnedSessions: g('restorePinnedSessions') === undefined ? true : g('restorePinnedSessions') === '1',
      fontFamily: this.liveFontFamily(g('fontFamily')),
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
    for (const [key, value] of Object.entries(normalizeSettingsPatch(patch))) this.repo.setSetting(key, value)
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

  dispose(): void {
    if (this.cwdTimer) clearInterval(this.cwdTimer)
    if (this.procTimer) clearInterval(this.procTimer)
    this.capture.untrackAll()
    this.mirror.untrackAll()
    this.sync.dispose()
    this.pty.killAll()
  }
}
