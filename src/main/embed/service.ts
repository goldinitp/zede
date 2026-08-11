import { randomUUID } from 'node:crypto'
import type { MemoryRepo } from '../db/memories'
import type { Embedder } from './embedder'
import { blobToVec, cosine, vecToBlob } from './embedder'
import type { Memory } from '../../shared/api'

// Only opinions get superseded; facts/entities/todos accumulate.
const SUPERSEDE_TYPES = new Set(['preference', 'decision'])
// Hashing vectors are coarser than MiniLM, so the bar is model-specific. 0.6
// clears same-topic opinions (≈0.68) while staying above a shared phrase skeleton
// like "I prefer … for …" (≈0.33). MiniLM is sharper, so it sits higher.
const supersedeThreshold = (model: string): number => (model === 'hashing-v1' ? 0.6 : 0.84)

/**
 * Async embedding worker. Vectorizes memories off the hot
 * path; on each new opinion, looks for a near-duplicate-but-different earlier one
 * and supersedes it (status='superseded' + a 'supersedes' link) — never a silent
 * overwrite.
 */
export class EmbeddingService {
  private queue: Memory[] = []
  private inflight: Promise<void> | null = null

  constructor(
    private readonly repo: MemoryRepo,
    private readonly embedder: () => Embedder,
    private readonly now: () => number,
    private readonly onChanged: () => void
  ) {}

  enqueue(m: Memory): void {
    this.queue.push(m)
    void this.pump()
  }

  /** Launch backfill: embed any active memory still missing a vector. */
  backfillActive(): void {
    this.queue.push(...this.repo.listUnembeddedActive())
    void this.pump()
  }

  /** Resolves only once the queue is fully processed (tests). A pump that was
   *  already in flight when drain() is called is awaited, not skipped. */
  async drain(): Promise<void> {
    while (this.queue.length || this.inflight) await this.pump()
  }

  private pump(): Promise<void> {
    if (this.inflight) return this.inflight
    if (!this.queue.length) return Promise.resolve()
    this.inflight = this.run().finally(() => {
      this.inflight = null
      // An enqueue microtask can land after run observes an empty queue but
      // before this finally executes. Never strand that item until a later enqueue.
      if (this.queue.length) void this.pump()
    })
    return this.inflight
  }

  private async run(): Promise<void> {
    while (this.queue.length) {
      const m = this.queue.shift() as Memory
      try {
        const emb = this.embedder()
        const vec = await emb.embed(m.content)
        this.repo.upsertEmbedding(m.id, emb.model, emb.dim, vecToBlob(vec), this.now())
        if (await this.maybeSupersede(m, emb.model, vec)) this.onChanged()
      } catch {
        /* embedding is best-effort; ranking degrades to lexical */
      }
      // HashingEmbedder resolves immediately, so `await embed()` alone only
      // yields to the microtask queue. A large startup backfill would otherwise
      // drain here without returning to libuv, freezing PTY data/input and all
      // IPC until every vector and supersede scan finished.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  private async maybeSupersede(m: Memory, model: string, vec: Float32Array): Promise<boolean> {
    if (!SUPERSEDE_TYPES.has(m.type)) return false
    const row = this.repo.getRow(m.id)
    if (!row || row.status !== 'active') return false
    let changed = false
    const threshold = supersedeThreshold(model)
    const candidates = this.repo.activeSameTypeWithEmbeddings(
      m.spaceId ?? '∅',
      m.type,
      m.scope,
      m.id,
      model
    )
    let yielded = false
    for (let i = 0; i < candidates.length; i++) {
      if (i > 0 && i % 100 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        yielded = true
      }
      const { row: cand, vec: candidateVec } = candidates[i]
      if (yielded) {
        const current = this.repo.getRow(cand.id)
        if (!current || current.status !== 'active' || current.source_hash !== cand.source_hash) continue
      }
      if (cand.source_hash === row.source_hash) continue
      if (cosine(vec, blobToVec(candidateVec)) >= threshold) {
        this.repo.setStatus(cand.id, 'superseded', this.now()) // m (newer) wins
        this.repo.insertLink({ id: randomUUID(), srcId: m.id, dstId: cand.id, rel: 'supersedes', now: this.now() })
        this.repo.insertAudit({
          id: randomUUID(),
          ts: this.now(),
          action: 'memory.supersede',
          targetType: 'memory',
          targetId: cand.id,
          detail: JSON.stringify({ by: m.id, content: cand.content })
        })
        changed = true
      }
    }
    return changed
  }
}
