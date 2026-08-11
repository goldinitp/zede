import type { MemoryType, ScopeHint } from '../../shared/api'

export type { MemoryType, ScopeHint }

export const MEMORY_TYPES: readonly MemoryType[] = ['fact', 'decision', 'preference', 'entity', 'todo']

export interface Candidate {
  type: MemoryType
  content: string
  confidence: number
  scope_hint?: ScopeHint
}

export interface ExtractContext {
  cwd: string
  spaceId: string
}

export interface Extractor {
  /** Turn a transcript span into durable memory candidates. Never throws — returns [] on failure. */
  extract(span: string, ctx: ExtractContext): Promise<Candidate[]>
}
