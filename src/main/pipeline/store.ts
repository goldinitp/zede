import { randomUUID } from 'node:crypto'
import type { MemoryRepo } from '../db/memories'
import type { Candidate } from '../extract/types'
import type { Memory } from '../../shared/api'
import { redact } from './redact'
import { fingerprint } from './fingerprint'

export interface StoreContext {
  spaceId: string
  sessionId: string
  transcriptPath: string
  spanStart: number
  spanEnd: number
  excerpt: string
}

export interface StoreResult {
  inserted: Memory[]
  deduped: number
  suppressed: number
}

// redact → fingerprint → (tombstone? drop) → (active dup? bump) → insert.
// The tombstone check is the headline: a re-derived memory whose fingerprint
// matches a tombstone is dropped, so forgetting sticks across extraction passes
// even though the source transcript still exists (spec §7).
export class MemoryStore {
  constructor(
    private readonly repo: MemoryRepo,
    private readonly onLearned: (m: Memory) => void,
    private readonly onForgotten: (id: string) => void
  ) {}

  store(candidates: Candidate[], ctx: StoreContext, now: number): StoreResult {
    const result: StoreResult = { inserted: [], deduped: 0, suppressed: 0 }
    const insertedIds: string[] = []

    this.repo.transaction(() => {
      for (const c of candidates) {
        const content = redact(c.content).text.trim()
        if (!content) continue

        const fp = fingerprint(content)

        if (this.repo.isTombstoned(fp)) {
          result.suppressed++
          continue
        }

        const dup = this.repo.findActiveByFingerprint(fp)
        if (dup) {
          this.repo.bumpUse(dup.id, now)
          result.deduped++
          continue
        }

        const id = randomUUID()
        // Promote user-level facts to the global (cross-Space, persistent) tier:
        // preferences are about the user, not one project — plus anything the
        // extractor explicitly marked global.
        const scope = c.scope_hint === 'global' || c.type === 'preference' ? 'global' : 'space'
        this.repo.insertMemory({
          id,
          spaceId: scope === 'global' ? null : ctx.spaceId,
          scope,
          type: c.type,
          content,
          confidence: c.confidence,
          salience: c.confidence,
          sourceHash: fp,
          now
        })
        this.repo.insertSource({
          memoryId: id,
          sessionId: ctx.sessionId,
          transcriptPath: ctx.transcriptPath,
          spanStart: ctx.spanStart,
          spanEnd: ctx.spanEnd,
          excerpt: ctx.excerpt
        })
        insertedIds.push(id)
      }
    })()

    for (const id of insertedIds) {
      const m = this.repo.getMemory(id)
      if (m) {
        result.inserted.push(m)
        this.onLearned(m)
      }
    }
    return result
  }

  /** Soft delete (spec §7 default): tombstone + fingerprint + audit. Recoverable. */
  softDelete(memoryId: string, now: number, by: 'user' | 'system' = 'user'): boolean {
    const row = this.repo.getRow(memoryId)
    if (!row) return false

    this.repo.transaction(() => {
      this.repo.markTombstoned(memoryId, now)
      this.repo.insertTombstone({
        id: randomUUID(),
        fingerprint: row.source_hash,
        scope: row.scope,
        spaceId: row.space_id,
        reason: by === 'user' ? 'user delete' : 'system',
        by,
        now
      })
      this.repo.insertAudit({
        id: randomUUID(),
        ts: now,
        action: 'memory.tombstone',
        targetType: 'memory',
        targetId: memoryId,
        detail: JSON.stringify({
          fingerprint: row.source_hash,
          content: row.content,
          type: row.type,
          spaceId: row.space_id,
          scope: row.scope
        })
      })
    })()

    this.onForgotten(memoryId)
    return true
  }

  /**
   * Hard delete (spec §7): purge the row + its sources/excerpts but KEEP the
   * fingerprint tombstone, so the fact still cannot be re-derived. Not undoable.
   */
  hardDelete(memoryId: string, now: number): boolean {
    const row = this.repo.getRow(memoryId)
    if (!row) return false

    this.repo.transaction(() => {
      this.repo.insertTombstone({
        id: randomUUID(),
        fingerprint: row.source_hash,
        scope: row.scope,
        spaceId: row.space_id,
        reason: 'hard delete',
        by: 'user',
        now
      })
      this.repo.insertAudit({
        id: randomUUID(),
        ts: now,
        action: 'memory.hard_delete',
        targetType: 'memory',
        targetId: memoryId,
        detail: JSON.stringify({
          fingerprint: row.source_hash,
          content: row.content,
          type: row.type,
          spaceId: row.space_id,
          scope: row.scope
        })
      })
      this.repo.hardDeleteRow(memoryId) // cascades memory_sources; fingerprint survives in tombstones
    })()

    this.onForgotten(memoryId)
    return true
  }

  /** Undo a soft delete inside the undo window: lift the tombstone, reactivate. */
  undo(memoryId: string, now: number): Memory | null {
    const row = this.repo.getRow(memoryId)
    if (!row || row.status !== 'tombstoned') return null

    this.repo.transaction(() => {
      this.repo.deleteTombstonesByFingerprint(row.source_hash)
      this.repo.setStatus(memoryId, 'active', now)
      this.repo.insertAudit({
        id: randomUUID(),
        ts: now,
        action: 'memory.undo',
        targetType: 'memory',
        targetId: memoryId,
        detail: JSON.stringify({ fingerprint: row.source_hash })
      })
    })()

    const m = this.repo.getMemory(memoryId)
    if (m) this.onLearned(m)
    return m ?? null
  }

  setPinned(memoryId: string, pinned: boolean, now: number): boolean {
    return this.repo.setPinned(memoryId, pinned, now)
  }
}
