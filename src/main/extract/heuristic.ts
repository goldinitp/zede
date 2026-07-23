import type { Candidate, Extractor, ExtractContext, MemoryType, ScopeHint } from './types'

interface Rule {
  re: RegExp
  type: MemoryType
  scope?: ScopeHint
  conf: number
}

// Zero-dependency extractor (spec §6.2 floor). Pattern-matches a span for durable
// statements. Lower recall than `claude -p`, but fully offline and deterministic.
const RULES: Rule[] = [
  { re: /\b(?:i (?:prefer|like|always|usually|tend to)|please always|let'?s always)\b[^.!?\n]{0,120}/gi, type: 'preference', conf: 0.6 },
  { re: /\b(?:use|using)\s+[a-z0-9._-]+\s+(?:not|instead of|over)\s+[a-z0-9._-]+/gi, type: 'preference', conf: 0.6 },
  { re: /\b(?:we (?:decided|agreed|will|chose)|let'?s (?:go with|use)|going with|switch(?:ing)? to|adopt(?:ed)?)\b[^.!?\n]{0,120}/gi, type: 'decision', conf: 0.62 },
  { re: /\b(?:my name is|call me)\s+[A-Z][a-z]+/gi, type: 'entity', scope: 'global', conf: 0.7 },
  { re: /\b[a-z0-9 _-]{2,40}\s+(?:is (?:located|at|in)|lives? (?:at|in))\s+[^.!?\n]{1,80}/gi, type: 'entity', conf: 0.55 },
  { re: /\b(?:todo|to-do|need to|remember to|don'?t forget to)\b[^.!?\n]{0,120}/gi, type: 'todo', conf: 0.55 }
]

export class HeuristicExtractor implements Extractor {
  extract(span: string, _ctx: ExtractContext): Promise<Candidate[]> {
    const seen = new Set<string>()
    const out: Candidate[] = []
    for (const rule of RULES) {
      for (const match of span.matchAll(rule.re)) {
        const content = normalize(match[0])
        if (content.length < 8 || content.length > 160) continue
        const key = content.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ type: rule.type, content, confidence: rule.conf, scope_hint: rule.scope ?? 'space' })
        if (out.length >= 20) return Promise.resolve(out)
      }
    }
    return Promise.resolve(out)
  }
}

function normalize(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '')
  t = t.charAt(0).toUpperCase() + t.slice(1)
  if (!/[.!?]$/.test(t)) t += '.'
  return t
}
