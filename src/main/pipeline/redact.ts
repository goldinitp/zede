// Secret redaction (spec §6.3, §9) — the single most important safety control.
// Applied BOTH to spans before they reach the extractor AND to candidate
// content before persistence. Pure + synchronous so it is trivially testable.

interface Pattern {
  name: string
  re: RegExp
}

const PATTERNS: Pattern[] = [
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'aws-akid', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-key', re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  {
    name: 'private-key',
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g
  },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{12,}/g },
  { name: 'secret-kv', re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi }
]

export interface RedactResult {
  text: string
  redactions: number
}

export function redact(input: string): RedactResult {
  let text = input
  let redactions = 0

  for (const { name, re } of PATTERNS) {
    text = text.replace(re, () => {
      redactions++
      return `[REDACTED:${name}]`
    })
  }

  // High-entropy fallback: long opaque tokens that no named rule caught.
  text = text.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, (tok) => {
    if (tok.includes('REDACTED')) return tok
    // Filesystem paths read as one long token because '/' is in the charset, but
    // they aren't secrets — skip them (a real opaque secret has no path slashes).
    if (tok.includes('/')) return tok
    if (shannonEntropy(tok) >= 3.8) {
      redactions++
      return '[REDACTED:high-entropy]'
    }
    return tok
  })

  return { text, redactions }
}

export const redactText = (s: string): string => redact(s).text

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}
