import { watch, readdirSync, readFileSync, existsSync, type FSWatcher } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { transcriptDirFor } from '../capture/paths'
import { fingerprint } from '../pipeline/fingerprint'
import { redact } from '../pipeline/redact'
import type { MemoryRepo } from '../db/memories'
import type { Memory, MemoryType } from '../../shared/api'

const DEBOUNCE_MS = 1500
const MAX_CONTENT = 280 // panel one-liner cap
const MAX_BODY = 4000 // stored body excerpt for the detail tab

// Deterministic-id prefix for mirrored rows, so re-syncs upsert in place and a
// purge can tell mirrored (curated) from distilled (transcript) memories.
export const MIRROR_ID_PREFIX = 'cc:'

// Claude Code maps its own memory types onto Zede's. "user" facts (who the user
// is) and "reference" pointers read as facts; "feedback" is how-to-work guidance
// (a preference); "project" notes are decisions/constraints.
const CC_TYPE_MAP: Record<string, MemoryType> = {
  user: 'fact',
  feedback: 'preference',
  project: 'decision',
  reference: 'fact'
}

interface ParsedMemoryFile {
  name: string
  type: MemoryType
  content: string
  body: string
}

interface DirEntry {
  watcher: FSWatcher
  cwd: string
  timer?: NodeJS.Timeout
}

/**
 * Mirrors Claude Code's own curated memory store into Zede's global tier.
 *
 * Claude Code keeps one-fact-per-file markdown (with YAML-ish frontmatter) under
 * `<transcriptDir>/memory/` — the canonical "what the assistant knows about the
 * user" (profile, preferences, project constraints). Zede otherwise only
 * distills transcripts, so these durable, user-authored facts never surfaced —
 * that is the "user-level memory not persistent" gap. The mirror reads them as
 * global (cross-Space, persistent) memories and re-syncs when the files change.
 * Mirrored rows are authoritative: they bypass tombstone/dedup and upsert by a
 * deterministic id (`cc:<name>`). (spec §6.1 / resolves open decision §14.x.)
 */
export class MirrorService {
  private readonly dirs = new Map<string, DirEntry>()

  constructor(
    private readonly repo: MemoryRepo,
    private readonly now: () => number,
    private readonly onSynced: (inserted: Memory[], updated: Memory[]) => void,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  /** Mirror + watch the Claude Code memory dir for a cwd. Idempotent per dir.
   *  `_spaceId` is accepted for call-site symmetry with capture.trackProject;
   *  mirrored rows are global, so the Space is irrelevant here. */
  track(_spaceId: string, cwd: string): void {
    const dir = join(transcriptDirFor(cwd), 'memory')
    const key = resolve(dir)
    if (this.dirs.has(key)) return // already watching this cwd's memory dir
    let watcher: FSWatcher
    try {
      // Single-descriptor directory watch (see capture/watcher.ts) — never one fd
      // per memory file, which would compound the transcript-dir fd exhaustion.
      watcher = watch(dir, { persistent: true, recursive: true })
    } catch {
      this.sync(cwd) // dir may not exist yet; still do a one-time pass
      return
    }
    const entry: DirEntry = { watcher, cwd }
    const schedule = (): void => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => this.sync(entry.cwd), DEBOUNCE_MS)
    }
    // Any add/change/delete under memory/ → re-sync (sync re-reads the whole dir).
    watcher.on('change', schedule)
    watcher.on('error', () => {
      /* transient FSEvents hiccup — the next change re-syncs */
    })
    this.dirs.set(key, entry)
    this.sync(cwd) // initial pass
  }

  /** Read every `memory/*.md` (except the MEMORY.md index) and upsert as global. */
  sync(cwd: string): { inserted: number; updated: number } {
    const dir = join(transcriptDirFor(cwd), 'memory')
    if (!existsSync(dir)) return { inserted: 0, updated: 0 }
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'memory.md')
    } catch {
      return { inserted: 0, updated: 0 }
    }

    const inserted: Memory[] = []
    const updated: Memory[] = []
    const now = this.now()

    for (const f of files) {
      const path = join(dir, f)
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const parsed = parseMemoryFile(raw, f)
      if (!parsed) continue

      const id = `${MIRROR_ID_PREFIX}${parsed.name}`
      const content = redact(parsed.content).text.trim()
      if (!content) continue
      const body = redact(parsed.body).text.slice(0, MAX_BODY)

      const existedBefore = this.repo.getMemory(id) !== undefined
      this.repo.transaction(() => {
        this.repo.upsertMirrored({
          id,
          type: parsed.type,
          content,
          // Fingerprint keyed by id (not content) so an edited file updates the
          // same row rather than orphaning the old one + minting a new id.
          sourceHash: fingerprint(`${id}:${content}`),
          now
        })
        this.repo.clearSources(id)
        this.repo.insertSource({ memoryId: id, sessionId: 'cc-memory', transcriptPath: path, spanStart: 0, spanEnd: 0, excerpt: body })
      })()

      const m = this.repo.getMemory(id)
      if (!m) continue
      ;(existedBefore ? updated : inserted).push(m)
    }

    if (inserted.length || updated.length) {
      this.log(`mirror ${basename(resolve(dir, '..'))}: +${inserted.length} new · ${updated.length} updated (${files.length} files)`)
      this.onSynced(inserted, updated)
    }
    return { inserted: inserted.length, updated: updated.length }
  }

  untrackAll(): void {
    for (const e of this.dirs.values()) {
      if (e.timer) clearTimeout(e.timer)
      void e.watcher.close()
    }
    this.dirs.clear()
  }
}

/** Parse a Claude Code memory file: `---`-fenced frontmatter + markdown body.
 *  Hand-rolled (no YAML dep) for the known, simple `key: value` shape. */
export function parseMemoryFile(raw: string, filename: string): ParsedMemoryFile | null {
  const fenced = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  const front = fenced ? fenced[1] : ''
  const body = (fenced ? fenced[2] : raw).trim()

  const field = (key: string): string | undefined => {
    // Anchored at line start so `type:` doesn't match `node_type:`.
    const m = front.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '').trim() : undefined
  }

  const name = (field('name') || filename.replace(/\.md$/, '')).trim()
  const ccType = (field('type') || '').toLowerCase()
  const type = CC_TYPE_MAP[ccType] ?? 'fact'

  // Prefer the curated one-line `description` for the panel; else the first
  // meaningful body line, stripped of markdown markers.
  let content = field('description') || ''
  if (!content) {
    const firstLine = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
    content = (firstLine || name).replace(/^[*_>\-\s]+/, '').replace(/[*_`]/g, '')
  }
  if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT - 1).trimEnd()}…`

  if (!content && !body) return null
  return { name, type, content, body }
}
