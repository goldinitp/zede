import { useEffect, useState } from 'react'
import type { SyncResult, SyncStatus } from '@shared/api'

// Settings → Sync: user-owned, git-backed sync of memories/Spaces/settings.
// Primary path is the in-app GitHub sign-in (device flow against a GitHub App
// installed on ONLY the selected repo); gh CLI is the fallback; any git remote
// is the advanced escape hatch.

const WHAT_SYNCS = 'Syncs: memories, forget decisions, Spaces, preferences. Never syncs: sessions, terminal scrollback, transcripts, local paths, or keys.'

export function SyncSection() {
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [repo, setRepo] = useState('zede-sync')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [encrypt, setEncrypt] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.zede.sync.status().then(setSt)
    return window.zede.sync.onStatus(setSt)
  }, [])

  if (!st) return null

  const finish = (r: SyncResult): void => {
    setWorking(false)
    setError(r.ok ? null : (r.error ?? 'sync failed'))
  }
  const connect = (authMode: 'github-app' | 'gh-cli' | 'git'): void => {
    setWorking(true)
    setError(null)
    window.zede.sync
      .setup({ authMode, repo, remoteUrl, encrypt, passphrase: passphrase || undefined })
      .then(finish, (e) => finish({ ok: false, error: String(e) } as SyncResult))
  }

  const encryptionChoice = (
    <>
      <label className="toggle">
        <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
        <span>
          Encrypt memory contents <em>(passphrase; repo won’t be human-readable on GitHub)</em>
        </span>
      </label>
      {encrypt && (
        <label className="field">
          <span>Passphrase — you’ll enter it once on each machine</span>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="passphrase" />
        </label>
      )}
    </>
  )

  // --- configured view ---
  if (st.configured) {
    const identity =
      st.authMode === 'github-app'
        ? `Signed in as @${st.ghLogin ?? '?'}`
        : st.authMode === 'gh-cli'
          ? `Using your gh CLI login${st.ghLogin ? ` (@${st.ghLogin})` : ''}`
          : 'Using your system git credentials'
    return (
      <>
        <div className="egress">
          🔒 {identity} · {st.remoteUrl}
          {st.encryption ? ' · encrypted' : ''}
        </div>
        {st.needsPassphrase ? (
          <>
            <label className="field">
              <span>This repo is encrypted — enter its passphrase to sync on this machine</span>
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="passphrase" />
            </label>
            <div className="row">
              <button onClick={() => window.zede.sync.unlock(passphrase)}>Unlock &amp; sync</button>
            </div>
          </>
        ) : (
          <div className="row">
            <button disabled={st.busy || working} onClick={() => void window.zede.sync.now()}>
              {st.busy ? 'Syncing…' : 'Sync now'}
            </button>
            <button onClick={() => void window.zede.sync.disconnect(false)}>Disconnect</button>
          </div>
        )}
        <div className="saved">
          {st.lastSyncAt ? `Last synced ${new Date(st.lastSyncAt).toLocaleTimeString()}` : 'Not synced yet'}
          {st.lastResult ? ` · ${st.lastResult}` : ''}
        </div>
        <div className="egress">{WHAT_SYNCS}</div>
      </>
    )
  }

  // --- pending device flow ---
  if (st.deviceFlow) {
    return (
      <>
        <div className="modal-section">
          <span>
            Enter this code at <strong>{st.deviceFlow.verificationUri}</strong> (opened in your browser):
          </span>
          <div className="row">
            <strong style={{ fontSize: '1.4em', letterSpacing: '0.15em' }}>{st.deviceFlow.userCode}</strong>
            <button onClick={() => void window.zede.sync.loginCancel()}>Cancel</button>
          </div>
        </div>
        <div className="egress">Waiting for you to approve in the browser…</div>
      </>
    )
  }

  // --- signed in, choosing the repo ---
  if (st.ghLogin) {
    return (
      <>
        <div className="egress">✓ Signed in as @{st.ghLogin} — now pick the one repo Zede may touch.</div>
        <label className="field">
          <span>Private repository (created if needed)</span>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="zede-sync" />
        </label>
        <div className="row">
          <button onClick={() => void window.zede.sync.open('new-repo', repo)}>1 · Create repo on GitHub</button>
          <button onClick={() => void window.zede.sync.open('install')}>2 · Grant access to it</button>
        </div>
        {encryptionChoice}
        <div className="row">
          <button disabled={working} onClick={() => connect('github-app')}>
            {working ? 'Connecting…' : '3 · Connect & sync'}
          </button>
        </div>
        {error && <div className="saved">⚠ {error}</div>}
        <div className="egress">
          The GitHub App gets “Contents: read &amp; write” on only the repository you select in step 2 — it cannot see any other
          repo.
        </div>
      </>
    )
  }

  // --- unconfigured ---
  return (
    <>
      <div className="egress">
        🛰 Sync pushes to a private GitHub repo <strong>you own</strong> — Zede talks only to github.com, and your sign-in token
        is stored encrypted in the OS keychain. {WHAT_SYNCS}
      </div>
      {!st.gitAvailable && <div className="saved">⚠ git is not installed — install git to enable sync.</div>}
      <div className="row">
        <button disabled={!st.gitAvailable || working} onClick={() => window.zede.sync.loginStart().then(setSt)}>
          Sign in with GitHub
        </button>
        {st.ghAvailable && (
          <button disabled={!st.gitAvailable || working} onClick={() => connect('gh-cli')}>
            {working ? 'Connecting…' : 'Use gh CLI login instead'}
          </button>
        )}
      </div>
      {encryptionChoice}
      <label className="toggle">
        <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
        <span>
          Advanced: use any git remote <em>(GitLab, a NAS over ssh — your system git credentials)</em>
        </span>
      </label>
      {advanced && (
        <>
          <label className="field">
            <span>Git remote URL</span>
            <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="git@host:me/zede-sync.git" />
          </label>
          <div className="row">
            <button disabled={!st.gitAvailable || working || !remoteUrl.trim()} onClick={() => connect('git')}>
              {working ? 'Connecting…' : 'Connect & sync'}
            </button>
          </div>
        </>
      )}
      {(error ?? st.lastResult) && <div className="saved">⚠ {error ?? st.lastResult}</div>}
    </>
  )
}
