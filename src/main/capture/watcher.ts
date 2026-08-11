import { watch, mkdirSync, readdirSync, statSync, type FSWatcher } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { readFrom, recordsToSpans } from './parser'
import { transcriptDirFor } from './paths'
import { isInternalSession } from './internal'
import { redact } from '../pipeline/redact'
import type { Extractor } from '../extract/types'
import type { MemoryStore } from '../pipeline/store'
import type { MemoryRepo } from '../db/memories'

const DEBOUNCE_MS = 4000
const CLAIM_THROTTLE_MS = 250 // fs.watch can fire many times per streamed answer
const NOTIFY_THROTTLE_MS = 1000 // prompt-change pings to the renderer, at most ~1/s
const MAX_CONCURRENT = 2 // never starve the user's foreground claude
const BACKFILL_MAX_SPANS = 4 // cap spans distilled per never-seen transcript
const BACKFILL_MAX_FILES = 10 // cap transcripts backfilled per project dir
const READ_BUDGET_BYTES = 1024 * 1024 // bound synchronous JSONL parsing per job

interface FileState {
  timer?: NodeJS.Timeout
  claimTimer?: NodeJS.Timeout
  lastClaimAt?: number
  busy: boolean
}

function sessionIdOf(path: string): string {
  return basename(path).replace(/\.jsonl$/, '')
}

interface ProjectEntry {
  watcher: FSWatcher
  spaceId: string
  cwd: string
  dir: string
  repTabId: string | null
  files: Map<string, FileState>
}

// Tails the Claude Code transcript directory for a Space's cwd and runs new
// spans through the pipeline. Bound by cwd → project dir (NOT by the single
// session Zede spawns), so it captures external-terminal sessions and manually
// restarted `claude` too, and backfills transcripts that predate Zede. Each
// transcript is processed incrementally via its own byte-offset watermark.
//
// Capture ≠ binding: every transcript in the dir is distilled into memories,
// but only sessions the arbiter (`resolveTab`, see capture/binding.ts) judges
// to be running INSIDE a Zede tab get a tab_id — that binding is what surfaces
// prompts in the sidebar. A claude driven from another app on the same project
// writes to this same dir and must stay unbound.
export class CaptureService {
  private readonly projects = new Map<string, ProjectEntry>()
  private active = 0
  private activeBackfill = 0
  private disposed = false
  private readonly liveQueue: Array<() => Promise<void>> = []
  private readonly backfillQueue: Array<() => Promise<void>> = []
  private readonly retryTimers = new Map<string, NodeJS.Timeout>()
  private readonly retryCounts = new Map<string, number>()

  constructor(
    private readonly repo: MemoryRepo,
    private readonly extractor: () => Extractor,
    private readonly store: MemoryStore,
    private readonly now: () => number,
    private readonly log: (msg: string) => void = () => {},
    private readonly notify: () => void = () => {},
    /** Arbiter for discovered sessions (Core.claimTabForSession). Absent
     *  (selftest/spikes): fall back to blind rep-tab binding. Must only ever
     *  return a tab id that exists NOW — the insert that follows trusts it. */
    private readonly resolveTab?: (p: {
      sessionId: string
      repTabId: string | null
      cwd: string
      spaceId: string
      transcriptPath: string
    }) => string | null
  ) {}

  /** Start (idempotent) capture for a Space's cwd: watch the project dir for new
   *  + changed transcripts and backfill the ones already on disk. */
  trackProject(spaceId: string, cwd: string, repTabId?: string): void {
    if (this.disposed) return
    const dir = transcriptDirFor(cwd)
    const key = resolve(dir)
    const existing = this.projects.get(key)
    if (existing) {
      // Bound sessions derive their Space from the owning tab at flush time.
      // Keep this as the fallback only for external, unbound sessions.
      existing.spaceId = spaceId
      if (repTabId) existing.repTabId = repTabId
      return
    }
    try {
      // Claude Code creates this dir on the first session; create it up front so
      // the watch below attaches — fs.watch throws ENOENT on a missing path (and a
      // silent watch was the same failure that once kept the Memory pane empty).
      mkdirSync(dir, { recursive: true })
    } catch {
      /* best effort */
    }
    // Node's fs.watch (recursive → FSEvents on macOS) uses a SINGLE descriptor for
    // the whole subtree. chokidar v5 dropped its fsevents backend and instead opens
    // one fd PER FILE — on a Claude transcript dir with thousands of .jsonl files
    // that exhausted the process file-descriptor table, so child_process.spawn
    // started failing with EBADF and even node-pty could no longer open a terminal
    // (every tab died with "process exited: 0"). Directory-level watching is all the
    // pipeline needs: a new or appended transcript arrives as a change event
    // carrying its filename, and the per-file byte-offset watermark does the rest.
    let watcher: FSWatcher
    try {
      watcher = watch(dir, { persistent: true, recursive: true })
    } catch (e) {
      this.log(`capture: could not watch ${dir}: ${String(e)}`)
      this.scheduleRetry(key, spaceId, cwd, repTabId)
      return
    }
    const retry = this.retryTimers.get(key)
    if (retry) clearTimeout(retry)
    this.retryTimers.delete(key)
    this.retryCounts.delete(key)
    const entry: ProjectEntry = { watcher, spaceId, cwd, dir, repTabId: repTabId ?? null, files: new Map() }
    watcher.on('change', (_event, filename) => {
      if (!filename) return
      const name = filename.toString() // relative to `dir`; transcripts are top-level .jsonl
      if (!name.endsWith('.jsonl')) return
      try {
        this.scheduleFile(entry, resolve(join(dir, name)))
      } catch (e) {
        // A throw here is an uncaught exception in the main process — Electron
        // puts up a crash dialog on every FS event. Log and keep the app alive.
        this.log(`capture: schedule failed for ${name}: ${String(e)}`)
      }
    })
    watcher.on('error', (e) => {
      if (this.projects.get(key) !== entry) return
      this.log(`capture: watcher failed for ${dir}: ${String(e)}; retrying`)
      this.projects.delete(key)
      for (const state of entry.files.values()) {
        if (state.timer) clearTimeout(state.timer)
        if (state.claimTimer) clearTimeout(state.claimTimer)
      }
      void watcher.close()
      this.scheduleRetry(key, entry.spaceId, entry.cwd, entry.repTabId ?? undefined)
    })
    this.projects.set(key, entry)
    this.backfill(entry)
  }

  /** Distill transcripts already on disk (newest first, capped) so the Memory
   *  pane fills from prior conversations instead of waiting for a new turn. */
  private backfill(entry: ProjectEntry): void {
    let files: { path: string; mtime: number }[]
    try {
      files = readdirSync(entry.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const p = join(entry.dir, f)
          return { path: resolve(p), mtime: statSync(p).mtimeMs }
        })
    } catch {
      return
    }
    files.sort((a, b) => b.mtime - a.mtime) // newest first → most relevant memories surface first
    for (const { path } of files.slice(0, BACKFILL_MAX_FILES)) {
      this.enqueue(() => this.flushFile(entry, path, 'backfill'), 'backfill')
    }
  }

  private scheduleRetry(key: string, spaceId: string, cwd: string, repTabId?: string): void {
    if (this.disposed || this.retryTimers.has(key)) return
    const attempt = (this.retryCounts.get(key) ?? 0) + 1
    if (attempt > 5) {
      this.log(`capture: stopped retrying watcher for ${cwd}`)
      return
    }
    this.retryCounts.set(key, attempt)
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      this.trackProject(spaceId, cwd, repTabId)
    }, Math.min(30_000, 1000 * 2 ** (attempt - 1)))
    timer.unref()
    this.retryTimers.set(key, timer)
  }

  private scheduleFile(entry: ProjectEntry, path: string): void {
    // Zede-internal sessions (the extractor's own `claude -p` runs) must never
    // be claimed, listed as prompts, or re-distilled — see capture/internal.ts.
    if (isInternalSession(sessionIdOf(path))) return
    let st = entry.files.get(path)
    if (!st) {
      st = { busy: false }
      entry.files.set(path, st)
    }
    // Binding must be prompt, but it need not synchronously repeat for every
    // FSEvent in a streaming burst. Keep a leading claim and one trailing claim
    // per window so resumed/hand-started sessions still self-correct quickly.
    const now = this.now()
    const since = Math.max(0, now - (st.lastClaimAt ?? -Infinity))
    if (since >= CLAIM_THROTTLE_MS) {
      if (st.claimTimer) clearTimeout(st.claimTimer)
      st.claimTimer = undefined
      st.lastClaimAt = now
      this.claimSession(entry, path)
    } else if (!st.claimTimer) {
      st.claimTimer = setTimeout(() => {
        st.claimTimer = undefined
        st.lastClaimAt = this.now()
        try {
          this.claimSession(entry, path)
        } catch (e) {
          this.log(`capture: claim failed for ${basename(path)}: ${String(e)}`)
        }
      }, CLAIM_THROTTLE_MS - since)
    }
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => this.enqueue(() => this.flushFile(entry, path, 'live'), 'live'), DEBOUNCE_MS)
  }

  /** A change event on a watched transcript means that session is active right
   *  now — record it immediately (cheap, idempotent sqlite) instead of waiting
   *  out the extraction debounce + queue, and ask the arbiter whether it runs
   *  inside a Zede tab. The sidebar's prompt list resolves shell-tab and
   *  hand-started sessions through this binding, so a late bind is exactly the
   *  window where prompts need a manual refresh to appear. Then ping the
   *  renderer (throttled) so it refetches without guessing from PTY activity.
   *  Subagent sidechains (agent-*.jsonl) are captured but never bound — their
   *  prompts were not typed into any pane. */
  private claimSession(entry: ProjectEntry, path: string): void {
    const sessionId = sessionIdOf(path)
    const rep = this.boundTabId(entry)
    const tabId = sessionId.startsWith('agent-')
      ? null
      : this.resolveTab
        ? this.resolveTab({ sessionId, repTabId: rep, cwd: entry.cwd, spaceId: entry.spaceId, transcriptPath: path })
        : rep
    this.repo.insertSession({
      id: sessionId,
      tabId,
      ccSessionId: sessionId,
      transcriptPath: path,
      startedAt: this.now(),
      status: 'live'
    })
    // insertSession is ON CONFLICT DO NOTHING, so a row that already exists
    // keeps its old (possibly NULL) tab_id — bind explicitly. bindSession only
    // claims NULL rows; re-binding a row the arbiter just took off another tab
    // needs that unbind to have landed first, which it has (both synchronous).
    if (tabId) this.repo.bindSession(sessionId, tabId)
    this.notifyPrompts()
  }

  /** entry.repTabId validated against the DB. The tab row may be gone by now
   *  (close / space delete cascades it) while the watcher keeps firing for the
   *  project dir — inserting a session bound to the dead id violates the
   *  sessions→tabs FK and crashes the main process. Self-heals by dropping the
   *  stale binding; better-sqlite3 is synchronous and Core is the single
   *  writer, so a validated id can't disappear before the insert that follows. */
  private boundTabId(entry: ProjectEntry): string | null {
    if (entry.repTabId && !this.repo.getTab(entry.repTabId)) entry.repTabId = null
    return entry.repTabId
  }

  /** Detach a closed tab from every project entry so discovered sessions stop
   *  binding to its (now deleted) row. boundTabId() covers the races this
   *  can't reach; this keeps the common path from ever going stale. */
  releaseTab(tabId: string): void {
    for (const entry of this.projects.values()) {
      if (entry.repTabId === tabId) entry.repTabId = null
    }
  }

  /** A pinned tab was rebuilt in place (close → fresh row, same slot): project
   *  entries follow to the replacement instead of going unbound. */
  rebindTab(oldTabId: string, newTabId: string): void {
    for (const entry of this.projects.values()) {
      if (entry.repTabId === oldTabId) entry.repTabId = newTabId
    }
  }

  private notifyTimer?: NodeJS.Timeout
  private lastNotifyAt = 0

  /** Leading+trailing throttle: the first event fires straight away (a fresh
   *  prompt shows up as soon as claude writes it), a burst mid-answer coalesces
   *  to one ping per NOTIFY_THROTTLE_MS. */
  private notifyPrompts(): void {
    if (this.notifyTimer) return
    const wait = Math.max(0, NOTIFY_THROTTLE_MS - (this.now() - this.lastNotifyAt))
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      this.lastNotifyAt = this.now()
      this.notify()
    }, wait)
  }

  private enqueue(fn: () => Promise<void>, priority: 'live' | 'backfill'): void {
    ;(priority === 'live' ? this.liveQueue : this.backfillQueue).push(fn)
    this.pump()
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && (this.liveQueue.length || this.backfillQueue.length)) {
      const priority: 'live' | 'backfill' = this.liveQueue.length ? 'live' : 'backfill'
      if (priority === 'backfill' && this.activeBackfill >= 1) break // reserve one slot for future live work
      const fn = (priority === 'live' ? this.liveQueue.shift() : this.backfillQueue.shift()) as () => Promise<void>
      this.active++
      if (priority === 'backfill') this.activeBackfill++
      void fn()
        .catch((e) => {
          // An escaped rejection here is process-fatal in Electron (dialog on
          // every retry). One bad transcript must not take the app down.
          this.log(`capture: flush failed: ${String(e)}`)
        })
        .finally(() => {
          this.active--
          if (priority === 'backfill') this.activeBackfill--
          this.pump()
        })
    }
  }

  private async flushFile(entry: ProjectEntry, path: string, priority: 'live' | 'backfill'): Promise<void> {
    if (isInternalSession(sessionIdOf(path))) return
    let st = entry.files.get(path)
    if (!st) {
      st = { busy: false }
      entry.files.set(path, st)
    }
    if (st.busy) {
      this.scheduleFile(entry, path) // a change landed mid-flush — re-run after this one
      return
    }
    st.busy = true
    let more: boolean
    try {
      const sessionId = sessionIdOf(path)
      // The session row may not exist for backfilled transcripts; the watermark
      // FK needs it. Inserted UNBOUND on purpose: tab binding is claimSession's
      // job (arbitered), and a backfilled pile of old transcripts must not
      // hijack a tab's prompt journey. ON CONFLICT keeps an existing binding.
      this.repo.insertSession({
        id: sessionId,
        tabId: null,
        ccSessionId: sessionId,
        transcriptPath: path,
        startedAt: this.now(),
        status: 'live'
      })
      const boundTabId = this.repo.sessionTab(sessionId)
      const captureSpaceId = (boundTabId ? this.repo.getTab(boundTabId)?.spaceId : undefined) ?? entry.spaceId

      const offset = this.repo.getWatermark(sessionId)
      let readOffset = offset
      if (priority === 'backfill' && offset === 0) {
        try {
          readOffset = Math.max(0, statSync(path).size - READ_BUDGET_BYTES)
        } catch {
          return
        }
      }
      const { reset, records, newOffset, hasMore } = readFrom(path, readOffset, READ_BUDGET_BYTES)
      const spanStart = reset ? 0 : readOffset
      more = hasMore

      if (records.length) {
        let spans = recordsToSpans(records)
        // First pass over a transcript (no watermark): cap to the most recent
        // spans so a 5 MB history doesn't fan out into hundreds of model calls.
        if (offset === 0 && spans.length > BACKFILL_MAX_SPANS) spans = spans.slice(-BACKFILL_MAX_SPANS)

        let learned = 0
        let dup = 0
        let sup = 0
        for (const span of spans) {
          if (!span.trim()) continue
          const safeSpan = redact(span).text // defense-in-depth before the model
          const candidates = await this.extractor().extract(safeSpan, { cwd: entry.cwd, spaceId: captureSpaceId })
          if (!candidates.length) continue
          const r = this.store.store(
            candidates,
            {
              spaceId: captureSpaceId,
              sessionId,
              transcriptPath: path,
              spanStart,
              spanEnd: newOffset,
              excerpt: safeSpan.slice(0, 500)
            },
            this.now()
          )
          learned += r.inserted.length
          dup += r.deduped
          sup += r.suppressed
        }
        if (learned || dup || sup) {
          this.log(`flush ${sessionId}: +${learned} learned · ${dup} dup · ${sup} suppressed (${spans.length} span${spans.length === 1 ? '' : 's'})`)
        }
      }
      this.repo.setWatermark(sessionId, newOffset, this.now())
    } finally {
      st.busy = false
    }
    if (more) {
      setImmediate(() => {
        if (!this.disposed) this.enqueue(() => this.flushFile(entry, path, priority), priority)
      })
    }
  }

  untrackAll(): void {
    this.disposed = true
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.retryCounts.clear()
    for (const entry of this.projects.values()) {
      for (const st of entry.files.values()) {
        if (st.timer) clearTimeout(st.timer)
        if (st.claimTimer) clearTimeout(st.claimTimer)
      }
      void entry.watcher.close()
    }
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = undefined
    this.projects.clear()
    this.liveQueue.length = 0
    this.backfillQueue.length = 0
  }
}
