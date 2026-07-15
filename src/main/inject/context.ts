import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryRow } from '../db/memories'
import type { MemoryType } from '../../shared/api'

// Injection seam (spec §6.5). Adapter A (default, inspectable): write the ranked
// set to a gitignored `.zede/context.md` and reference it from `CLAUDE.md` via
// Claude Code's `@import`. Adapter B (flag): the caller adds
// `--append-system-prompt-file <context.md>` to the spawn — applied in PtyManager.
// Both consume the same artifact this module produces.

const BEGIN = '<!-- zede:begin (managed — do not edit) -->'
const END = '<!-- zede:end -->'
const IMPORT_LINE = '@.zede/context.md'

// Pre-rename the app was called Loom and wrote a `loom:`-prefixed block importing
// `.loom/context.md`. That file is no longer updated, so any project still carrying
// the old block would have Claude Code import stale memory forever — strip it.
const LEGACY_BEGIN = '<!-- loom:begin (managed — do not edit) -->'
const LEGACY_END = '<!-- loom:end -->'

const TYPE_HEADING: Record<MemoryType, string> = {
  preference: 'Preferences',
  decision: 'Decisions',
  fact: 'Facts',
  entity: 'Entities',
  todo: 'Open items'
}
const TYPE_ORDER: MemoryType[] = ['preference', 'decision', 'fact', 'entity', 'todo']

export function renderContext(rows: MemoryRow[], spaceName: string): string {
  const lines = [
    `# Zede memory — ${spaceName}`,
    '',
    '_Durable context distilled from earlier Claude Code sessions in this Space._',
    '_Deletions in Zede are authoritative: removed items will not reappear here._',
    ''
  ]
  for (const t of TYPE_ORDER) {
    const group = rows.filter((r) => r.type === t)
    if (!group.length) continue
    lines.push(`## ${TYPE_HEADING[t]}`)
    for (const r of group) lines.push(`- ${r.pinned ? '📌 ' : ''}${r.content}`)
    lines.push('')
  }
  if (rows.length === 0) lines.push('_(no memories yet)_')
  return lines.join('\n') + '\n'
}

export interface InjectionResult {
  contextPath: string
  relPath: string
}

export class ContextWriter {
  /** Adapter A. Writes the artifact and (best-effort) wires gitignore + CLAUDE.md. */
  write(cwd: string, rows: MemoryRow[], spaceName: string, adapter: 'file' | 'flag'): InjectionResult {
    const dir = join(cwd, '.zede')
    const contextPath = join(dir, 'context.md')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(contextPath, renderContext(rows, spaceName), 'utf8')
      this.ensureGitignore(cwd)
      if (adapter === 'file') this.ensureClaudeMdReference(cwd)
    } catch {
      /* injection is best-effort; a fresh session simply gets no prior context */
    }
    return { contextPath, relPath: '.zede/context.md' }
  }

  private ensureGitignore(cwd: string): void {
    const gi = join(cwd, '.gitignore')
    const hasGit = existsSync(join(cwd, '.git'))
    if (existsSync(gi)) {
      const body = readFileSync(gi, 'utf8')
      if (!body.split(/\r?\n/).some((l) => l.trim() === '.zede/' || l.trim() === '.zede')) {
        writeFileSync(gi, body.replace(/\s*$/, '') + '\n.zede/\n', 'utf8')
      }
    } else if (hasGit) {
      writeFileSync(gi, '.zede/\n', 'utf8')
    }
  }

  private ensureClaudeMdReference(cwd: string): void {
    const path = join(cwd, 'CLAUDE.md')
    const block = `${BEGIN}\n${IMPORT_LINE}\n${END}`
    if (!existsSync(path)) {
      writeFileSync(path, `${block}\n`, 'utf8')
      return
    }
    const original = readFileSync(path, 'utf8')
    const body = original.replace(new RegExp(`${escapeRe(LEGACY_BEGIN)}[\\s\\S]*?${escapeRe(LEGACY_END)}\\n?`), '')
    const next =
      body.includes(BEGIN) && body.includes(END)
        ? body.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), block)
        : `${body.replace(/\s*$/, '')}\n\n${block}\n`.replace(/^\n+/, '')
    if (next !== original) writeFileSync(path, next, 'utf8')
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
