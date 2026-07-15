// Spike 3 — structured extraction via `claude -p`.
// Proves: (a) the claude -p JSON envelope shape, (b) that --json-schema yields
// schema-valid structured output, (c) end-to-end latency. Pure Node (no native
// modules) so it runs under system `node`. Run: npm run spike:extract
import { spawn, execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const tmp = mkdtempSync(join(tmpdir(), 'zede-extract-'))
const sessionId = randomUUID()

// --- the candidate-memory schema (spec §6.2) ---
const candidate = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['fact', 'decision', 'preference', 'entity', 'todo'] },
    content: { type: 'string' },
    confidence: { type: 'number' },
    scope_hint: { type: 'string', enum: ['space', 'global'] }
  },
  required: ['type', 'content', 'confidence']
}
// Structured-output roots are safest as objects, so wrap the array.
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { memories: { type: 'array', items: candidate } },
  required: ['memories']
}
const schemaPath = join(tmp, 'schema.json')
writeFileSync(schemaPath, JSON.stringify(schema))

const systemPrompt =
  'You extract durable memories from a coding-session transcript span. ' +
  'Return ONLY structured JSON matching the schema: an object with a "memories" array. ' +
  'Each memory: {type, content, confidence 0..1, scope_hint}. ' +
  'type in {fact,decision,preference,entity,todo}. No prose, no markdown.'

// A fake transcript span dense with durable facts/decisions/preferences.
const span = [
  'User: For this project I always use pnpm, never npm. Tabs over spaces, always.',
  'Assistant: Noted.',
  'User: The auth service lives at services/auth/server.ts. The login bug was a missing await on verifyToken().',
  'Assistant: Fixed it.',
  'User: We decided to switch internal calls from REST to gRPC. Also my name is Goldie and I prefer terse replies.',
  'Assistant: Understood — switching to gRPC for internal services.'
].join('\n')

const args = [
  '-p',
  span,
  '--output-format',
  'json',
  '--json-schema',
  JSON.stringify(schema),
  '--append-system-prompt',
  systemPrompt,
  '--session-id',
  sessionId
]

console.log('Running: claude -p <span> --output-format json --json-schema <file> --append-system-prompt <…> --session-id', sessionId)
const t0 = Date.now()
const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })
let out = '',
  err = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (err += d))

const killer = setTimeout(() => {
  console.error('TIMEOUT after 120s — killing')
  child.kill('SIGKILL')
}, 120000)

child.on('close', (code) => {
  clearTimeout(killer)
  const ms = Date.now() - t0
  console.log(`\n=== exit=${code}  latency=${ms}ms  stdout=${out.length}B  stderr=${err.length}B ===`)
  if (err.trim()) console.log('--- stderr (tail) ---\n' + err.split('\n').slice(-6).join('\n'))

  console.log('\n--- raw stdout (first 1200 chars) ---\n' + out.slice(0, 1200))

  // Discover the envelope + locate the structured payload.
  let envelope
  try {
    envelope = JSON.parse(out)
    console.log('\n--- envelope keys ---\n' + JSON.stringify(Object.keys(envelope)))
  } catch (e) {
    console.log('\n[envelope is not a single JSON object: ' + e.message + ']')
  }

  const tryParse = (v) => {
    if (v == null) return null
    if (typeof v === 'object') return v
    if (typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch {
        return null
      }
    }
    return null
  }

  let payload = null
  if (envelope) {
    payload = tryParse(envelope.result) || tryParse(envelope.memories) || tryParse(envelope)
    console.log('\n--- envelope.result typeof ---', typeof envelope.result)
    for (const k of ['session_id', 'is_error', 'subtype', 'total_cost_usd', 'duration_ms', 'num_turns']) {
      if (k in envelope) console.log(`  envelope.${k} =`, envelope[k])
    }
  } else {
    payload = tryParse(out)
  }

  const memories = payload?.memories ?? (Array.isArray(payload) ? payload : null)
  console.log('\n--- extracted memories ---')
  if (memories) {
    console.log(`PARSED ${memories.length} candidates:`)
    for (const m of memories) console.log(`  [${m.type}/${m.scope_hint ?? '?'}] (${m.confidence}) ${m.content}`)
  } else {
    console.log('COULD NOT locate a memories[] payload — shape needs adjustment. payload=', JSON.stringify(payload)?.slice(0, 400))
  }

  // Pre-check Spike 2: did a transcript file get created for this session id?
  try {
    const hit = execSync(`find "${process.env.HOME}/.claude/projects" -name "${sessionId}.jsonl" 2>/dev/null`).toString().trim()
    console.log('\n--- transcript for this session id (binding pre-check) ---\n' + (hit || '(none found)'))
  } catch {
    console.log('\n(transcript find failed)')
  }
})
