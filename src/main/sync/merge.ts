import { randomUUID } from 'node:crypto'
import type { MemoryRepo, MemoryRow } from '../db/memories'
import type { SyncTree, SyncedMemory } from './format'
import { SYNCED_SETTINGS } from './format'

// DB-space merge: git is transport only, conflicts are resolved here, never as
// git conflict markers. Rules (in application order):
//   1. Tombstones first — forgets propagate; union by fingerprint. A local
//      active memory dies only if its edit clock is OLDER than the forget
//      decision, so an undo (which mints a newer edit) survives stale files.
//   2. Memories — unknown id inserts unless its fingerprint is tombstoned
//      locally (never resurrect); known id is last-write-wins on edited_at.
//      Equal clocks with different content tie-break on the serialized content
//      (symmetric — both machines converge without knowing who wrote first).
//   3. File ABSENCE is never deletion — deletes travel only via tombstones, so
//      a half-written tree can't nuke rows.

export interface ImportResult {
  memoriesAdded: number
  memoriesUpdated: number
  tombstonesAdded: number
  tombstonesApplied: number
  spacesChanged: number
  linksAdded: number
  membershipsAdded: number
  settingsChanged: number
  /** Memory ids whose content changed — the caller re-embeds these. */
  changedMemoryIds: string[]
}

const editClock = (r: MemoryRow): number => r.edited_at ?? r.updated_at

/** Durable fields only — local ranking signals never count as a difference. */
function durablyDiffers(local: MemoryRow, remote: SyncedMemory): boolean {
  return (
    local.content !== remote.content ||
    local.status !== remote.status ||
    (local.pinned === 1) !== remote.pinned ||
    local.type !== remote.type ||
    local.scope !== remote.scope ||
    (local.space_id ?? null) !== (remote.spaceId ?? null) ||
    local.source_hash !== remote.sourceHash
  )
}

/** Symmetric tie-break for equal edit clocks: higher content string wins. */
function remoteWinsTie(local: MemoryRow, remote: SyncedMemory): boolean {
  return remote.content > local.content || (remote.content === local.content && remote.status > local.status)
}

export function importTree(repo: MemoryRepo, tree: SyncTree, now: number): ImportResult {
  const res: ImportResult = {
    memoriesAdded: 0,
    memoriesUpdated: 0,
    tombstonesAdded: 0,
    tombstonesApplied: 0,
    spacesChanged: 0,
    linksAdded: 0,
    membershipsAdded: 0,
    settingsChanged: 0,
    changedMemoryIds: []
  }

  repo.transaction(() => {
    // 1. Spaces (before memories/membership so FK targets exist).
    const localSpaces = new Map(repo.allSpaceRows().map((s) => [s.id, s]))
    for (const s of tree.spaces) {
      const local = localSpaces.get(s.id)
      if (!local) {
        repo.upsertSyncedSpace(s)
        res.spacesChanged++
        continue
      }
      const localClock = local.updated_at ?? local.created_at
      const differs = local.name !== s.name || (local.icon ?? null) !== (s.icon ?? null) || local.sort_order !== s.sortOrder
      if (!differs) {
        // Same content, different clocks (e.g. both machines bootstrapped their
        // own "default" Space) — converge on the min so the exported file stops
        // ping-ponging between the two machines' timestamps.
        const createdAt = Math.min(local.created_at, s.createdAt)
        const updatedAt = Math.min(localClock, s.updatedAt)
        if (createdAt !== local.created_at || updatedAt !== localClock) {
          repo.upsertSyncedSpace({ id: s.id, name: local.name, icon: local.icon, sortOrder: local.sort_order, createdAt, updatedAt })
        }
        continue
      }
      if (s.updatedAt > localClock || (s.updatedAt === localClock && s.name > local.name)) {
        repo.upsertSyncedSpace(s)
        res.spacesChanged++
      }
    }

    // 2. Tombstones — union, then apply to local active rows behind the clock guard.
    for (const t of tree.tombstones) {
      const inserted = repo.insertTombstoneIfAbsent({
        id: randomUUID(),
        fingerprint: t.fingerprint,
        scope: t.scope,
        spaceId: t.spaceId,
        reason: t.reason ?? 'synced forget',
        by: t.createdBy ?? 'sync',
        now: t.createdAt
      })
      if (inserted) res.tombstonesAdded++
      for (const row of repo.activesByFingerprint(t.fingerprint)) {
        if (editClock(row) >= t.createdAt) continue // undo/edit is newer than the forget — it survives
        repo.markTombstoned(row.id, now)
        res.tombstonesApplied++
      }
    }

    // 3. Memories.
    const localRows = new Map(repo.allRows().map((r) => [r.id, r]))
    for (const m of tree.memories) {
      const local = localRows.get(m.id)
      if (!local) {
        if (repo.isTombstoned(m.sourceHash)) continue // never resurrect a forgotten fact
        repo.upsertSynced({ ...m, now })
        res.memoriesAdded++
        res.changedMemoryIds.push(m.id)
        continue
      }
      const localClock = editClock(local)
      if (!durablyDiffers(local, m)) {
        // Identical content minted independently on both machines (mirrored
        // `cc:` ids) — converge clocks on the min so exports stop oscillating.
        // Min is also the conservative side of the tombstone guard: identical
        // content never dodges a forget via an inflated edit clock.
        const createdAt = Math.min(local.created_at, m.createdAt)
        const editedAt = Math.min(localClock, m.editedAt)
        if (createdAt !== local.created_at || editedAt !== localClock) {
          repo.upsertSynced({ ...m, content: local.content, createdAt, editedAt, now })
        }
        continue
      }
      if (m.editedAt > localClock || (m.editedAt === localClock && remoteWinsTie(local, m))) {
        repo.upsertSynced({ ...m, now })
        res.memoriesUpdated++
        if (local.content !== m.content) res.changedMemoryIds.push(m.id)
      }
    }

    // 4. Links — insert-or-ignore; skip edges whose endpoints don't exist here
    //    (FK enforced), e.g. an endpoint that was never synced or was hard-deleted.
    for (const l of tree.links) {
      if (!repo.getRow(l.srcId) || !repo.getRow(l.dstId)) continue
      if (repo.insertLinkIfAbsent({ id: l.id, srcId: l.srcId, dstId: l.dstId, rel: l.rel, createdAt: l.createdAt })) {
        res.linksAdded++
      }
    }

    // 5. Membership — union, FK-guarded.
    const spaces = new Set(repo.allSpaceRows().map((s) => s.id))
    for (const [memoryId, spaceId] of tree.membership) {
      if (!repo.getRow(memoryId) || !spaces.has(spaceId)) continue
      const before = repo.listMemberships(memoryId).includes(spaceId)
      if (!before) {
        repo.addMembership(memoryId, spaceId)
        res.membershipsAdded++
      }
    }

    // 6. Settings — per-key LWW; only curated keys ever cross machines.
    const synced = new Set<string>(SYNCED_SETTINGS)
    for (const [key, remote] of Object.entries(tree.settings)) {
      if (!synced.has(key)) continue
      const local = repo.getSettingRow(key)
      if (local && local.value === remote.value) {
        if (remote.editedAt < local.updatedAt) repo.setSetting(key, local.value, remote.editedAt) // converge clocks
        continue
      }
      if (!local || remote.editedAt > local.updatedAt || (remote.editedAt === local.updatedAt && remote.value > local.value)) {
        repo.setSetting(key, remote.value, remote.editedAt)
        res.settingsChanged++
      }
    }
  })()

  return res
}
