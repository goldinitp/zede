import { createHash } from 'node:crypto'
import { redactText } from '../pipeline/redact'
import type { MemoryRepo } from '../db/memories'
import type { MemoryType } from '../../shared/api'

// Wire format for cross-machine sync (spec: user-owned git repo as transport).
// One markdown file per memory — the same frontmatter shape Claude Code keeps
// under ~/.claude/projects/*/memory/ and MirrorService already parses — plus
// small JSON files for the structured tables. Everything here is pure and
// deterministic: same DB state → byte-identical tree, so a no-op sync produces
// no git commit. zede.json is static config only (no timestamps) for the same
// reason; git history records who synced when.

export const FORMAT_VERSION = 1

/** Settings keys that travel across machines. Deliberately excludes machine-local
 *  keys: encKey (OS-keychain-bound), activeSpace/defaultSpace/reseededV1
 *  (runtime/bootstrap), and every sync* key (per-machine sync state). */
export const SYNCED_SETTINGS = [
  'theme',
  'fontFamily',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'scrollback',
  'cursorStyle',
  'cursorBlink',
  'bgOpacity',
  'bgBlur',
  'injectionAdapter',
  'extractionTier',
  'semanticEnabled',
  'pinnedTabPinsMemory',
  'embedTier'
] as const

const MEMORY_TYPES = ['fact', 'decision', 'preference', 'entity', 'todo']
const MEMORY_STATUSES = ['active', 'superseded', 'tombstoned', 'archived']

export interface SyncedMemory {
  id: string
  spaceId: string | null
  scope: string
  type: MemoryType
  content: string
  confidence: number | null
  status: string
  pinned: boolean
  sourceHash: string
  createdAt: number
  editedAt: number
}

export interface SyncedTombstone {
  fingerprint: string
  scope: string | null
  spaceId: string | null
  reason: string | null
  createdAt: number
  createdBy: string | null
}

export interface SyncedLink {
  id: string
  srcId: string
  dstId: string
  rel: string
  createdAt: number
}

export interface SyncedSpace {
  id: string
  name: string
  icon: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type SyncedSettings = Record<string, { value: string; editedAt: number }>

export interface SyncManifest {
  formatVersion: number
  encryption: 'none' | 'aes-256-gcm'
  /** Present when encryption is on: scrypt salt + a check token to verify the
   *  passphrase on a new machine before importing anything. Both base64/opaque. */
  kdf?: { salt: string; check: string }
}

/** Encrypts/decrypts memory bodies only — frontmatter stays plaintext so merge
 *  works without the key ever being needed in git-space. */
export interface BodyCipher {
  encrypt(plaintext: string, id: string): string
  decrypt(token: string, id: string): string
}

export const ENC_PREFIX = 'enc1:'

export interface SyncTree {
  manifest: SyncManifest
  memories: SyncedMemory[]
  tombstones: SyncedTombstone[]
  links: SyncedLink[]
  spaces: SyncedSpace[]
  membership: [string, string][]
  settings: SyncedSettings
}

// --- filenames ---

/** Deterministic, filesystem-safe filename for an id. Clean ids map to
 *  themselves; ids with special chars (`cc:…`) get sanitized + a hash suffix so
 *  two distinct ids can never collide on the sanitized form. */
export function safeName(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]/g, '_')
  if (clean === id) return id
  return `${clean}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
}

// --- memory file (frontmatter + body) ---

export function serializeMemory(m: SyncedMemory, cipher?: BodyCipher): string {
  const body = cipher ? ENC_PREFIX + cipher.encrypt(m.content, m.id) : m.content
  const lines = [
    '---',
    `id: ${m.id}`,
    `space: ${m.spaceId ?? '~'}`,
    `scope: ${m.scope}`,
    `type: ${m.type}`,
    `status: ${m.status}`,
    `confidence: ${m.confidence ?? '~'}`,
    `pinned: ${m.pinned}`,
    `source_hash: ${m.sourceHash}`,
    `created_at: ${m.createdAt}`,
    `edited_at: ${m.editedAt}`,
    '---',
    body
  ]
  return lines.join('\n') + '\n'
}

/** Defensive parse (never poison the store): returns null on anything malformed
 *  or — when the body is encrypted and no/wrong cipher is available — undecryptable. */
export function parseMemoryFile(raw: string, cipher?: BodyCipher): SyncedMemory | null {
  const fenced = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!fenced) return null
  const front = fenced[1]
  let body = fenced[2].replace(/\n$/, '')

  const field = (key: string): string | undefined => {
    const m = front.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'))
    return m ? m[1].trim() : undefined
  }
  const num = (key: string): number | null => {
    const v = field(key)
    if (v === undefined || v === '~') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  const id = field('id')
  const createdAt = num('created_at')
  const editedAt = num('edited_at')
  if (!id || createdAt === null || editedAt === null) return null

  if (body.startsWith(ENC_PREFIX)) {
    if (!cipher) return null
    try {
      body = cipher.decrypt(body.slice(ENC_PREFIX.length), id)
    } catch {
      return null
    }
  }
  const content = body.trim()
  if (!content) return null

  const status = field('status') ?? 'active'
  if (!MEMORY_STATUSES.includes(status)) return null
  const type = field('type') ?? 'fact'
  const space = field('space')

  return {
    id,
    spaceId: space === undefined || space === '~' ? null : space,
    scope: field('scope') || 'global',
    type: (MEMORY_TYPES.includes(type) ? type : 'fact') as MemoryType,
    content,
    confidence: num('confidence'),
    status,
    pinned: field('pinned') === 'true',
    sourceHash: field('source_hash') ?? '',
    createdAt,
    editedAt
  }
}

// --- JSON files (stable key order via literal construction, sorted arrays) ---

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n'

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// --- export: DB → deterministic file tree ---

export function exportTree(repo: MemoryRepo, manifest: SyncManifest, cipher?: BodyCipher): Map<string, string> {
  const files = new Map<string, string>()
  files.set('zede.json', json({ formatVersion: manifest.formatVersion, encryption: manifest.encryption, ...(manifest.kdf ? { kdf: manifest.kdf } : {}) }))

  // Memories — every status (soft-deleted rows keep their content locally and
  // their status must propagate). Belt-and-braces redaction on the way out.
  for (const r of [...repo.allRows()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const m: SyncedMemory = {
      id: r.id,
      spaceId: r.space_id,
      scope: r.scope,
      type: r.type,
      content: redactText(r.content),
      confidence: r.confidence,
      status: r.status,
      pinned: r.pinned === 1,
      sourceHash: r.source_hash,
      createdAt: r.created_at,
      editedAt: r.edited_at ?? r.updated_at
    }
    files.set(`memories/${safeName(r.id)}.md`, serializeMemory(m, cipher))
  }

  // Tombstones — one file per fingerprint (union semantics: identical forgets on
  // two machines produce the same path). Latest decision per fingerprint wins.
  const byFp = new Map<string, SyncedTombstone>()
  for (const t of repo.allTombstoneRows()) {
    const prev = byFp.get(t.fingerprint)
    if (!prev || t.created_at > prev.createdAt) {
      byFp.set(t.fingerprint, {
        fingerprint: t.fingerprint,
        scope: t.scope,
        spaceId: t.space_id,
        reason: t.reason,
        createdAt: t.created_at,
        createdBy: t.created_by
      })
    }
  }
  for (const [fp, t] of [...byFp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    files.set(`tombstones/${safeName(fp)}.json`, json(t))
  }

  for (const l of [...repo.allLinkRows()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    files.set(
      `links/${safeName(l.id)}.json`,
      json({ id: l.id, srcId: l.src_id, dstId: l.dst_id, rel: l.rel, createdAt: l.created_at })
    )
  }

  for (const s of [...repo.allSpaceRows()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const sp: SyncedSpace = {
      id: s.id,
      name: s.name,
      icon: s.icon,
      sortOrder: s.sort_order,
      createdAt: s.created_at,
      updatedAt: s.updated_at ?? s.created_at
    }
    files.set(`spaces/${safeName(s.id)}.json`, json(sp))
  }

  const membership = repo
    .allMembershipRows()
    .map((r) => [r.memory_id, r.space_id] as [string, string])
    .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1))
  files.set('membership.json', json(membership))

  const settings: SyncedSettings = {}
  for (const key of SYNCED_SETTINGS) {
    const row = repo.getSettingRow(key)
    if (row) settings[key] = { value: row.value, editedAt: row.updatedAt }
  }
  files.set('settings.json', json(settings))

  return files
}

// --- import: file tree → structured, validated SyncTree ---

export class FormatVersionError extends Error {
  constructor(found: number) {
    super(`sync repo uses format v${found}; this app supports up to v${FORMAT_VERSION} — update the app to sync`)
  }
}

export function parseManifest(raw: string | undefined): SyncManifest {
  const m = raw ? parseJson<SyncManifest>(raw) : null
  if (!m) return { formatVersion: FORMAT_VERSION, encryption: 'none' }
  if (typeof m.formatVersion === 'number' && m.formatVersion > FORMAT_VERSION) throw new FormatVersionError(m.formatVersion)
  return { formatVersion: m.formatVersion ?? FORMAT_VERSION, encryption: m.encryption === 'aes-256-gcm' ? 'aes-256-gcm' : 'none', kdf: m.kdf }
}

/** Parse a pulled tree. Corrupt or foreign files are skipped, never fatal. */
export function parseTree(files: Map<string, string>, cipher?: BodyCipher): { tree: SyncTree; skipped: number } {
  const manifest = parseManifest(files.get('zede.json'))
  let skipped = 0
  const tree: SyncTree = { manifest, memories: [], tombstones: [], links: [], spaces: [], membership: [], settings: {} }

  for (const [path, raw] of files) {
    if (path.startsWith('memories/') && path.endsWith('.md')) {
      const m = parseMemoryFile(raw, cipher)
      m ? tree.memories.push(m) : skipped++
    } else if (path.startsWith('tombstones/') && path.endsWith('.json')) {
      const t = parseJson<SyncedTombstone>(raw)
      t && typeof t.fingerprint === 'string' && typeof t.createdAt === 'number' ? tree.tombstones.push(t) : skipped++
    } else if (path.startsWith('links/') && path.endsWith('.json')) {
      const l = parseJson<SyncedLink>(raw)
      l && typeof l.id === 'string' && typeof l.srcId === 'string' && typeof l.dstId === 'string' ? tree.links.push(l) : skipped++
    } else if (path.startsWith('spaces/') && path.endsWith('.json')) {
      const s = parseJson<SyncedSpace>(raw)
      s && typeof s.id === 'string' && typeof s.name === 'string' ? tree.spaces.push(s) : skipped++
    } else if (path === 'membership.json') {
      const rows = parseJson<[string, string][]>(raw)
      Array.isArray(rows)
        ? tree.membership.push(...rows.filter((r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string'))
        : skipped++
    } else if (path === 'settings.json') {
      const s = parseJson<SyncedSettings>(raw)
      if (s && typeof s === 'object') {
        for (const [k, v] of Object.entries(s)) {
          if (v && typeof v.value === 'string' && typeof v.editedAt === 'number') tree.settings[k] = v
        }
      } else skipped++
    }
    // zede.json handled above; anything else in the repo (README…) is ignored.
  }
  return { tree, skipped }
}
