// Embedding tiers (spec §6.2.2 / §13.2). Same interface for all; the ranker only
// sees cosine similarity. HashingEmbedder is the zero-dep, deterministic floor
// (real, offline, testable). TransformersEmbedder is the MiniLM-384 quality tier,
// lazily imported so the dependency is optional.

export interface Embedder {
  readonly model: string
  readonly dim: number
  embed(text: string): Promise<Float32Array>
}

function l2normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

// FNV-1a → 32-bit, used to bucket tokens.
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Bag-of-tokens hashing embedder (uni + bigrams). Cosine reflects shared
 * vocabulary — enough for "find related / contradicting memories" and tests,
 * without the model download. The honest floor, not a MiniLM substitute.
 */
export class HashingEmbedder implements Embedder {
  readonly model = 'hashing-v1'
  readonly dim = 256

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim)
    const toks = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1)
    for (let i = 0; i < toks.length; i++) {
      v[hash32(toks[i]) % this.dim] += 1
      if (i > 0) v[hash32(toks[i - 1] + ' ' + toks[i]) % this.dim] += 0.5 // bigram, weaker
    }
    return l2normalize(v)
  }
}

/**
 * transformers.js all-MiniLM-L6-v2 (384-dim), lazily imported so the package is
 * optional. Non-literal import specifier dodges static module resolution; if the
 * dependency is absent the caller falls back to HashingEmbedder.
 */
export class TransformersEmbedder implements Embedder {
  readonly model = 'minilm-l6-v2'
  readonly dim = 384
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe: any
  private pkg = '@huggingface/transformers'

  private async ensure(): Promise<void> {
    if (this.pipe) return
    const mod = await import(this.pkg)
    this.pipe = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ensure()
    const out = await this.pipe(text, { pooling: 'mean', normalize: true })
    return Float32Array.from(out.data as Iterable<number>)
  }
}

// --- math + storage helpers (brute-force cosine over BLOB vectors) ---
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i] // both pre-normalized
  return dot
}

export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

export function blobToVec(buf: Buffer): Float32Array {
  // Copy into an aligned buffer (SQLite BLOBs aren't guaranteed 4-byte aligned).
  const copy = Buffer.from(buf)
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}
