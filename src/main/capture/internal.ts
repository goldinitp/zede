// Sessions Zede itself starts (e.g. the `claude -p` memory extractor) must be
// invisible to capture. An extractor transcript's "user message" IS a distilled
// span ("User: … Assistant: …"), so re-capturing it feeds the extractor its own
// output: every generation re-spawns `claude -p` on a span of the previous one
// — an unbounded model-call loop — and each generation's span lands in the
// prompt sidebar as a bogus "User: User: …" prompt. Callers register the
// session id BEFORE spawning; the watcher checks it before claiming or
// flushing a transcript. In-memory only: across restarts the cwd isolation in
// ClaudeCodeExtractor (transcripts land under tmpdir's slug, never a watched
// project) is what keeps old extractor transcripts out of reach.
const ids = new Set<string>()

export function markInternalSession(id: string): void {
  ids.add(id)
}

export function isInternalSession(id: string): boolean {
  return ids.has(id)
}
