import { MEMORY_TYPES, type Candidate, type Extractor, type ExtractContext, type MemoryType, type ScopeHint } from './types'

// Hard-offline tier (spec §6.2.2): a local Ollama model. No new dependency — talks
// to the daemon's HTTP API. Best-effort: if Ollama isn't running, returns [].
const SYSTEM =
  'Extract durable memories from this coding-session span. Reply ONLY with JSON: ' +
  '{"memories":[{"type","content","confidence","scope_hint"}]}. ' +
  'type in {fact,decision,preference,entity,todo}; content one concise sentence; ' +
  'scope_hint "global" only for facts true across all projects. Ignore chatter.'

export interface OllamaOptions {
  model?: string
  endpoint?: string
  timeoutMs?: number
}

export class OllamaExtractor implements Extractor {
  private readonly model: string
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? 'llama3.2'
    this.endpoint = opts.endpoint ?? 'http://127.0.0.1:11434'
    this.timeoutMs = opts.timeoutMs ?? 60_000
  }

  async extract(span: string, _ctx: ExtractContext): Promise<Candidate[]> {
    if (!span.trim()) return []
    const ctl = new AbortController()
    const killer = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          model: this.model,
          system: SYSTEM,
          prompt: span,
          stream: false,
          format: 'json',
          options: { temperature: 0 }
        })
      })
      if (!res.ok) return []
      const env = (await res.json()) as { response?: string }
      return parseOllama(env.response ?? '')
    } catch {
      return [] // daemon down / timeout / abort
    } finally {
      clearTimeout(killer)
    }
  }
}

export function parseOllama(text: string): Candidate[] {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return []
  }
  const raw = payload && typeof payload === 'object' ? (payload as { memories?: unknown }).memories : undefined
  const list = Array.isArray(raw) ? raw : []
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
