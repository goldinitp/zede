import { statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'

export interface TranscriptRecord {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: { role?: string; content?: unknown }
  timestamp?: string
  uuid?: string
}

export interface ReadResult {
  /** true when the file shrank (truncation/rotation) — caller should re-baseline. */
  reset: boolean
  records: TranscriptRecord[]
  newOffset: number
}

// Incremental read: parse only COMPLETE lines from [offset..EOF]; a trailing
// partial line waits for the next pass. Validated in M0 Spike 2.
export function readFrom(path: string, offset: number): ReadResult {
  if (!existsSync(path)) return { reset: false, records: [], newOffset: offset }
  const size = statSync(path).size
  if (size < offset) return { reset: true, records: [], newOffset: 0 }
  const len = size - offset
  if (len === 0) return { reset: false, records: [], newOffset: offset }

  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, offset)
  } finally {
    closeSync(fd)
  }

  const text = buf.toString('utf8')
  const lastNl = text.lastIndexOf('\n')
  if (lastNl === -1) return { reset: false, records: [], newOffset: offset }

  const records: TranscriptRecord[] = []
  for (const line of text.slice(0, lastNl).split('\n')) {
    if (!line) continue
    try {
      records.push(JSON.parse(line) as TranscriptRecord)
    } catch {
      /* skip corrupt/partial line */
    }
  }
  return { reset: false, records, newOffset: offset + lastNl + 1 }
}

const MAX_MSG = 4000
const MAX_SPAN = 12000

interface ContentBlock {
  type?: string
  text?: string
}

/** Pull plain text out of a message's content (string or block array); text blocks only. */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? (b.text ?? '') : ''))
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

// Noise the TUI records as `user` turns that were never typed as prompts:
// slash-command wrappers, local command output, caveat banners, interrupts.
const PROMPT_NOISE = /^(<command-name>|<command-message>|<local-command-stdout>|<local-command-stderr>|\[Request interrupted|Caveat: The messages below)/

const MAX_PROMPT = 400

export interface UserPrompt {
  text: string
  ts: number | null
}

/** The user's actual prompts in a transcript, in conversation order. Tool
 *  results drop out naturally (textFromContent reads text blocks only). */
export function userPrompts(transcript: string): UserPrompt[] {
  const out: UserPrompt[] = []
  for (const line of transcript.split('\n')) {
    if (!line) continue
    let r: TranscriptRecord
    try {
      r = JSON.parse(line) as TranscriptRecord
    } catch {
      continue
    }
    if (r.type !== 'user' || r.isMeta || r.isSidechain) continue
    const text = textFromContent(r.message?.content).trim()
    if (!text || PROMPT_NOISE.test(text)) continue
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN
    out.push({ text: text.slice(0, MAX_PROMPT), ts: Number.isFinite(ts) ? ts : null })
  }
  return out
}

// Turn conversation records into per-message lines. Drops meta / sidechain /
// tool records and caps each message so a giant paste never dominates a span.
function recordParts(records: TranscriptRecord[]): string[] {
  const parts: string[] = []
  for (const r of records) {
    if (r.type !== 'user' && r.type !== 'assistant') continue
    if (r.isMeta || r.isSidechain) continue
    const text = textFromContent(r.message?.content).trim()
    if (!text) continue
    parts.push(`${r.type === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, MAX_MSG)}`)
  }
  return parts
}

// Collapse new conversation records into one extraction span (truncates at
// MAX_SPAN). Kept for callers that want a single bounded span.
export function recordsToSpan(records: TranscriptRecord[]): string {
  return recordParts(records).join('\n').slice(0, MAX_SPAN)
}

// Pack records into multiple spans, each <= maxSpan, on whole-message
// boundaries. Unlike recordsToSpan this preserves ALL content across spans
// instead of dropping everything past the first MAX_SPAN chars — required so a
// large or backfilled transcript is fully distilled, not just its opening.
export function recordsToSpans(records: TranscriptRecord[], maxSpan = MAX_SPAN): string[] {
  const spans: string[] = []
  let buf = ''
  for (const part of recordParts(records)) {
    const piece = part.length > maxSpan ? part.slice(0, maxSpan) : part
    if (buf && buf.length + 1 + piece.length > maxSpan) {
      spans.push(buf)
      buf = piece
    } else {
      buf = buf ? `${buf}\n${piece}` : piece
    }
  }
  if (buf) spans.push(buf)
  return spans
}
