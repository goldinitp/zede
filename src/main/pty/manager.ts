import { spawn as spawnPty, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { TabKind } from '../../shared/api'
import { isUuid, transcriptPathFor } from '../capture/paths'

interface Session {
  pty: IPty
  sessionId: string
  cwd: string
  transcriptPath: string
  kind: TabKind
}

export interface SpawnConfig {
  tabId: string
  cwd: string
  kind: TabKind
  autoClaude: boolean
  /** Adapter B (spec §6.5): inject this Space's context file at the spawn. */
  appendSystemPromptFile?: string
  /** Resume this Claude session (`claude --resume`) instead of starting a fresh one. */
  resumeSessionId?: string
}

export interface SpawnResult {
  sessionId: string
  cwd: string
  transcriptPath: string
  fresh: boolean
}

/**
 * Owns PTYs keyed by tabId. Output is pushed to the renderer over IPC events.
 * Spawn is idempotent: re-entering a Space re-attaches to the live PTY rather
 * than killing it (spec §8 — sessions persist across Space switches).
 */
export class PtyManager {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly getSender: () => WebContents | undefined) {}

  has(tabId: string): boolean {
    return this.sessions.has(tabId)
  }

  /** The live session bound to a tab (undefined once the PTY exits). */
  get(tabId: string): Omit<Session, 'pty'> | undefined {
    const s = this.sessions.get(tabId)
    return s ? { sessionId: s.sessionId, cwd: s.cwd, transcriptPath: s.transcriptPath, kind: s.kind } : undefined
  }

  /** Resolves once the PTY has produced output and then gone quiet for
   *  `quietMs` (or after `timeoutMs`, whichever comes first). Used to defer
   *  typed-in commands like `/compact` until a resumed claude has finished
   *  rendering — there is no readiness signal, so quiescence is the proxy. */
  whenQuiet(tabId: string, quietMs = 2000, timeoutMs = 30_000): Promise<void> {
    const s = this.sessions.get(tabId)
    if (!s) return Promise.resolve()
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined
      let cap: ReturnType<typeof setTimeout> | undefined
      let sub: { dispose(): void } | undefined
      function finish(): void {
        if (quiet) clearTimeout(quiet)
        if (cap) clearTimeout(cap)
        sub?.dispose()
        resolve()
      }
      cap = setTimeout(finish, timeoutMs)
      sub = s.pty.onData(() => {
        // The quiet countdown only starts after the first chunk, so slow shell
        // startup (silence before claude even launches) can't fire it early.
        if (quiet) clearTimeout(quiet)
        quiet = setTimeout(finish, quietMs)
      })
    })
  }

  spawn(cfg: SpawnConfig): SpawnResult {
    const existing = this.sessions.get(cfg.tabId)
    if (existing) {
      return { sessionId: existing.sessionId, cwd: existing.cwd, transcriptPath: existing.transcriptPath, fresh: false }
    }

    const { tabId, cwd, kind, autoClaude } = cfg
    const shell = process.env.SHELL || '/bin/zsh'
    // The id is interpolated into a `zsh -c` string and a transcript path below,
    // so only a verified UUID may resume; anything else starts a fresh session.
    const resumeId = cfg.resumeSessionId && isUuid(cfg.resumeSessionId) ? cfg.resumeSessionId : undefined
    const sessionId = resumeId ?? randomUUID()
    const runClaude = kind === 'claude' && autoClaude

    // Interactive login shell so the user's rc file (PATH incl. ~/.local/bin) is
    // sourced — that's how `claude` resolves when Electron is launched from the
    // GUI with a bare PATH. `-i` is load-bearing, not decoration: zsh only reads
    // .zshrc for INTERACTIVE shells, and a `-l -c` shell is login-but-not-
    // interactive, so it reads only .zshenv/.zprofile/.zlogin — files most users
    // don't have. Without `-i` the command dies as `command not found: claude`.
    //
    // For a claude tab we run claude AS the shell's command rather than typing it
    // into the prompt after a fixed delay. Typing raced shell startup and silently
    // dropped the `--session-id` flag, so the real transcript landed under a
    // claude-assigned id that capture never watched (Memory pane stayed empty).
    // Passing it via `-c` delivers the flag intact; `exec <shell> -il` afterwards
    // drops to an interactive shell when claude exits so the tab stays usable.
    // (spec §6.1 deterministic binding + Adapter B injection.)
    const flag = runClaude && cfg.appendSystemPromptFile ? ` --append-system-prompt-file ${shellQuote(cfg.appendSystemPromptFile)}` : ''
    const idFlag = resumeId ? `--resume ${sessionId}` : `--session-id ${sessionId}`
    const args = runClaude ? ['-i', '-l', '-c', `claude ${idFlag}${flag}; exec ${shell} -il`] : ['-l']
    const pty = spawnPty(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>
    })

    pty.onData((data) => this.getSender()?.send('pty:data', { tabId, chunk: data }))
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(tabId)
      this.getSender()?.send('pty:exit', { tabId, exitCode })
    })

    const transcriptPath = transcriptPathFor(cwd, sessionId)
    this.sessions.set(tabId, { pty, sessionId, cwd, transcriptPath, kind })

    return { sessionId, cwd, transcriptPath, fresh: true }
  }

  input(tabId: string, data: string): void {
    this.sessions.get(tabId)?.pty.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const s = this.sessions.get(tabId)
    if (!s) return
    try {
      s.pty.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
      /* resize can throw if the pty already exited */
    }
  }

  kill(tabId: string): void {
    this.sessions.get(tabId)?.pty.kill()
    this.sessions.delete(tabId)
  }

  killAll(): void {
    for (const { pty } of this.sessions.values()) pty.kill()
    this.sessions.clear()
  }
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}
