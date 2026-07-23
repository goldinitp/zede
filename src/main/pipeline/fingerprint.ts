import { createHash } from 'node:crypto'

// Semantic fingerprint for dedup + tombstone matching (spec §6.3, §7).
// v1 is a normalized lexical hash; M2 upgrades to embedding similarity.
// Forgetting relies on this: a re-derived memory must produce the SAME
// fingerprint as the tombstone so it can be suppressed.
export function normalize(content: string): string {
  return content
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fingerprint(content: string): string {
  return createHash('sha256').update(normalize(content)).digest('hex')
}
