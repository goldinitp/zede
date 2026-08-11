import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { textFromContent, type TranscriptRecord } from '../capture/parser'
import { isUuid, transcriptPathFor } from '../capture/paths'
import type { SavedConversation } from '../../shared/api'

/** The on-disk shape: the listing metadata plus the raw transcript JSONL. */
interface SavedFile extends SavedConversation {
  version: number
  transcript: string
}

const PREVIEW_MAX = 120

/**
 * Local JSON snapshots of Claude conversations (one file per save) so a long
 * conversation survives Claude Code pruning its own transcripts. A save copies
 * the tab's transcript JSONL verbatim; a load writes it back under
 * ~/.claude/projects so `claude --resume <sessionId>` can pick the thread up.
 */
export class ConversationStore {
  constructor(
    private readonly dir: string,
    /** Overridable so tests can restore into a sandbox instead of ~/.claude. */
    private readonly resolveTranscriptPath: (cwd: string, sessionId: string) => string = transcriptPathFor
  ) {}

  save(p: { title: string; sessionId: string; cwd: string; transcriptPath: string }): SavedConversation {
    if (!existsSync(p.transcriptPath)) throw new Error('No transcript on disk for this tab yet — say something to Claude first')
    const transcript = readFileSync(p.transcriptPath, 'utf8')
    const convo = conversationRecords(transcript)
    if (!convo.length) throw new Error('This tab has no conversation to save yet')

    const firstUser = convo.find((r) => r.type === 'user')
    const preview = textFromContent(firstUser?.message?.content).trim().slice(0, PREVIEW_MAX)
    const id = randomUUID()
    const record: SavedFile = {
      version: 1,
      id,
      title: p.title,
      sessionId: p.sessionId,
      cwd: p.cwd,
      savedAt: Date.now(),
      messageCount: convo.length,
      preview,
      filePath: join(this.dir, `${id}.json`),
      transcript
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(record.filePath, JSON.stringify(record, null, 2), 'utf8')
    return meta(record)
  }

  list(): SavedConversation[] {
    if (!existsSync(this.dir)) return []
    const out: SavedConversation[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      const rec = this.read(join(this.dir, name))
      if (rec) out.push(meta(rec))
    }
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }

  get(id: string): SavedFile | null {
    // ids come from the renderer over IPC — only a UUID may become a path segment
    if (!isUuid(id)) return null
    return this.read(join(this.dir, `${id}.json`))
  }

  /** Retitle a save in place (the picker shows this name). */
  rename(id: string, title: string): SavedConversation | null {
    const clean = title.trim()
    const rec = this.get(id)
    if (!clean || !rec) return null
    const next = { ...rec, title: clean }
    writeFileSync(rec.filePath, JSON.stringify(next, null, 2), 'utf8')
    return meta(next)
  }

  remove(id: string): boolean {
    if (!isUuid(id)) return false
    try {
      unlinkSync(join(this.dir, `${id}.json`))
      return true
    } catch {
      return false
    }
  }

  /** Put the saved transcript back where `claude --resume` expects it. Only
   *  writes when the live file is missing or SHORTER than the snapshot — a
   *  longer file means the conversation moved on after the save, and
   *  overwriting it would destroy the newer turns. */
  restoreTranscript(rec: SavedFile): string {
    const path = this.resolveTranscriptPath(rec.cwd, rec.sessionId)
    let liveSize = -1
    try {
      liveSize = statSync(path).size
    } catch {
      /* missing — restore below */
    }
    if (liveSize < Buffer.byteLength(rec.transcript, 'utf8')) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, rec.transcript, 'utf8')
    }
    return path
  }

  private read(path: string): SavedFile | null {
    try {
      const rec = JSON.parse(readFileSync(path, 'utf8')) as SavedFile
      if (!rec.id || !rec.sessionId || !rec.cwd || typeof rec.transcript !== 'string') return null
      // Both ids feed `claude --resume` shell strings and transcript paths on
      // load — a non-UUID means the file was tampered with or corrupted.
      if (!isUuid(rec.id) || !isUuid(rec.sessionId)) return null
      return { ...rec, filePath: path } // trust the actual location, not the recorded one
    } catch {
      return null
    }
  }
}

function meta(rec: SavedFile): SavedConversation {
  return {
    id: rec.id,
    title: rec.title,
    sessionId: rec.sessionId,
    cwd: rec.cwd,
    savedAt: rec.savedAt,
    messageCount: rec.messageCount,
    preview: rec.preview,
    filePath: rec.filePath
  }
}

/** Real user/assistant turns in a transcript (meta, sidechain and empty records dropped). */
function conversationRecords(transcript: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = []
  for (const line of transcript.split('\n')) {
    if (!line) continue
    let r: TranscriptRecord
    try {
      r = JSON.parse(line) as TranscriptRecord
    } catch {
      continue
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue
    if (r.isMeta || r.isSidechain) continue
    if (!textFromContent(r.message?.content).trim()) continue
    out.push(r)
  }
  return out
}
