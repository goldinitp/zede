// The typed surface the renderer is allowed to touch, shared by preload
// (which implements it) and the renderer (which consumes window.zede). Spec §4.2.

export type MemoryType = 'fact' | 'decision' | 'preference' | 'entity' | 'todo'
export type Scope = 'session' | 'repo' | 'project' | 'workspace' | 'space' | 'user' | 'global' | (string & {})
export type ScopeHint = 'space' | 'global'
export type MemoryStatus = 'active' | 'superseded' | 'tombstoned' | 'archived'

export interface Memory {
  id: string
  spaceId: string | null
  scope: Scope
  type: MemoryType
  content: string
  confidence: number | null
  salience: number | null
  status: MemoryStatus
  pinned: boolean
  useCount: number
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

// --- spatial model (M2) ---
export type TabKind = 'claude' | 'shell' | 'memory' | 'internal'

export interface Space {
  id: string
  name: string
  icon: string | null
  sortOrder: number
  createdAt: number
  /** The Space opened on launch (set via "Make Default Space"). */
  isDefault?: boolean
}

export interface Tab {
  id: string
  spaceId: string
  kind: TabKind
  title: string
  cwd: string
  pinned: boolean
  sortOrder: number
  /** For kind==='memory': the id of the memory this tab displays. */
  ref?: string | null
}

export interface TabCreateOptions {
  spaceId: string
  kind?: TabKind
  cwd?: string
  title?: string
  /** For kind==='memory': the memory id to open. */
  ref?: string
}

// --- forgetting / recently-forgotten (M2/M4) ---
export interface ForgottenItem {
  tombstoneId: string
  memoryId: string
  content: string
  type: MemoryType | null
  forgottenAt: number
  reason: string
}

// --- retrieval preview (M2) ---
export interface InjectionPreview {
  memories: Memory[]
  tokens: number
  adapter: string
}

// --- edit history / diff (M4) ---
export interface MemoryEdit {
  before: string
  after: string
  editedAt: number
}

// --- detail view (a memory opened in its own tab) ---
export interface MemorySource {
  sessionId: string
  transcriptPath: string
  spanStart: number
  spanEnd: number
  excerpt: string
}
export interface MemoryDetail {
  memory: Memory
  sources: MemorySource[]
  edits: MemoryEdit[]
  /** 'claude-memory' = mirrored from Claude Code's own memory store; 'distilled' = extracted from a transcript. */
  origin: 'claude-memory' | 'distilled'
}

// --- Claude internals navigator ---
export type ClaudeInternalKind = 'skill' | 'plugin' | 'mcp-server' | 'tool'

export interface ClaudeInternalItem {
  id: string
  kind: ClaudeInternalKind
  name: string
  description: string
  scope: Scope
  source: string
  path: string | null
  parentId?: string
}

export interface ClaudeInternalsSnapshot {
  items: ClaudeInternalItem[]
  refreshedAt: number
}

/** An internal opened in its own tab: the item, its file content (when file-backed) and nested items. */
export interface ClaudeInternalDetail {
  item: ClaudeInternalItem
  /** Full file content for file-backed items (SKILL.md, tool .json); null for directories. */
  content: string | null
  /** True when `content` can be edited and saved back to disk. */
  editable: boolean
  /** Items nested under this one (a plugin's skills, an MCP server's tools). */
  children: ClaudeInternalItem[]
}

// --- saved conversations (per-tab transcript snapshots) ---
/** Metadata for a conversation saved to a local JSON file. The file also holds
 *  the raw transcript so a long conversation survives even if Claude Code's own
 *  transcript is pruned; loading restores it and resumes the session. */
export interface SavedConversation {
  id: string
  title: string
  /** The Claude Code session UUID — loading resumes this session. */
  sessionId: string
  cwd: string
  savedAt: number
  messageCount: number
  /** First user message, truncated — shown in the picker. */
  preview: string
  filePath: string
}

// --- PTY ---
export interface PtySpawnOptions {
  tabId: string
  spaceId?: string
  cwd?: string
  kind?: TabKind
  autoClaude?: boolean
}
export interface PtyInputPayload {
  tabId: string
  data: string
}
export interface PtyResizePayload {
  tabId: string
  cols: number
  rows: number
}
export interface PtyKillPayload {
  tabId: string
}
export interface PtyDataEvent {
  tabId: string
  chunk: string
}
export interface PtyExitEvent {
  tabId: string
  exitCode: number
}
export interface PtySnapshot {
  scrollback: string
  cols: number
  rows: number
}

// --- settings (M3/M4) ---
export type CursorStyle = 'block' | 'underline' | 'bar'

export interface Settings {
  injectionAdapter: 'file' | 'flag'
  extractionTier: 'claude' | 'heuristic' | 'ollama'
  semanticEnabled: boolean
  encryptionEnabled: boolean
  pinnedTabPinsMemory: boolean
  /** On app relaunch, a pinned Claude tab resumes its last session instead of starting fresh. */
  restorePinnedSessions: boolean
  // --- appearance (iTerm-style) ---
  fontFamily: string
  fontSize: number
  /** Vertical line spacing as a multiple of the font size (xterm lineHeight; 1.0 = tight). */
  lineHeight: number
  /** Horizontal spacing between cells, in pixels (xterm letterSpacing). */
  letterSpacing: number
  /** Lines of history kept for scrollback. */
  scrollback: number
  theme: string
  cursorStyle: CursorStyle
  cursorBlink: boolean
  bgOpacity: number
  bgBlur: boolean
}

// --- sync (user-owned, git-backed cross-machine sync) ---
export type SyncAuthMode = 'github-app' | 'gh-cli' | 'git'

export interface SyncStatus {
  configured: boolean
  busy: boolean
  authMode: SyncAuthMode | null
  /** GitHub login when signed in (github-app or gh-cli mode). */
  ghLogin: string | null
  remoteUrl: string | null
  encryption: boolean
  /** Encrypted repo but no usable key on this machine — user must re-enter the passphrase. */
  needsPassphrase: boolean
  gitAvailable: boolean
  ghAvailable: boolean
  lastSyncAt: number | null
  /** Human-readable outcome of the last sync ("pushed 3 · pulled 1", or an error). */
  lastResult: string | null
  /** Set while a GitHub device-flow sign-in is pending. */
  deviceFlow: { userCode: string; verificationUri: string } | null
  /** Where the user grants the GitHub App access to only the selected repo. */
  appInstallUrl: string
}

export interface SyncSetupOptions {
  authMode: SyncAuthMode
  /** GitHub modes: repo as "name" (own account) or "owner/name". */
  repo?: string
  /** authMode 'git': any git remote URL (GitLab, NAS over ssh, local bare repo). */
  remoteUrl?: string
  /** Encrypt memory bodies (applies to fresh repos; joining adopts the repo's setting). */
  encrypt?: boolean
  /** Required when encrypt=true or when joining an already-encrypted repo. */
  passphrase?: string
}

export interface SyncResult {
  ok: boolean
  error?: string
  /** Fetch/push failed but the local commit is safe — it ships next sync. */
  offline?: boolean
  pushed: boolean
  memoriesAdded: number
  memoriesUpdated: number
  tombstonesApplied: number
  spacesChanged: number
  settingsChanged: number
  /** Corrupt/foreign files in the repo that were skipped, never fatal. */
  skippedFiles: number
}

export interface ZedeApi {
  ping(): Promise<string>
  pty: {
    spawn(opts: PtySpawnOptions): Promise<{ sessionId: string; fresh: boolean }>
    input(tabId: string, data: string): void
    resize(tabId: string, cols: number, rows: number): void
    kill(tabId: string): void
    snapshot(tabId: string, snap: PtySnapshot): void
    getSnapshot(tabId: string): Promise<PtySnapshot | null>
    onData(cb: (e: PtyDataEvent) => void): () => void
    onExit(cb: (e: PtyExitEvent) => void): () => void
  }
  space: {
    list(): Promise<Space[]>
    create(name: string, icon?: string): Promise<Space>
    rename(id: string, name: string): Promise<void>
    setIcon(id: string, icon: string): Promise<void>
    remove(id: string): Promise<void>
    reorder(ids: string[]): Promise<void>
    getActive(): Promise<string>
    setActive(id: string): Promise<void>
    /** Make this the Space opened on launch. */
    setDefault(id: string): Promise<void>
    onChanged(cb: () => void): () => void
  }
  tab: {
    list(spaceId: string): Promise<Tab[]>
    create(opts: TabCreateOptions): Promise<Tab>
    close(id: string): Promise<void>
    /** Close every unpinned tab in the Space; pinned tabs are kept. */
    closeAll(spaceId: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    setPinned(id: string, pinned: boolean): Promise<void>
    reorder(spaceId: string, ids: string[]): Promise<void>
    /** Duplicate a tab (same kind + cwd) into the same Space. */
    duplicate(id: string): Promise<Tab | undefined>
    /** Move a tab to another Space. */
    move(id: string, spaceId: string): Promise<void>
    onChanged(cb: (spaceId: string) => void): () => void
  }
  memory: {
    list(spaceId: string): Promise<Memory[]>
    search(spaceId: string, q: string): Promise<Memory[]>
    delete(id: string, hard?: boolean): Promise<boolean>
    undo(id: string): Promise<boolean>
    setPinned(id: string, pinned: boolean): Promise<boolean>
    edit(id: string, content: string): Promise<Memory | null>
    /** What would be injected into a fresh session in this Space (ranked + budgeted). */
    preview(spaceId: string): Promise<InjectionPreview>
    /** Semantic batch-forget (M3): preview the family, then confirm to tombstone all. */
    forgetAboutPreview(spaceId: string, query: string): Promise<Memory[]>
    forgetAboutConfirm(spaceId: string, query: string): Promise<number>
    recentlyForgotten(spaceId: string): Promise<ForgottenItem[]>
    history(id: string): Promise<MemoryEdit[]>
    shareToSpace(id: string, spaceId: string): Promise<void>
    /** Full detail for the memory tab: the memory + its sources + edit history. */
    detail(id: string): Promise<MemoryDetail | null>
    /** Purge distilled memories and re-seed from curated sources (Claude Code memory). Returns mirrored count. */
    rebuild(spaceId: string): Promise<number>
    exportAll(spaceId: string, format: 'json' | 'markdown'): Promise<string>
    /** Export to a user-chosen file via a save dialog; returns the path or null. */
    exportSave(spaceId: string, format: 'json' | 'markdown'): Promise<string | null>
    /** "Just learned…" stream. */
    onLearned(cb: (m: Memory) => void): () => void
    onForgotten(cb: (id: string) => void): () => void
    onChanged(cb: () => void): () => void
  }
  conversation: {
    /** Snapshot the tab's Claude conversation into a local JSON file, titled
     *  `title` (falls back to the tab title). Rejects with a message when the
     *  tab has no recorded conversation yet. */
    save(tabId: string, title?: string): Promise<SavedConversation>
    list(): Promise<SavedConversation[]>
    /** Retitle an existing save. Returns the updated metadata, or null if the save is gone. */
    rename(id: string, title: string): Promise<SavedConversation | null>
    /** Restore the transcript if needed, open a new tab and resume the session.
     *  With `compact`, `/compact` is sent once the resumed session settles. */
    load(id: string, opts?: { spaceId?: string; compact?: boolean }): Promise<Tab>
    delete(id: string): Promise<boolean>
  }
  internals: {
    /** Local Claude/Cursor internals visible to this Space: skills, plugins, MCP servers and tools. */
    list(spaceId: string): Promise<ClaudeInternalsSnapshot>
    /** Full detail for the internal tab: the item + file content + nested items. */
    detail(spaceId: string, id: string): Promise<ClaudeInternalDetail | null>
    /** Write edited content back to the item's file. Only file-backed items are writable. */
    save(spaceId: string, id: string, content: string): Promise<boolean>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    /** Fires whenever settings change (e.g. appearance), with the new values. */
    onChanged(cb: (s: Settings) => void): () => void
  }
  sync: {
    status(): Promise<SyncStatus>
    /** Begin the GitHub device-flow sign-in; the returned status carries the
     *  user code, and the verification page opens in the browser. */
    loginStart(): Promise<SyncStatus>
    loginCancel(): Promise<void>
    /** Connect to a repo (creates/validates as needed) and run the first sync. */
    setup(opts: SyncSetupOptions): Promise<SyncResult>
    now(): Promise<SyncResult>
    /** Re-enter the passphrase for an encrypted repo on a new machine. */
    unlock(passphrase: string): Promise<SyncStatus>
    disconnect(deleteFiles?: boolean): Promise<void>
    /** Open a sync-related page in the browser: the prefilled new-repo form or
     *  the GitHub App install (repo-selection) page. */
    open(target: 'new-repo' | 'install', repoName?: string): Promise<void>
    onStatus(cb: (s: SyncStatus) => void): () => void
  }
  ui: {
    /** Fired by the app menu (Cmd/Ctrl+M) — toggles the memory panel. */
    onToggleMemory(cb: () => void): () => void
    /** Fired by the app menu (Cmd/Ctrl+S) — toggles the Spaces sidebar. */
    onToggleSidebar(cb: () => void): () => void
    /** Fired by the app menu (Cmd/Ctrl+,) — opens Settings/Preferences. */
    onOpenSettings(cb: () => void): () => void
    /** Toggle the window's macOS vibrancy (frosted background blur). */
    setVibrancy(on: boolean): void
    /** Fires when the window enters/leaves macOS fullscreen (traffic lights auto-hide there). */
    onFullScreenChanged(cb: (fullscreen: boolean) => void): () => void
    /** Open the native macOS Emoji & Symbols picker; it inserts into the focused input. */
    showEmojiPanel(): void
  }
}

declare global {
  interface Window {
    zede: ZedeApi
  }
}
