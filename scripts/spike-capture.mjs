// Spike 2 — transcript capture + session-id binding + incremental watermark.
// Proves: (a) forward cwd->dir encoding, (b) encoding-independent uuid-glob
// fallback, (c) byte-offset watermark reads ONLY new records after an append,
// (d) record classification (user/assistant, isMeta, isSidechain).
// Pure Node. Uses cheap Haiku for the two generating calls. Run: npm run spike:capture
import { spawnSync } from 'node:child_process'
import { statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = process.env.HOME
const cwd = process.cwd()
const MODEL = 'claude-haiku-4-5-20251001' // quality irrelevant here; keep it cheap/fast

// Hypothesis from observed dirs (`frontendmasters.in`->`frontendmasters-in`):
// every non-alphanumeric char maps to '-'. Forward-only; never inverted.
const encodeCwd = (p) => p.replace(/[^A-Za-z0-9]/g, '-')

const sessionId = randomUUID()
const projDir = join(HOME, '.claude', 'projects', encodeCwd(cwd))
const predicted = join(projDir, sessionId + '.jsonl')

function claude(args, label) {
  const t0 = Date.now()
  const r = spawnSync('claude', args, { encoding: 'utf8', timeout: 120000 })
  console.log(`[${label}] exit=${r.status} ${Date.now() - t0}ms ${(r.stderr || '').trim().slice(0, 160)}`)
  return r
}

// Incremental reader: read [offset..EOF], parse only COMPLETE lines (last
// partial line waits), advance the watermark past the last newline.
function readFrom(path, offset) {
  const size = statSync(path).size
  if (size < offset) return { reset: true, records: [], newOffset: 0 } // truncation/rotation guard
  const len = size - offset
  if (len === 0) return { reset: false, records: [], newOffset: offset }
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  readSync(fd, buf, 0, len, offset)
  closeSync(fd)
  const text = buf.toString('utf8')
  const lastNl = text.lastIndexOf('\n')
  const consumed = lastNl === -1 ? 0 : lastNl + 1
  const records = (lastNl === -1 ? '' : text.slice(0, lastNl))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return { reset: false, records, newOffset: offset + consumed }
}

const contentOf = (r) =>
  Array.isArray(r.message?.content)
    ? r.message.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ')
    : (r.message?.content ?? '')

// 1) create a session
claude(['-p', 'Reply with exactly: hi', '--model', MODEL, '--session-id', sessionId, '--output-format', 'json'], 'create')

const transcript = existsSync(predicted)
  ? predicted
  : spawnSync('find', [join(HOME, '.claude', 'projects'), '-name', sessionId + '.jsonl'], { encoding: 'utf8' }).stdout.trim()

console.log('\n--- binding ---')
console.log('encodeCwd(cwd)      :', encodeCwd(cwd))
console.log('predicted path      :', predicted)
console.log('predicted exists    :', existsSync(predicted))
console.log('resolved transcript :', transcript || '(NOT FOUND)')
if (!transcript || !existsSync(transcript)) {
  console.error('FAIL: no transcript created')
  process.exit(1)
}

// 2) watermark after the first turn
const wm1 = statSync(transcript).size
console.log('\nwatermark after turn 1 (bytes):', wm1)

// 3) append to the same session via --resume
claude(['-p', 'Reply with exactly: bye', '--model', MODEL, '--resume', sessionId, '--output-format', 'json'], 'resume')
const sizeAfter = statSync(transcript).size
console.log('size after resume     :', sizeAfter, sizeAfter > wm1 ? '(grew — resume appends in place ✓)' : '(did NOT grow — resume forked elsewhere!)')

// 4) incremental read of ONLY the new tail
const { records, newOffset } = readFrom(transcript, wm1)
console.log(`\n--- incremental read [${wm1}..${newOffset}] : ${records.length} new records ---`)
const conv = records.filter((r) => (r.type === 'user' || r.type === 'assistant') && !r.isMeta && !r.isSidechain)
console.log('new conversation records (user/assistant, !meta, !sidechain):', conv.length)
for (const r of conv) console.log(`  ${r.type}: ${String(contentOf(r)).replace(/\s+/g, ' ').slice(0, 90)}`)

// 5) full-file classification stats
const all = readFrom(transcript, 0).records
const counts = {}
let meta = 0,
  side = 0
for (const r of all) {
  counts[r.type] = (counts[r.type] || 0) + 1
  if (r.isMeta) meta++
  if (r.isSidechain) side++
}
console.log('\n--- full-file record type counts ---')
console.log(JSON.stringify(counts))
console.log(`isMeta records: ${meta}, isSidechain records: ${side}`)
