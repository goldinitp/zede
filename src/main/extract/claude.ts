import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { markInternalSession } from '../capture/internal'
import { MEMORY_TYPES, type Candidate, type Extractor, type ExtractContext, type MemoryType, type ScopeHint } from './types'

// Inline JSON schema (M0 Spike 3: --json-schema takes inline JSON, root = object).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: [...MEMORY_TYPES] },
          content: { type: 'string' },
          confidence: { type: 'number' },
          scope_hint: { type: 'string', enum: ['space', 'global'] }
        },
        required: ['type', 'content', 'confidence']
      }
    }
  },
  required: ['memories']
}

const SYSTEM =
  'You extract DURABLE memories from a coding-session transcript span — things that will still matter weeks from now. ' +
  'Return ONLY structured JSON matching the schema: an object with a "memories" array. ' +
  'Each memory: {type, content, confidence 0..1, scope_hint}. type in {fact,decision,preference,entity,todo}. ' +
  'CAPTURE: stable facts about the user, project, or domain; architectural/product decisions and WHY; the user\'s standing ' +
  'preferences and conventions; important named entities (services, tools, people, key files); and genuine open tasks that outlive this session. ' +
  'DO NOT CAPTURE (omit entirely): transient or procedural steps (run/restart/rebuild/install commands, "npm run dev", git steps); ' +
  'ephemeral debugging notes, hypotheses, root-cause guesses, or the status of work in progress; anything about the assistant\'s own ' +
  'process or this memory tool itself; greetings, acknowledgements, and command/tool output noise; todos obsolete once this session ends. ' +
  'When unsure whether something is durable, OMIT it — prefer a few high-signal memories over many noisy ones. ' +
  'Each content is ONE concise, self-contained, present-tense sentence, no markdown. ' +
  'scope_hint "global" only for facts true across ALL projects (who the user is, cross-project preferences); otherwise "space".'

export interface ClaudeExtractorOptions {
  model?: string
  timeoutMs?: number
}

// Default tier (spec §6.2.1). M0: cold call ~25s/$0.33 on a big model, so pin a
// cheap/fast model and let the caller debounce/batch.
export class ClaudeCodeExtractor implements Extractor {
  private readonly model: string
  private readonly timeoutMs: number

  constructor(opts: ClaudeExtractorOptions = {}) {
    this.model = opts.model ?? 'claude-haiku-4-5-20251001'
    this.timeoutMs = opts.timeoutMs ?? 60_000
  }

  extract(span: string, _ctx: ExtractContext): Promise<Candidate[]> {
    if (!span.trim()) return Promise.resolve([])
    // The child claude writes its own transcript under ~/.claude/projects/<cwd
    // slug>. Registered as internal (and spawned from tmpdir below) so capture
    // never mistakes it for a user session — re-distilling extractor output
    // spawns another extractor, a loop that burns model calls forever and fills
    // the prompt sidebar with "User: User: …" span text.
    const sessionId = randomUUID()
    markInternalSession(sessionId)
    const args = [
      '-p',
      span,
      '--session-id',
      sessionId,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(SCHEMA),
      '--append-system-prompt',
      SYSTEM,
      '--model',
      this.model
    ]
    return new Promise((resolve) => {
      let out = ''
      let child: ChildProcess
      try {
        // spawn throws SYNCHRONOUSLY (not via the 'error' event) when it can't
        // allocate the child's stdio fds — e.g. EBADF/EMFILE under descriptor
        // pressure. Swallow it so a capture hiccup can never bubble up as an
        // unhandled promise rejection (or wedge the pump). Returns no candidates.
        // cwd: tmpdir() — NOT the inherited Electron cwd, which in dev is the
        // very project directory the watcher tails.
        child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir() })
      } catch {
        resolve([])
        return
      }
      const killer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs)
      child.stdout?.on('data', (d) => (out += d))
      child.on('error', () => {
        clearTimeout(killer)
        resolve([])
      })
      child.on('close', () => {
        clearTimeout(killer)
        resolve(parseCandidates(out))
      })
    })
  }
}

// Strict, defensive parse (spec §11: never poison the store on bad output).
export function parseCandidates(stdout: string): Candidate[] {
  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(stdout)
  } catch {
    return []
  }

  let payload: unknown = envelope['structured_output']
  if (payload == null && typeof envelope['result'] === 'string') {
    try {
      payload = JSON.parse(envelope['result'] as string)
    } catch {
      payload = null
    }
  }
  if (payload == null && typeof envelope['result'] === 'object') payload = envelope['result']

  const raw = payload && typeof payload === 'object' ? (payload as { memories?: unknown }).memories : undefined
  const list = Array.isArray(raw) ? raw : Array.isArray(payload) ? payload : []

  const out: Candidate[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.content !== 'string' || !m.content.trim()) continue
    if (!MEMORY_TYPES.includes(m.type as MemoryType)) continue
    out.push({
      type: m.type as MemoryType,
      content: m.content,
      confidence: typeof m.confidence === 'number' ? m.confidence : 0.5,
      scope_hint: (m.scope_hint === 'global' ? 'global' : 'space') as ScopeHint
    })
  }
  return out
}
