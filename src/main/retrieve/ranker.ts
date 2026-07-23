import type { MemoryRepo, MemoryRow } from '../db/memories'

// Token-budget retrieval (spec §6.4). Score = pin + lexical(bm25) + recency +
// frequency + scope + salience [+ semantic cosine, grafted in M3]. Greedy-fill a
// ~1.5k-token budget; pinned forced first up to a pin sub-budget. Pure JS scoring
// over the Space's active set — O(n), comfortably <50ms even at N=10k (§10).

const TOKEN_BUDGET = 1500
const PIN_SUBBUDGET = 600
const RECENCY_HALF_LIFE = 1000 * 60 * 60 * 24 * 14 // 14 days

export const estTokens = (s: string): number => Math.ceil(s.length / 4)

const scopeBoost = (scope: string): number => {
  const normalized = scope.trim().toLowerCase().replace(/[\s_-]+/g, '-')
  if (normalized === 'session') return 0.8
  if (normalized === 'branch') return 0.65
  if (normalized === 'repo' || normalized === 'repository' || normalized === 'space') return 0.5
  if (normalized === 'project' || normalized === 'workspace' || normalized === 'team' || normalized === 'org' || normalized === 'organization')
    return 0.35
  return normalized === 'user' || normalized === 'global' ? 0.2 : 0.3
}

/** Turn free text (cwd + space name + tab titles) into a safe FTS5 MATCH expr. */
export function buildMatchQuery(seed: string): string {
  const toks = [...new Set((seed.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map((t) => t))].slice(0, 16)
  return toks.map((t) => `"${t}"`).join(' OR ')
}

export interface RankInputs {
  spaceId: string
  seed: string
  now: number
}

export interface RankedMemory {
  row: MemoryRow
  score: number
}

export interface RetrieveResult {
  selected: MemoryRow[]
  tokens: number
}

export class Retriever {
  constructor(private readonly repo: MemoryRepo) {}

  /** sim: optional id→cosine map (M3 semantic tier). Absent → lexical-only. */
  rank(inp: RankInputs, sim?: Map<string, number>): RankedMemory[] {
    const rows = this.repo.listActiveRows(inp.spaceId)
    if (!rows.length) return []

    const fts = new Map<string, number>()
    let worst = 0
    for (const { id, rank } of this.repo.searchFts(inp.spaceId, buildMatchQuery(inp.seed))) {
      const mag = -rank // bm25 is negative; lower=better → larger magnitude=better
      fts.set(id, mag)
      if (mag > worst) worst = mag
    }

    const ranked = rows.map((row) => {
      let score = 0
      if (row.pinned) score += 5
      if (worst > 0 && fts.has(row.id)) score += 2 * ((fts.get(row.id) as number) / worst)
      const age = Math.max(0, inp.now - (row.last_used_at ?? row.updated_at ?? row.created_at))
      score += 1.5 * Math.pow(0.5, age / RECENCY_HALF_LIFE)
      score += Math.min(1.5, 0.3 * (row.use_count ?? 0))
      score += scopeBoost(row.scope)
      score += 0.5 * (row.salience ?? row.confidence ?? 0)
      if (sim?.has(row.id)) score += 2.5 * (sim.get(row.id) as number)
      return { row, score }
    })
    ranked.sort((a, b) => b.score - a.score)
    return ranked
  }

  /** Greedy token-budget fill: pinned first (capped), then by score. */
  select(inp: RankInputs, sim?: Map<string, number>): RetrieveResult {
    const ranked = this.rank(inp, sim)
    const selected: MemoryRow[] = []
    let tokens = 0
    let pinTokens = 0

    for (const { row } of ranked) {
      if (!row.pinned) continue
      const t = estTokens(row.content)
      if (pinTokens + t > PIN_SUBBUDGET) continue
      selected.push(row)
      tokens += t
      pinTokens += t
    }
    for (const { row } of ranked) {
      if (row.pinned) continue
      const t = estTokens(row.content)
      if (tokens + t > TOKEN_BUDGET) continue
      selected.push(row)
      tokens += t
    }
    return { selected, tokens }
  }
}
