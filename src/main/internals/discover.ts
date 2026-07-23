import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import type { ClaudeInternalItem, ClaudeInternalsSnapshot, Scope } from '../../shared/api'

interface DiscoverOptions {
  cwds: string[]
  now: number
}

interface Root {
  path: string
  scope: Scope
  source: string
}

const MAX_ENTRIES = 1200

export function discoverClaudeInternals({ cwds, now }: DiscoverOptions): ClaudeInternalsSnapshot {
  const items: ClaudeInternalItem[] = []
  const seen = new Set<string>()
  const roots = rootsFor(cwds)

  // A skill is exactly skills/<name>/SKILL.md — deeper matches are vendored copies
  // (e.g. a skill's upstream/ or references/ dir), not separate skills.
  for (const root of roots.skillRoots) {
    for (const skillPath of collectFiles(root.path, 'SKILL.md', 1)) {
      add(items, seen, skillItem(skillPath, root))
    }
  }

  for (const root of roots.pluginRoots) {
    for (const install of activePluginInstalls(root.path)) {
      for (const skillsDir of collectDirs(install.path, 'skills', 4)) {
        const plugin = pluginItem(skillsDir, root, install.name)
        add(items, seen, plugin)
        for (const skillPath of collectFiles(skillsDir, 'SKILL.md', 1)) {
          add(items, seen, pluginSkillItem(skillPath, plugin, root))
        }
      }
    }
  }

  for (const root of roots.mcpRoots) {
    for (const serverDir of safeDirs(root.path)) {
      const server = mcpServerItem(serverDir, root)
      add(items, seen, server)
      for (const toolPath of collectFiles(join(serverDir, 'tools'), '.json', 1)) {
        add(items, seen, toolItem(toolPath, server, root))
      }
    }
  }

  items.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name))
  return { items, refreshedAt: now }
}

function rootsFor(cwds: string[]): { skillRoots: Root[]; pluginRoots: Root[]; mcpRoots: Root[] } {
  const home = homedir()
  const uniqueCwds = [...new Set(cwds.filter(Boolean))]
  const skillRoots: Root[] = [
    ...uniqueCwds.flatMap((cwd) => [
      { path: join(cwd, '.claude', 'skills'), scope: 'repo' as Scope, source: 'Repo Claude skills' },
      { path: join(cwd, '.cursor', 'skills'), scope: 'repo' as Scope, source: 'Repo Cursor skills' }
    ]),
    { path: join(home, '.claude', 'skills'), scope: 'user', source: 'User Claude skills' },
    { path: join(home, '.cursor', 'skills-cursor'), scope: 'user', source: 'User Cursor skills' }
  ]
  const pluginRoots: Root[] = [
    { path: join(home, '.claude', 'plugins', 'cache'), scope: 'user', source: 'Claude plugins' },
    { path: join(home, '.cursor', 'plugins', 'cache'), scope: 'user', source: 'Cursor plugins' }
  ]
  const mcpRoots: Root[] = uniqueCwds.map((cwd) => ({
    path: join(home, '.cursor', 'projects', cursorProjectSlug(cwd), 'mcps'),
    scope: 'repo' as Scope,
    source: 'Cursor MCP'
  }))
  return {
    skillRoots: uniqueRoots(skillRoots),
    pluginRoots: uniqueRoots(pluginRoots),
    mcpRoots: uniqueRoots(mcpRoots)
  }
}

function uniqueRoots(roots: Root[]): Root[] {
  const seen = new Set<string>()
  return roots.filter((root) => {
    if (!existsDir(root.path) || seen.has(root.path)) return false
    seen.add(root.path)
    return true
  })
}

function cursorProjectSlug(cwd: string): string {
  return cwd.replace(/^[/\\]+/, '').split(/[\\/]+/).filter(Boolean).join('-')
}

interface PluginInstall {
  path: string
  name?: string
}

// The plugin cache retains superseded versions side by side (e.g. figma/2.2.60..2.2.81),
// so scanning it wholesale lists every skill once per cached version. Only the install
// paths in installed_plugins.json are active; without a manifest (Cursor's cache), take
// the newest version directory per plugin instead.
function activePluginInstalls(cacheRoot: string): PluginInstall[] {
  const manifest = manifestInstalls(join(dirname(cacheRoot), 'installed_plugins.json')).filter((install) =>
    existsDir(install.path)
  )
  if (manifest.length > 0) {
    const unique = new Map<string, PluginInstall>()
    for (const install of manifest) if (!unique.has(install.path)) unique.set(install.path, install)
    return [...unique.values()]
  }
  return latestCachedInstalls(cacheRoot)
}

function manifestInstalls(manifestPath: string): PluginInstall[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return []
  }
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (!plugins || typeof plugins !== 'object') return []
  const installs: PluginInstall[] = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue
    const name = key.split('@')[0]
    for (const entry of entries) {
      const installPath = (entry as { installPath?: unknown })?.installPath
      if (typeof installPath === 'string' && installPath) installs.push({ path: installPath, name })
    }
  }
  return installs
}

function latestCachedInstalls(cacheRoot: string): PluginInstall[] {
  const installs: PluginInstall[] = []
  for (const marketplaceDir of safeDirs(cacheRoot)) {
    for (const pluginDir of safeDirs(marketplaceDir)) {
      const name = pluginDir.split(sep).pop()
      if (existsDir(join(pluginDir, 'skills'))) {
        installs.push({ path: pluginDir, name })
        continue
      }
      const newest = safeDirs(pluginDir)
        .map((path) => ({ path, mtime: safeMtime(path) }))
        .sort((a, b) => b.mtime - a.mtime)[0]
      if (newest) installs.push({ path: newest.path, name })
    }
  }
  return installs
}

function safeMtime(path: string): number {
  try {
    return lstatSync(path).mtimeMs
  } catch {
    return 0
  }
}

function skillItem(skillPath: string, root: Root): ClaudeInternalItem {
  const raw = readText(skillPath)
  const name = titleFromSkill(raw) || titleCase(dirname(skillPath).split(sep).pop() ?? 'Skill')
  return {
    id: `skill:${skillPath}`,
    kind: 'skill',
    name,
    description: descriptionFromMarkdown(raw) || root.source,
    scope: root.scope,
    source: root.source,
    path: skillPath
  }
}

function pluginSkillItem(skillPath: string, plugin: ClaudeInternalItem, root: Root): ClaudeInternalItem {
  const raw = readText(skillPath)
  const name = titleFromSkill(raw) || titleCase(dirname(skillPath).split(sep).pop() ?? 'Skill')
  return {
    id: `skill:${skillPath}`,
    kind: 'skill',
    name,
    description: descriptionFromMarkdown(raw) || plugin.name,
    scope: root.scope,
    source: plugin.name,
    path: skillPath,
    parentId: plugin.id
  }
}

function pluginItem(skillsDir: string, root: Root, installName?: string): ClaudeInternalItem {
  const pluginDir = dirname(skillsDir)
  const name = installName ? titleCase(installName) : pluginName(pluginDir, root.path)
  const skillCount = safeDirs(skillsDir).length
  return {
    id: `plugin:${pluginDir}`,
    kind: 'plugin',
    name,
    description: `Provides ${skillCount} skill${skillCount === 1 ? '' : 's'}`,
    scope: root.scope,
    source: root.source,
    path: pluginDir
  }
}

function mcpServerItem(serverDir: string, root: Root): ClaudeInternalItem {
  const name = titleCase(serverDir.split(sep).pop()?.replace(/^plugin-/, '') ?? 'MCP Server')
  const toolCount = safeFiles(join(serverDir, 'tools'), '.json').length
  return {
    id: `mcp:${serverDir}`,
    kind: 'mcp-server',
    name,
    description: `${toolCount} tool descriptor${toolCount === 1 ? '' : 's'}`,
    scope: root.scope,
    source: root.source,
    path: serverDir
  }
}

function toolItem(toolPath: string, server: ClaudeInternalItem, root: Root): ClaudeInternalItem {
  const raw = readText(toolPath)
  let descriptor: { name?: unknown; description?: unknown } = {}
  try {
    descriptor = JSON.parse(raw) as { name?: unknown; description?: unknown }
  } catch {
    /* malformed descriptors still get listed by filename */
  }
  const filename = toolPath.split(sep).pop()?.replace(/\.json$/, '') ?? 'tool'
  return {
    id: `tool:${toolPath}`,
    kind: 'tool',
    name: typeof descriptor.name === 'string' ? descriptor.name : titleCase(filename),
    description: typeof descriptor.description === 'string' ? descriptor.description : server.name,
    scope: root.scope,
    source: server.name,
    path: toolPath,
    parentId: server.id
  }
}

function add(items: ClaudeInternalItem[], seen: Set<string>, item: ClaudeInternalItem): void {
  if (seen.has(item.id)) return
  seen.add(item.id)
  items.push(item)
}

function collectFiles(root: string, match: string, maxDepth: number): string[] {
  const out: string[] = []
  walk(root, maxDepth, (path, isDir) => {
    if (isDir) return
    const name = path.split(sep).pop() ?? ''
    if (match.startsWith('.') ? name.endsWith(match) : name === match) out.push(path)
  })
  return out
}

function collectDirs(root: string, match: string, maxDepth: number): string[] {
  const out: string[] = []
  walk(root, maxDepth, (path, isDir) => {
    if (isDir && path.split(sep).pop() === match) out.push(path)
  })
  return out
}

function walk(root: string, maxDepth: number, visit: (path: string, isDir: boolean) => void): void {
  if (!existsDir(root)) return
  let entries = 0
  const loop = (dir: string, depth: number): void => {
    if (entries >= MAX_ENTRIES || depth < 0) return
    for (const entry of safeEntries(dir)) {
      if (entries >= MAX_ENTRIES) return
      const path = join(dir, entry.name)
      const isDir = entry.isDirectory()
      entries++
      visit(path, isDir)
      if (isDir) loop(path, depth - 1)
    }
  }
  loop(root, maxDepth)
}

function safeEntries(path: string): { name: string; isDirectory: () => boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter(
      (entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules'
    )
  } catch {
    return []
  }
}

function safeDirs(path: string): string[] {
  return safeEntries(path)
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name))
}

function safeFiles(path: string, suffix: string): string[] {
  return safeEntries(path)
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => join(path, entry.name))
}

function existsDir(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, 4000)
  } catch {
    return ''
  }
}

function titleFromSkill(raw: string): string {
  const heading = raw.match(/^#\s+(.+)$/m)?.[1]
  return heading?.trim() ?? ''
}

function descriptionFromMarkdown(raw: string): string {
  return (
    raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#') && !line.startsWith('---') && !line.includes(': /')) ?? ''
  )
}

function pluginName(pluginDir: string, cacheRoot: string): string {
  const parts = relative(cacheRoot, pluginDir).split(sep).filter(Boolean)
  const meaningful = parts.filter((part) => !/^[a-f0-9]{12,}$/i.test(part) && !/^\d+\.\d+/.test(part))
  return titleCase(meaningful.at(-1) ?? parts.at(-1) ?? 'Plugin')
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function kindRank(kind: ClaudeInternalItem['kind']): number {
  return kind === 'plugin' ? 0 : kind === 'skill' ? 1 : kind === 'mcp-server' ? 2 : 3
}

function scopeRank(scope: string): number {
  const normalized = scope.trim().toLowerCase()
  if (normalized === 'session') return 0
  if (normalized === 'repo' || normalized === 'space') return 10
  if (normalized === 'project' || normalized === 'workspace') return 20
  return normalized === 'user' || normalized === 'global' ? 90 : 50
}
