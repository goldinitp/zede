// GitHub sign-in via the Device Flow of a **GitHub App** (deliberately not an
// OAuth App: OAuth's `repo` scope would grant every repo the user owns; a
// GitHub App is installed on SELECTED repositories only, with just
// "Contents: read & write" — the token physically cannot touch anything else).
//
// Owner prerequisite (one-time): register the GitHub App, enable device flow,
// set repository permission Contents=Read&Write, disable user-token expiration
// (refresh-on-401 below is best-effort for apps that leave it on), then paste
// the client id + app slug here. Both values are public by design.

export const GITHUB_CLIENT_ID = 'Iv23liW2gafEarBf6mQK' // TODO(owner): GitHub App client id
export const GITHUB_APP_SLUG = 'zede-dev' // TODO(owner): the app's URL slug

export const appInstallUrl = (): string => `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`
export const newRepoUrl = (name: string): string =>
  `https://github.com/new?name=${encodeURIComponent(name)}&visibility=private&description=${encodeURIComponent('Zede sync — my Claude context, owned by me')}`

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' }

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSec: number
  expiresAt: number
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
}

export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID })
  })
  if (!res.ok) throw new Error(`GitHub device flow failed (${res.status})`)
  const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    intervalSec: d.interval ?? 5,
    expiresAt: Date.now() + (d.expires_in ?? 900) * 1000
  }
}

/** Poll until the user approves the code in their browser. Resolves null when
 *  cancelled (via `cancelled()`), denied, or expired. */
export async function pollForToken(flow: DeviceFlowStart, cancelled: () => boolean): Promise<TokenSet | null> {
  let interval = flow.intervalSec
  while (!cancelled() && Date.now() < flow.expiresAt) {
    await new Promise((r) => setTimeout(r, interval * 1000))
    if (cancelled()) return null
    let res: Response
    try {
      res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: flow.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      })
    } catch {
      continue // transient network blip — keep polling until the code expires
    }
    const d = (await res.json().catch(() => ({}))) as Record<string, string>
    if (d.access_token) return { accessToken: d.access_token, refreshToken: d.refresh_token ?? null }
    if (d.error === 'authorization_pending') continue
    if (d.error === 'slow_down') {
      interval += 5
      continue
    }
    return null // access_denied / expired_token / unsupported — give up cleanly
  }
  return null
}

export async function refreshToken(refresh: string): Promise<TokenSet | null> {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refresh })
    })
    const d = (await res.json().catch(() => ({}))) as Record<string, string>
    return d.access_token ? { accessToken: d.access_token, refreshToken: d.refresh_token ?? null } : null
  } catch {
    return null
  }
}

const api = (token: string, path: string): Promise<Response> =>
  fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  })

export async function whoami(token: string): Promise<string | null> {
  try {
    const res = await api(token, '/user')
    if (!res.ok) return null
    return ((await res.json()) as { login?: string }).login ?? null
  } catch {
    return null
  }
}

export type RepoAccess = 'ok' | 'not-found' | 'no-push' | 'unauthorized' | 'offline'

/** Can this token see AND push to owner/name? 404 covers both "repo doesn't
 *  exist" and "the app isn't installed on it" — GitHub hides uninstalled repos. */
export async function checkRepoAccess(token: string, owner: string, name: string): Promise<RepoAccess> {
  try {
    const res = await api(token, `/repos/${owner}/${name}`)
    if (res.status === 401) return 'unauthorized'
    if (res.status === 404 || res.status === 403) return 'not-found'
    if (!res.ok) return 'offline'
    const d = (await res.json()) as { permissions?: { push?: boolean } }
    return d.permissions?.push ? 'ok' : 'no-push'
  } catch {
    return 'offline'
  }
}
