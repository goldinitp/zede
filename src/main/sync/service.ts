import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { MemoryRepo } from '../db/memories'
import type { SyncResult, SyncSetupOptions, SyncStatus } from '../../shared/api'
import { FORMAT_VERSION, exportTree, parseManifest, parseTree, type BodyCipher, type SyncManifest } from './format'
import { importTree, type ImportResult } from './merge'
import { SyncCipher, deriveKey, makeCheck, newSalt, verifyCheck } from './crypto'
import { commitAll, ensureRepo, fetchMain, ghAvailable, ghEnsureRepo, ghLogin, gitAvailable, push, resetToRemote, type GitAuth } from './git'
import { GITHUB_CLIENT_ID, appInstallUrl, checkRepoAccess, newRepoUrl, pollForToken, refreshToken, startDeviceFlow, whoami, type DeviceFlowStart } from './githubAuth'

// Orchestrates the sync cycle: fetch → hard-reset to remote → import (DB-space
// merge) → export → commit → push. The working copy under <userData>/sync is
// always regenerable from the DB, so `reset --hard` is safe by construction and
// git never sees a conflict. Follows MirrorService's shape: plain class owned
// by Core, injected clock, emits through callbacks.

const DIRS = ['memories', 'tombstones', 'links', 'spaces'] as const
const SINGLES = ['zede.json', 'membership.json', 'settings.json'] as const
const DEFAULT_REPO = 'zede-sync'

export interface SyncServiceEvents {
  /** Something was imported into the DB — re-embed + refresh the renderer. */
  onImported(res: ImportResult): void
  /** Sync state changed — push a fresh status to the renderer. */
  onStatus(): void
  openExternal(url: string): void
}

export class SyncService {
  private busy = false
  private deviceFlow: DeviceFlowStart | null = null
  private deviceCancelled = false
  private memKey: Buffer | null = null
  private memToken: string | null = null
  private probed: { git: boolean; gh: boolean } | null = null

  constructor(
    private readonly repo: MemoryRepo,
    private readonly dir: string,
    private readonly now: () => number,
    private readonly events: SyncServiceEvents,
    private readonly log: (msg: string) => void = () => {}
  ) {
    void this.probe()
  }

  private async probe(): Promise<{ git: boolean; gh: boolean }> {
    if (!this.probed) {
      this.probed = { git: await gitAvailable(), gh: await ghAvailable() }
      this.events.onStatus()
    }
    return this.probed
  }

  // --- secrets (OS keychain via safeStorage; memory-only fallback) ---
  private storeSecret(key: string, value: string): void {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        this.repo.setSetting(key, safeStorage.encryptString(value).toString('base64'), this.now())
      }
    } catch {
      /* keychain unavailable — secret lives in memory for this run only */
    }
  }

  private readSecret(key: string): string | null {
    const b64 = this.repo.getSetting(key)
    if (!b64) return null
    try {
      return safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      return null
    }
  }

  // --- status ---
  status(): SyncStatus {
    const g = (k: string): string | undefined => this.repo.getSetting(k)
    const encryption = g('syncEncryption') === 'aes-256-gcm'
    return {
      configured: g('syncEnabled') === '1',
      busy: this.busy,
      authMode: (g('syncAuthMode') as SyncStatus['authMode']) ?? null,
      ghLogin: g('syncGhLogin') ?? (this.memToken ? '…' : null),
      remoteUrl: g('syncRemoteUrl') ?? null,
      encryption,
      needsPassphrase: encryption && !this.resolveKey(),
      gitAvailable: this.probed?.git ?? false,
      ghAvailable: this.probed?.gh ?? false,
      lastSyncAt: Number(g('syncLastAt')) || null,
      lastResult: g('syncLastResult') ?? null,
      deviceFlow: this.deviceFlow ? { userCode: this.deviceFlow.userCode, verificationUri: this.deviceFlow.verificationUri } : null,
      appInstallUrl: appInstallUrl()
    }
  }

  open(target: 'new-repo' | 'install', repoName?: string): void {
    this.events.openExternal(target === 'install' ? appInstallUrl() : newRepoUrl(repoName?.trim() || DEFAULT_REPO))
  }

  // --- GitHub sign-in (device flow against the GitHub App) ---
  async loginStart(): Promise<SyncStatus> {
    if (GITHUB_CLIENT_ID.includes('REPLACE_ME')) {
      this.setResult('GitHub sign-in is not configured in this build — use the gh CLI option instead')
      this.events.onStatus()
      return this.status()
    }
    if (this.deviceFlow) return this.status() // already pending
    try {
      const flow = await startDeviceFlow()
      this.deviceFlow = flow
      this.deviceCancelled = false
      this.events.openExternal(flow.verificationUri)
      void this.awaitDeviceFlow(flow)
    } catch (e) {
      this.setResult(`GitHub sign-in failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.events.onStatus()
    return this.status()
  }

  private async awaitDeviceFlow(flow: DeviceFlowStart): Promise<void> {
    const tokens = await pollForToken(flow, () => this.deviceCancelled)
    this.deviceFlow = null
    if (tokens) {
      this.memToken = tokens.accessToken
      this.storeSecret('syncGhToken', tokens.accessToken)
      if (tokens.refreshToken) this.storeSecret('syncGhRefresh', tokens.refreshToken)
      const login = await whoami(tokens.accessToken)
      if (login) this.repo.setSetting('syncGhLogin', login, this.now())
      this.setResult(`signed in as @${login ?? 'unknown'}`)
      this.log(`github sign-in ok (${login})`)
    } else if (!this.deviceCancelled) {
      this.setResult('GitHub sign-in was denied or timed out')
    }
    this.events.onStatus()
  }

  loginCancel(): void {
    this.deviceCancelled = true
    this.deviceFlow = null
    this.events.onStatus()
  }

  // --- setup / connect ---
  async setup(opts: SyncSetupOptions): Promise<SyncResult> {
    const probed = await this.probe()
    if (!probed.git) return this.fail('git is not installed — install git to sync')

    let remoteUrl: string
    if (opts.authMode === 'github-app') {
      const token = this.token()
      if (!token) return this.fail('sign in with GitHub first')
      const login = this.repo.getSetting('syncGhLogin') ?? (await whoami(token))
      const spec = opts.repo?.trim() || DEFAULT_REPO
      const [owner, name] = spec.includes('/') ? spec.split('/', 2) : [login, spec]
      if (!owner || !name) return this.fail('could not resolve the repository owner — sign in again')
      const access = await checkRepoAccess(token, owner, name)
      if (access === 'not-found')
        return this.fail(`can't see ${owner}/${name} — create it and grant the app access to it (both buttons above), then connect again`)
      if (access === 'no-push') return this.fail(`the app has read-only access to ${owner}/${name} — it needs Contents: read & write`)
      if (access === 'unauthorized') return this.fail('GitHub session expired — sign in again')
      if (access === 'offline') return this.fail('could not reach github.com — check your connection')
      remoteUrl = `https://github.com/${owner}/${name}.git`
    } else if (opts.authMode === 'gh-cli') {
      if (!probed.gh) return this.fail('gh CLI not found or not logged in — run `gh auth login` first')
      const login = await ghLogin()
      if (login) this.repo.setSetting('syncGhLogin', login, this.now())
      const ensured = await ghEnsureRepo(opts.repo?.trim() || DEFAULT_REPO)
      if (!ensured.url) return this.fail(ensured.error ?? 'could not create the repository via gh')
      remoteUrl = ensured.url
    } else {
      if (!opts.remoteUrl?.trim()) return this.fail('enter a git remote URL')
      remoteUrl = opts.remoteUrl.trim()
    }

    mkdirSync(this.dir, { recursive: true })
    const repoErr = await ensureRepo(this.dir, remoteUrl)
    if (repoErr) return this.fail(repoErr)

    // Peek at the remote before persisting anything: an existing repo dictates
    // the encryption setting; a fresh one takes it from the user's choice.
    const auth = this.gitAuth(opts.authMode)
    const fetched = await fetchMain(this.dir, auth)
    if (fetched === 'offline') return this.fail('could not reach the remote — check your connection')
    let manifest: SyncManifest = { formatVersion: FORMAT_VERSION, encryption: 'none' }
    if (fetched === 'ok') {
      if (!(await resetToRemote(this.dir))) return this.fail('git reset failed')
      try {
        manifest = parseManifest(this.readTreeFiles().get('zede.json'))
      } catch (e) {
        return this.fail(e instanceof Error ? e.message : String(e))
      }
    }

    if (manifest.encryption === 'aes-256-gcm') {
      if (opts.encrypt === false) this.log('repo is encrypted — adopting its setting')
      if (!manifest.kdf) return this.fail('encrypted repo is missing its key parameters — cannot join')
      if (!opts.passphrase) {
        this.persistConfig(opts.authMode, remoteUrl, manifest)
        this.events.onStatus()
        return this.fail('passphrase required — this repo is encrypted; unlock it to finish connecting')
      }
      const key = deriveKey(opts.passphrase, manifest.kdf.salt)
      if (!verifyCheck(key, manifest.kdf.check)) {
        this.persistConfig(opts.authMode, remoteUrl, manifest)
        this.events.onStatus()
        return this.fail('wrong passphrase for this repo')
      }
      this.cacheKey(key)
    } else if (fetched === 'no-remote-branch' && opts.encrypt) {
      if (!opts.passphrase?.trim()) return this.fail('choose a passphrase to enable encryption')
      const salt = newSalt()
      const key = deriveKey(opts.passphrase, salt)
      manifest = { formatVersion: FORMAT_VERSION, encryption: 'aes-256-gcm', kdf: { salt, check: makeCheck(key) } }
      this.cacheKey(key)
    } else if (fetched === 'ok' && opts.encrypt) {
      return this.fail('this repo already syncs unencrypted — to encrypt, disconnect and start a fresh repo')
    }

    this.persistConfig(opts.authMode, remoteUrl, manifest)
    this.events.onStatus()
    return this.syncNow()
  }

  private persistConfig(authMode: string, remoteUrl: string, manifest: SyncManifest): void {
    const now = this.now()
    this.repo.setSetting('syncEnabled', '1', now)
    this.repo.setSetting('syncAuthMode', authMode, now)
    this.repo.setSetting('syncRemoteUrl', remoteUrl, now)
    this.repo.setSetting('syncEncryption', manifest.encryption, now)
    if (manifest.kdf) {
      this.repo.setSetting('syncEncSalt', manifest.kdf.salt, now)
      this.repo.setSetting('syncEncCheck', manifest.kdf.check, now)
    }
  }

  /** Re-enter the passphrase on a machine that joined an encrypted repo. */
  unlock(passphrase: string): SyncStatus {
    const salt = this.repo.getSetting('syncEncSalt')
    const check = this.repo.getSetting('syncEncCheck')
    if (!salt || !check) {
      this.setResult('nothing to unlock')
      return this.status()
    }
    const key = deriveKey(passphrase, salt)
    if (!verifyCheck(key, check)) {
      this.setResult('wrong passphrase')
      this.events.onStatus()
      return this.status()
    }
    this.cacheKey(key)
    this.setResult('unlocked')
    this.events.onStatus()
    void this.syncNow()
    return this.status()
  }

  private cacheKey(key: Buffer): void {
    this.memKey = key
    this.storeSecret('syncKeyCache', key.toString('base64'))
  }

  private resolveKey(): Buffer | null {
    if (this.memKey) return this.memKey
    const b64 = this.readSecret('syncKeyCache')
    if (!b64) return null
    this.memKey = Buffer.from(b64, 'base64')
    return this.memKey
  }

  private cipherFor(manifest: SyncManifest): BodyCipher | undefined {
    if (manifest.encryption !== 'aes-256-gcm') return undefined
    const key = this.resolveKey()
    if (!key) throw new Error('passphrase required — unlock sync in Settings')
    return new SyncCipher(key)
  }

  // --- the sync cycle ---
  async syncNow(): Promise<SyncResult> {
    if (this.repo.getSetting('syncEnabled') !== '1') return this.fail('sync is not set up yet')
    if (this.busy) return this.fail('a sync is already running')
    this.busy = true
    this.events.onStatus()
    try {
      const res = await this.cycle()
      this.repo.setSetting('syncLastAt', String(this.now()), this.now())
      this.setResult(res.error ?? summarize(res))
      return res
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e))
    } finally {
      this.busy = false
      this.events.onStatus()
    }
  }

  private async cycle(): Promise<SyncResult> {
    const authMode = this.repo.getSetting('syncAuthMode') ?? 'git'
    const remoteUrl = this.repo.getSetting('syncRemoteUrl')
    if (!remoteUrl) return this.fail('sync remote is missing — set up sync again')
    mkdirSync(this.dir, { recursive: true })
    const repoErr = await ensureRepo(this.dir, remoteUrl)
    if (repoErr) return this.fail(repoErr)

    let imported: ImportResult | null = null
    let skipped = 0
    let offline = false

    for (let attempt = 1; ; attempt++) {
      const auth = this.gitAuth(authMode)
      const fetched = await fetchMain(this.dir, auth)
      offline = fetched === 'offline'
      if (fetched === 'ok') {
        if (!(await resetToRemote(this.dir))) return this.fail('git reset failed')
        const files = this.readTreeFiles()
        const remoteManifest = parseManifest(files.get('zede.json')) // throws on newer format
        this.adoptEncryption(remoteManifest)
        const cipher = this.cipherFor(remoteManifest)
        const parsed = parseTree(files, cipher)
        skipped = parsed.skipped
        const res = importTree(this.repo, parsed.tree, this.now())
        imported = imported ? addResults(imported, res) : res
        if (hasChanges(res)) this.events.onImported(res)
      }

      const manifest = this.localManifest()
      const cipher = this.cipherFor(manifest)
      const exportedChanges = this.writeTreeFiles(exportTree(this.repo, manifest, cipher))
      const commit = await commitAll(this.dir, `sync ${hostname()} ${new Date(this.now()).toISOString()}`)
      if (commit.error) return this.fail(`git commit failed: ${commit.error}`)
      this.log(`cycle: imported=${imported ? summarizeImport(imported) : 'none'} exported=${exportedChanges} commit=${commit.committed}`)

      if (offline) return this.result(imported, skipped, false, true)
      const pushed = await push(this.dir, this.gitAuth(authMode))
      if (pushed === 'ok') return this.result(imported, skipped, commit.committed, false)
      if (pushed === 'offline') return this.result(imported, skipped, false, true)
      if (pushed === 'auth') {
        if (authMode === 'github-app' && attempt < 3 && (await this.tryRefreshToken())) continue
        return this.fail('GitHub authentication failed — sign in again in Settings → Sync')
      }
      // rejected: another machine pushed between our fetch and push — pull + remerge
      if (attempt >= 3) return this.fail('another machine is syncing right now — try again in a moment')
    }
  }

  /** A repo that says "encrypted" always wins over stale local config — never
   *  export plaintext over an encrypted repo. */
  private adoptEncryption(remote: SyncManifest): void {
    if (remote.encryption === 'aes-256-gcm' && this.repo.getSetting('syncEncryption') !== 'aes-256-gcm' && remote.kdf) {
      const now = this.now()
      this.repo.setSetting('syncEncryption', 'aes-256-gcm', now)
      this.repo.setSetting('syncEncSalt', remote.kdf.salt, now)
      this.repo.setSetting('syncEncCheck', remote.kdf.check, now)
    }
  }

  private localManifest(): SyncManifest {
    const enc = this.repo.getSetting('syncEncryption') === 'aes-256-gcm'
    const salt = this.repo.getSetting('syncEncSalt')
    const check = this.repo.getSetting('syncEncCheck')
    return enc && salt && check
      ? { formatVersion: FORMAT_VERSION, encryption: 'aes-256-gcm', kdf: { salt, check } }
      : { formatVersion: FORMAT_VERSION, encryption: 'none' }
  }

  // --- auth plumbing ---
  private token(): string | null {
    return this.memToken ?? (this.memToken = this.readSecret('syncGhToken'))
  }

  private gitAuth(authMode: string): GitAuth {
    if (authMode === 'github-app') {
      const token = this.token()
      if (!token) throw new Error('sign in with GitHub first')
      return { mode: 'github-app', token }
    }
    return authMode === 'gh-cli' ? { mode: 'gh-cli' } : { mode: 'git' }
  }

  private async tryRefreshToken(): Promise<boolean> {
    const refresh = this.readSecret('syncGhRefresh')
    if (!refresh) return false
    const tokens = await refreshToken(refresh)
    if (!tokens) return false
    this.memToken = tokens.accessToken
    this.storeSecret('syncGhToken', tokens.accessToken)
    if (tokens.refreshToken) this.storeSecret('syncGhRefresh', tokens.refreshToken)
    return true
  }

  // --- working-copy IO (managed paths only; .git and foreign files untouched) ---
  private readTreeFiles(): Map<string, string> {
    const files = new Map<string, string>()
    const grab = (rel: string): void => {
      try {
        const full = join(this.dir, rel)
        if (statSync(full).isFile()) files.set(rel, readFileSync(full, 'utf8'))
      } catch {
        /* missing/unreadable — treated as absent, never fatal */
      }
    }
    for (const s of SINGLES) grab(s)
    for (const d of DIRS) {
      let entries: string[] = []
      try {
        entries = readdirSync(join(this.dir, d))
      } catch {
        continue
      }
      for (const f of entries.sort()) grab(`${d}/${f}`)
    }
    return files
  }

  /** Write changed files, delete stale managed files. Returns changed count. */
  private writeTreeFiles(tree: Map<string, string>): number {
    let changed = 0
    for (const [rel, content] of tree) {
      const full = join(this.dir, rel)
      let existing: string | null = null
      try {
        existing = readFileSync(full, 'utf8')
      } catch {
        /* new file */
      }
      if (existing === content) continue
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
      changed++
    }
    for (const d of DIRS) {
      let entries: string[] = []
      try {
        entries = readdirSync(join(this.dir, d))
      } catch {
        continue
      }
      for (const f of entries) {
        const rel = `${d}/${f}`
        if (!tree.has(rel)) {
          try {
            unlinkSync(join(this.dir, rel))
            changed++
          } catch {
            /* already gone */
          }
        }
      }
    }
    return changed
  }

  // --- disconnect / dispose ---
  disconnect(deleteFiles = false): void {
    this.loginCancel()
    const now = this.now()
    for (const k of ['syncEnabled', 'syncAuthMode', 'syncRemoteUrl', 'syncGhToken', 'syncGhRefresh', 'syncGhLogin', 'syncEncryption', 'syncEncSalt', 'syncEncCheck', 'syncKeyCache', 'syncLastAt', 'syncLastResult']) {
      this.repo.setSetting(k, '', now)
    }
    this.memKey = null
    this.memToken = null
    if (deleteFiles && existsSync(this.dir)) {
      try {
        rmSync(this.dir, { recursive: true, force: true })
      } catch (e) {
        this.log(`could not remove sync dir: ${e}`)
      }
    }
    this.events.onStatus()
  }

  dispose(): void {
    this.deviceCancelled = true
  }

  // --- result helpers ---
  private setResult(msg: string): void {
    this.repo.setSetting('syncLastResult', msg, this.now())
  }

  private fail(error: string): SyncResult {
    this.setResult(error)
    this.log(`error: ${error}`)
    this.events.onStatus()
    return { ok: false, error, pushed: false, memoriesAdded: 0, memoriesUpdated: 0, tombstonesApplied: 0, spacesChanged: 0, settingsChanged: 0, skippedFiles: 0 }
  }

  private result(imported: ImportResult | null, skippedFiles: number, pushed: boolean, offline: boolean): SyncResult {
    return {
      ok: true,
      offline: offline || undefined,
      pushed,
      memoriesAdded: imported?.memoriesAdded ?? 0,
      memoriesUpdated: imported?.memoriesUpdated ?? 0,
      tombstonesApplied: imported?.tombstonesApplied ?? 0,
      spacesChanged: imported?.spacesChanged ?? 0,
      settingsChanged: imported?.settingsChanged ?? 0,
      skippedFiles
    }
  }
}

const hasChanges = (r: ImportResult): boolean =>
  r.memoriesAdded + r.memoriesUpdated + r.tombstonesApplied + r.spacesChanged + r.linksAdded + r.membershipsAdded + r.settingsChanged > 0

const addResults = (a: ImportResult, b: ImportResult): ImportResult => ({
  memoriesAdded: a.memoriesAdded + b.memoriesAdded,
  memoriesUpdated: a.memoriesUpdated + b.memoriesUpdated,
  tombstonesAdded: a.tombstonesAdded + b.tombstonesAdded,
  tombstonesApplied: a.tombstonesApplied + b.tombstonesApplied,
  spacesChanged: a.spacesChanged + b.spacesChanged,
  linksAdded: a.linksAdded + b.linksAdded,
  membershipsAdded: a.membershipsAdded + b.membershipsAdded,
  settingsChanged: a.settingsChanged + b.settingsChanged,
  changedMemoryIds: [...a.changedMemoryIds, ...b.changedMemoryIds]
})

const summarizeImport = (r: ImportResult): string =>
  `+${r.memoriesAdded} ~${r.memoriesUpdated} †${r.tombstonesApplied}`

const summarize = (r: SyncResult): string => {
  const pulled = r.memoriesAdded + r.memoriesUpdated
  const bits = [`pulled ${pulled}`, r.pushed ? 'pushed changes' : 'nothing to push']
  if (r.tombstonesApplied) bits.push(`${r.tombstonesApplied} forgotten`)
  if (r.offline) bits.push('offline — will push next sync')
  if (r.skippedFiles) bits.push(`${r.skippedFiles} files skipped`)
  return bits.join(' · ')
}
