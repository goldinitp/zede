import { spawn } from 'node:child_process'
import { basename } from 'node:path'

// Thin promisified git/gh runner for sync. Follows the extract/claude.ts spawn
// discipline: spawn can throw SYNCHRONOUSLY under fd pressure (EBADF/EMFILE),
// so every call is guarded and resolves a result instead of ever rejecting.

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const LOCAL_TIMEOUT_MS = 30_000
const NETWORK_TIMEOUT_MS = 120_000

export function run(bin: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        // GIT_TERMINAL_PROMPT=0: a missing credential fails fast instead of
        // wedging the sync on an invisible username prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) })
      return
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? LOCAL_TIMEOUT_MS)
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(killer)
      resolve({ code: -1, stdout, stderr: stderr || String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export type GitAuth =
  | { mode: 'github-app'; token: string }
  | { mode: 'gh-cli' }
  | { mode: 'git' }

/** Credential wiring that never touches disk or argv-visible secrets: the
 *  token rides an env var read by an inline helper; gh mode delegates to gh's
 *  own credential store. The leading empty helper clears any system helper so
 *  a stale keychain credential can't shadow the intended one. */
function authArgs(auth: GitAuth): { args: string[]; env: Record<string, string> } {
  if (auth.mode === 'github-app') {
    return {
      args: [
        '-c', 'credential.helper=',
        '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$ZEDE_SYNC_TOKEN"; }; f'
      ],
      env: { ZEDE_SYNC_TOKEN: auth.token }
    }
  }
  if (auth.mode === 'gh-cli') {
    return { args: ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'], env: {} }
  }
  return { args: [], env: {} }
}

export const git = (dir: string, args: string[], opts: { auth?: GitAuth; timeoutMs?: number } = {}): Promise<RunResult> => {
  const a = opts.auth ? authArgs(opts.auth) : { args: [], env: {} }
  return run('git', ['-C', dir, ...a.args, ...args], { env: a.env, timeoutMs: opts.timeoutMs })
}

export async function gitAvailable(): Promise<boolean> {
  return (await run('git', ['--version'])).code === 0
}

export async function ghAvailable(): Promise<boolean> {
  return (await run('gh', ['auth', 'status'])).code === 0
}

/** Init (idempotent) + point origin at the remote. Identity is passed per-commit
 *  via -c, so nothing is written to the user's git config. */
export async function ensureRepo(dir: string, remoteUrl: string): Promise<string | null> {
  const init = await git(dir, ['init', '-b', 'main'])
  if (init.code !== 0) return `git init failed: ${init.stderr.trim()}`
  const has = await git(dir, ['remote', 'get-url', 'origin'])
  const r = has.code === 0
    ? await git(dir, ['remote', 'set-url', 'origin', remoteUrl])
    : await git(dir, ['remote', 'add', 'origin', remoteUrl])
  return r.code === 0 ? null : `git remote failed: ${r.stderr.trim()}`
}

export async function fetchMain(dir: string, auth: GitAuth): Promise<'ok' | 'no-remote-branch' | 'offline'> {
  const r = await git(dir, ['fetch', 'origin', 'main'], { auth, timeoutMs: NETWORK_TIMEOUT_MS })
  if (r.code === 0) return 'ok'
  // A brand-new remote has no main yet — that's a fine state, not offline.
  if (/couldn't find remote ref/i.test(r.stderr)) return 'no-remote-branch'
  return 'offline'
}

/** Adopt the remote tree exactly. Guarded so a bug can never hard-reset anything
 *  but the dedicated sync working copy (the tree is regenerable from the DB). */
export async function resetToRemote(dir: string): Promise<boolean> {
  if (basename(dir) !== 'sync') throw new Error(`refusing to hard-reset non-sync dir: ${dir}`)
  return (await git(dir, ['reset', '--hard', 'origin/main'])).code === 0
}

/** Stage everything and commit if anything changed. Returns whether a commit was made. */
export async function commitAll(dir: string, message: string): Promise<{ committed: boolean; error?: string }> {
  const add = await git(dir, ['add', '-A'])
  if (add.code !== 0) return { committed: false, error: add.stderr.trim() }
  const clean = (await git(dir, ['diff', '--cached', '--quiet'])).code === 0
  const noHead = (await git(dir, ['rev-parse', '--verify', 'HEAD'])).code !== 0
  if (clean && !noHead) return { committed: false }
  const c = await git(dir, ['-c', 'user.name=Zede Sync', '-c', 'user.email=sync@zede.local', 'commit', '-m', message, '--allow-empty-message'])
  if (c.code !== 0) {
    // Nothing to commit on a fresh repo (empty DB export is never truly empty —
    // zede.json always exists — so this is defensive only).
    if (/nothing to commit/i.test(c.stdout + c.stderr)) return { committed: false }
    return { committed: false, error: c.stderr.trim() }
  }
  return { committed: true }
}

export async function push(dir: string, auth: GitAuth): Promise<'ok' | 'rejected' | 'auth' | 'offline'> {
  const r = await git(dir, ['push', '-u', 'origin', 'main'], { auth, timeoutMs: NETWORK_TIMEOUT_MS })
  if (r.code === 0) return 'ok'
  const err = r.stderr
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(err)) return 'rejected'
  if (/authentication|permission|403|401|could not read Username|invalid credentials/i.test(err)) return 'auth'
  return 'offline'
}

// --- gh CLI helpers (fallback auth path) ---

export async function ghLogin(): Promise<string | null> {
  const r = await run('gh', ['api', 'user', '-q', '.login'], { timeoutMs: NETWORK_TIMEOUT_MS })
  return r.code === 0 ? r.stdout.trim() || null : null
}

/** Ensure `owner/name` exists (create private if missing). Returns clone URL or error. */
export async function ghEnsureRepo(name: string): Promise<{ url?: string; error?: string }> {
  const view = await run('gh', ['repo', 'view', name, '--json', 'url', '-q', '.url'], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (view.code === 0 && view.stdout.trim()) return { url: `${view.stdout.trim()}.git` }
  const create = await run('gh', ['repo', 'create', name, '--private'], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (create.code !== 0) return { error: create.stderr.trim() || 'gh repo create failed' }
  const view2 = await run('gh', ['repo', 'view', name, '--json', 'url', '-q', '.url'], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (view2.code === 0 && view2.stdout.trim()) return { url: `${view2.stdout.trim()}.git` }
  return { error: 'created repo but could not resolve its URL' }
}
