import { statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'

const MAX_OVERSIZED_RECORD = 8 * 1024 * 1024

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
  /** More complete data remains after a byte-budgeted read. */
  hasMore: boolean
}

// Incremental read: parse only COMPLETE lines from [offset..EOF]; a trailing
// partial line waits for the next pass. Validated in M0 Spike 2.
export function readFrom(path: string, offset: number, maxBytes = Number.POSITIVE_INFINITY): ReadResult {
  if (!existsSync(path)) return { reset: false, records: [], newOffset: offset, hasMore: false }
  const size = statSync(path).size
  if (size < offset) return { reset: true, records: [], newOffset: 0, hasMore: false }
  const len = Math.min(size - offset, Math.max(1, maxBytes))
  if (len === 0) return { reset: false, records: [], newOffset: offset, hasMore: false }

  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, offset)
  } finally {
    closeSync(fd)
  }

  // Newline search happens on the BUFFER: offsets are byte positions, and an
  // index from text.lastIndexOf would count UTF-16 code units — short of the
  // true byte offset whenever the chunk holds multi-byte UTF-8, making the next
  // incremental read re-consume (and duplicate) already-parsed lines.
  const lastNl = buf.lastIndexOf(0x0a)
  if (lastNl === -1) {
    if (offset + len >= size) return { reset: false, records: [], newOffset: offset, hasMore: false }
    // A single JSONL record exceeded the normal budget. Scan to its newline;
    // preserve reasonably-sized records, but advance past pathological records
    // rather than allocating without bound or retrying forever without progress.
    const scan = Buffer.alloc(64 * 1024)
    const fd = openSync(path, 'r')
    try {
      let pos = offset + len
      while (pos < size) {
        const n = readSync(fd, scan, 0, Math.min(scan.length, size - pos), pos)
        if (!n) break
        const nl = scan.subarray(0, n).indexOf(0x0a)
        if (nl !== -1) {
          const newOffset = pos + nl + 1
          const recordBytes = newOffset - offset - 1
          if (recordBytes <= MAX_OVERSIZED_RECORD) {
            const raw = Buffer.alloc(recordBytes)
            readSync(fd, raw, 0, recordBytes, offset)
            try {
              return {
                reset: false,
                records: [JSON.parse(raw.toString('utf8')) as TranscriptRecord],
                newOffset,
                hasMore: newOffset < size
              }
            } catch {
              /* malformed oversized record — advance past it */
            }
          }
          return { reset: false, records: [], newOffset, hasMore: newOffset < size }
        }
        pos += n
      }
    } finally {
      closeSync(fd)
    }
    return { reset: false, records: [], newOffset: offset, hasMore: false }
  }

  const records: TranscriptRecord[] = []
  for (const line of buf.toString('utf8', 0, lastNl).split('\n')) {
    if (!line) continue
    try {
      records.push(JSON.parse(line) as TranscriptRecord)
    } catch {
      /* skip corrupt/partial line */
    }
  }
  const newOffset = offset + lastNl + 1
  return { reset: false, records, newOffset, hasMore: newOffset < size }
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
const PROMPT_NOISE = /^(<command-name>|<command-message>|<local-command-stdout>|<local-command-stderr>|<task-notification>|<system-reminder>|\[Request interrupted|Caveat: The messages below)/

const MAX_PROMPT = 400

export interface UserPrompt {
  text: string
  ts: number | null
}

/** One record's user prompt, or null for anything that isn't one (meta,
 *  sidechain, tool results, TUI noise). Tool results drop out naturally
 *  (textFromContent reads text blocks only). */
export function promptOfRecord(r: TranscriptRecord): UserPrompt | null {
  if (r.type !== 'user' || r.isMeta || r.isSidechain) return null
  const text = textFromContent(r.message?.content).trim()
  if (!text || PROMPT_NOISE.test(text)) return null
  const ts = r.timestamp ? Date.parse(r.timestamp) : NaN
  return { text: text.slice(0, MAX_PROMPT), ts: Number.isFinite(ts) ? ts : null }
}

/** The user's actual prompts in a transcript, in conversation order. */
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
    const p = promptOfRecord(r)
    if (p) out.push(p)
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
