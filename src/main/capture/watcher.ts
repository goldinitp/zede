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
const NOTIFY_THROTTLE_MS = 1000 // prompt-change pings to the renderer, at most ~1/s
const MAX_CONCURRENT = 2 // never starve the user's foreground claude (spec §10)
const BACKFILL_MAX_SPANS = 4 // cap spans distilled per never-seen transcript
const BACKFILL_MAX_FILES = 10 // cap transcripts backfilled per project dir

interface FileState {
  timer?: NodeJS.Timeout
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
// (spec §6.1; resolves open decision §14.2 — deterministic transcript binding.)
export class CaptureService {
  private readonly projects = new Map<string, ProjectEntry>()
  private active = 0
  private readonly queue: Array<() => Promise<void>> = []

  constructor(
    private readonly repo: MemoryRepo,
    private readonly extractor: () => Extractor,
    private readonly store: MemoryStore,
    private readonly now: () => number,
    private readonly log: (msg: string) => void = () => {},
    private readonly notify: () => void = () => {}
  ) {}

  /** Start (idempotent) capture for a Space's cwd: watch the project dir for new
   *  + changed transcripts and backfill the ones already on disk. */
  trackProject(spaceId: string, cwd: string, repTabId?: string): void {
    const dir = transcriptDirFor(cwd)
    const key = resolve(dir)
    const existing = this.projects.get(key)
    if (existing) {
      existing.spaceId = spaceId // keep memory attribution current on Space switch
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
    const watcher = watch(dir, { persistent: true, recursive: true })
    const entry: ProjectEntry = { watcher, spaceId, cwd, dir, repTabId: repTabId ?? null, files: new Map() }
    watcher.on('change', (_event, filename) => {
      if (!filename) return
      const name = filename.toString() // relative to `dir`; transcripts are top-level .jsonl
      if (name.endsWith('.jsonl')) this.scheduleFile(entry, resolve(join(dir, name)))
    })
    watcher.on('error', () => {
      /* transient FSEvents hiccup — debounced re-reads + watermarks self-heal */
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
      this.enqueue(() => this.flushFile(entry, path, { bind: false }))
    }
  }

  private scheduleFile(entry: ProjectEntry, path: string): void {
    // Zede-internal sessions (the extractor's own `claude -p` runs) must never
    // be claimed, listed as prompts, or re-distilled — see capture/internal.ts.
    if (isInternalSession(sessionIdOf(path))) return
    this.claimSession(entry, path)
    let st = entry.files.get(path)
    if (!st) {
      st = { busy: false }
      entry.files.set(path, st)
    }
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => this.enqueue(() => this.flushFile(entry, path)), DEBOUNCE_MS)
  }

  /** A change event on a watched transcript means that session is active right
   *  now — record and bind it immediately (cheap, idempotent sqlite) instead of
   *  waiting out the extraction debounce + queue. The sidebar's prompt list
   *  resolves shell-tab and discovered sessions through this binding, so a late
   *  bind is exactly the window where prompts need a manual refresh to appear.
   *  Then ping the renderer (throttled) so it refetches without guessing from
   *  PTY activity — which also covers claudes run in an external terminal. */
  private claimSession(entry: ProjectEntry, path: string): void {
    const sessionId = sessionIdOf(path)
    this.repo.insertSession({
      id: sessionId,
      tabId: entry.repTabId,
      ccSessionId: sessionId,
      transcriptPath: path,
      startedAt: this.now(),
      status: 'live'
    })
    if (entry.repTabId) this.repo.bindSession(sessionId, entry.repTabId)
    this.notifyPrompts()
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

  private enqueue(fn: () => Promise<void>): void {
    this.queue.push(fn)
    this.pump()
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const fn = this.queue.shift() as () => Promise<void>
      this.active++
      void fn().finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async flushFile(entry: ProjectEntry, path: string, opts: { bind: boolean } = { bind: true }): Promise<void> {
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
    try {
      const sessionId = sessionIdOf(path)
      // The session row may not exist for externally-started sessions; the
      // watermark FK needs it. tab_id is nullable for discovered transcripts.
      // Only a session ACTIVE while watched binds to the representative tab
      // (its prompts then list under that tab in the sidebar) — a backfilled
      // pile of old transcripts must not hijack the tab's prompt journey.
      this.repo.insertSession({
        id: sessionId,
        tabId: opts.bind ? entry.repTabId : null,
        ccSessionId: sessionId,
        transcriptPath: path,
        startedAt: this.now(),
        status: 'live'
      })
      if (opts.bind && entry.repTabId) this.repo.bindSession(sessionId, entry.repTabId)

      const offset = this.repo.getWatermark(sessionId)
      const { reset, records, newOffset } = readFrom(path, offset)
      const spanStart = reset ? 0 : offset

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
          const candidates = await this.extractor().extract(safeSpan, { cwd: entry.cwd, spaceId: entry.spaceId })
          if (!candidates.length) continue
          const r = this.store.store(
            candidates,
            {
              spaceId: entry.spaceId,
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
  }

  untrackAll(): void {
    for (const entry of this.projects.values()) {
      for (const st of entry.files.values()) if (st.timer) clearTimeout(st.timer)
      void entry.watcher.close()
    }
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = undefined
    this.projects.clear()
    this.queue.length = 0
  }
}
