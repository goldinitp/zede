import { spawn as spawnPty, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { TabKind } from '../../shared/api'
import { isUuid, transcriptPathFor } from '../capture/paths'
import { terminalEnvironment } from './env'

interface Session {
  pty: IPty
  sessionId: string
  cwd: string
  transcriptPath: string
  kind: TabKind
  cols: number
  rows: number
  hasInitialResize: boolean
  pendingResize?: { cols: number; rows: number }
}

export interface SpawnConfig {
  tabId: string
  cwd: string
  kind: TabKind
  autoClaude: boolean
  /** Inject this Space's context file at spawn. */
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

/** Environment every Zede PTY gets, inherited by a hand-started `claude` too.
 *
 *  Claude Code is a full-screen TUI: it emits DECSET 1049 at startup and draws
 *  on the terminal's ALTERNATE screen, which by definition has no scrollback.
 *  Nothing it prints ever reaches xterm's normal buffer, so the whole
 *  scrollback story Zede is built on silently collapses — the prompt navigator
 *  scans `term.buffer.active` (the alt buffer while claude runs, ~one screen
 *  tall) and reports "no longer in the terminal scrollback" for every prompt
 *  not currently visible; the pane snapshot captures one screen; and quitting
 *  claude restores the pre-claude screen, erasing the conversation from view.
 *  Opting out puts committed output back in the normal buffer, which is what
 *  the terminal pane, the snapshot/restore path and the jumper all assume. */
/**
 * Owns PTYs keyed by tabId. Output is pushed to the renderer over IPC events.
 * Spawn is idempotent: re-entering a Space re-attaches to the live PTY rather
 * than killing it; sessions persist across Space switches.
 */
export class PtyManager {
  private readonly sessions = new Map<string, Session>()
  private readonly pendingOutput = new Map<string, string[]>()
  private readonly pendingBytes = new Map<string, number>()
  private readonly outputTimers = new Map<string, NodeJS.Timeout>()
  private readonly lastOutputAt = new Map<string, number>()

  constructor(private readonly getSender: () => WebContents | undefined) {}

  /** Send the first chunk after an idle period immediately (zero added typing
   * latency), then coalesce follow-up repaint chunks per tab for up to 8ms.
   * Arrays avoid quadratic string concatenation under a large burst. */
  private queueOutput(tabId: string, data: string): void {
    const now = performance.now()
    const since = now - (this.lastOutputAt.get(tabId) ?? -Infinity)
    if (since >= 8 && !this.outputTimers.has(tabId)) {
      this.getSender()?.send('pty:data', { tabId, chunk: data })
      this.lastOutputAt.set(tabId, now)
      return
    }
    const chunks = this.pendingOutput.get(tabId) ?? []
    chunks.push(data)
    this.pendingOutput.set(tabId, chunks)
    const bytes = (this.pendingBytes.get(tabId) ?? 0) + Buffer.byteLength(data)
    this.pendingBytes.set(tabId, bytes)
    // A blocked renderer must not turn the batching window into an unbounded
    // allocation. A large payload is already worth sending on its own.
    if (bytes >= 256 * 1024) {
      this.flushOutput(tabId)
      return
    }
    if (this.outputTimers.has(tabId)) return
    const wait = Math.max(0, 8 - since)
    this.outputTimers.set(tabId, setTimeout(() => this.flushOutput(tabId), wait))
  }

  private flushOutput(tabId?: string): void {
    if (tabId) {
      const timer = this.outputTimers.get(tabId)
      if (timer) clearTimeout(timer)
      this.outputTimers.delete(tabId)
      const chunks = this.pendingOutput.get(tabId)
      this.pendingOutput.delete(tabId)
      this.pendingBytes.delete(tabId)
      if (chunks?.length) {
        this.getSender()?.send('pty:data', { tabId, chunk: chunks.join('') })
        this.lastOutputAt.set(tabId, performance.now())
      }
      return
    }
    for (const id of [...this.pendingOutput.keys()]) this.flushOutput(id)
  }

  has(tabId: string): boolean {
    return this.sessions.has(tabId)
  }

  /** The live session bound to a tab (undefined once the PTY exits). */
  get(tabId: string): Pick<Session, 'sessionId' | 'cwd' | 'transcriptPath' | 'kind'> | undefined {
    const s = this.sessions.get(tabId)
    return s ? { sessionId: s.sessionId, cwd: s.cwd, transcriptPath: s.transcriptPath, kind: s.kind } : undefined
  }

  /** OS pid of the tab's shell — its live cwd is readable from the OS. */
  pid(tabId: string): number | undefined {
    return this.sessions.get(tabId)?.pty.pid
  }

  /** Foreground process name of the tab's PTY right now (e.g. 'zsh', 'claude',
   *  'vim'). Drives the sidebar's live shell→claude icon swap. undefined once
   *  the PTY exits. Caveat: on Windows ConPTY this reports the spawned shell,
   *  not what's running inside it, so the icon simply stays a shell there. */
  processName(tabId: string): string | undefined {
    return this.sessions.get(tabId)?.pty.process
  }

  liveTabIds(): string[] {
    return [...this.sessions.keys()]
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
      function finish(): void {
        if (quiet) clearTimeout(quiet)
        if (cap) clearTimeout(cap)
        sub?.dispose()
        resolve()
      }
      const cap = setTimeout(finish, timeoutMs)
      const sub = s.pty.onData(() => {
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
    const isWindows = process.platform === 'win32'
    // Windows GUI apps inherit the full user/system PATH from the registry, so
    // `claude` resolves without the login-shell dance macOS needs. Default to
    // Windows PowerShell (5.1 — always present); pwsh/other shells opt in via
    // ZEDE_SHELL. POSIX keeps zsh as the default login shell.
    const shell = isWindows ? process.env.ZEDE_SHELL || 'powershell.exe' : process.env.SHELL || '/bin/zsh'
    // The id is interpolated into a shell command string and a transcript path
    // below, so only a verified UUID may resume; anything else starts fresh.
    const resumeId = cfg.resumeSessionId && isUuid(cfg.resumeSessionId) ? cfg.resumeSessionId : undefined
    const sessionId = resumeId ?? randomUUID()
    const runClaude = kind === 'claude' && autoClaude

    // On POSIX we need an interactive login shell so the user's rc file (PATH
    // incl. ~/.local/bin) is sourced — that's how `claude` resolves when Electron
    // is launched from the GUI with a bare PATH. `-i` is load-bearing, not
    // decoration: zsh only reads .zshrc for INTERACTIVE shells, and a `-l -c`
    // shell is login-but-not-interactive, so it reads only .zshenv/.zprofile/
    // .zlogin — files most users don't have. Without `-i` the command dies as
    // `command not found: claude`. PowerShell auto-sources its profile for an
    // interactive session and inherits PATH, so no equivalent flags are needed.
    //
    // For a claude tab we run claude AS the shell's command rather than typing it
    // into the prompt after a fixed delay. Typing raced shell startup and silently
    // dropped the `--session-id` flag, so the real transcript landed under a
    // claude-assigned id that capture never watched (Memory pane stayed empty).
    // Passing it as the command delivers the flag intact; afterwards we drop to an
    // interactive shell when claude exits so the tab stays usable — `exec <shell>
    // -il` on POSIX, PowerShell's `-NoExit` on Windows.
    // Deterministic session binding plus optional prompt-file injection.
    const flag = runClaude && cfg.appendSystemPromptFile ? ` --append-system-prompt-file ${shellQuote(cfg.appendSystemPromptFile, isWindows)}` : ''
    const idFlag = resumeId ? `--resume ${sessionId}` : `--session-id ${sessionId}`
    const claudeCmd = `claude ${idFlag}${flag}`
    const args = isWindows
      ? runClaude
        ? ['-NoLogo', '-NoExit', '-Command', claudeCmd]
        : ['-NoLogo']
      : runClaude
        ? ['-i', '-l', '-c', `${claudeCmd}; exec ${shell} -il`]
        : ['-l']
    const pty = spawnPty(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: terminalEnvironment()
    })

    pty.onData((data) => {
      const current = this.sessions.get(tabId)
      if (current?.pendingResize && !isShellProcess(current.pty.process)) {
        const pending = current.pendingResize
        current.pendingResize = undefined
        this.applyResize(current, pending.cols, pending.rows)
      }
      this.queueOutput(tabId, data)
    })
    pty.onExit(({ exitCode }) => {
      // Output emitted immediately before exit must reach xterm before the exit
      // overlay is shown.
      this.flushOutput(tabId)
      this.sessions.delete(tabId)
      this.lastOutputAt.delete(tabId)
      this.getSender()?.send('pty:exit', { tabId, exitCode })
    })

    const transcriptPath = transcriptPathFor(cwd, sessionId)
    this.sessions.set(tabId, { pty, sessionId, cwd, transcriptPath, kind, cols: 80, rows: 24, hasInitialResize: false })

    return { sessionId, cwd, transcriptPath, fresh: true }
  }

  input(tabId: string, data: string): void {
    this.sessions.get(tabId)?.pty.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const s = this.sessions.get(tabId)
    if (!s) return
    const next = { cols: Math.max(cols, 1), rows: Math.max(rows, 1) }
    if (s.hasInitialResize && s.cols === next.cols && s.rows === next.rows) {
      s.pendingResize = undefined
      return
    }
    // Rich zsh prompts such as Powerlevel10k may append a fresh prompt on every
    // SIGWINCH. Keep idle shell tabs visually clean; apply the pending size as
    // soon as a foreground program starts producing output.
    if (s.kind === 'shell' && s.hasInitialResize && isShellProcess(s.pty.process)) {
      s.pendingResize = next
      return
    }
    s.pendingResize = undefined
    this.applyResize(s, next.cols, next.rows)
  }

  flushPendingResize(tabId: string): void {
    const s = this.sessions.get(tabId)
    if (!s?.pendingResize) return
    const pending = s.pendingResize
    s.pendingResize = undefined
    this.applyResize(s, pending.cols, pending.rows)
  }

  private applyResize(s: Session, cols: number, rows: number): void {
    try {
      s.pty.resize(cols, rows)
      s.cols = cols
      s.rows = rows
      s.hasInitialResize = true
    } catch {
      /* resize can throw if the pty already exited */
    }
  }

  kill(tabId: string): void {
    this.flushOutput(tabId)
    this.sessions.get(tabId)?.pty.kill()
    this.sessions.delete(tabId)
    this.lastOutputAt.delete(tabId)
  }

  killAll(): void {
    for (const { pty } of this.sessions.values()) pty.kill()
    this.sessions.clear()
    for (const timer of this.outputTimers.values()) clearTimeout(timer)
    this.outputTimers.clear()
    this.pendingOutput.clear()
    this.pendingBytes.clear()
    this.lastOutputAt.clear()
  }
}

function shellQuote(p: string, isWindows = false): string {
  // Both wrap in single quotes; the escape for an embedded quote differs.
  // PowerShell: double the single quote (''). POSIX: close-escape-reopen ('\'').
  return isWindows ? `'${p.replace(/'/g, `''`)}'` : `'${p.replace(/'/g, `'\\''`)}'`
}

const SHELL_PROCESS_RE = /^-?(zsh|bash|fish|sh|dash|tcsh|nu|pwsh|powershell|cmd)(\.exe)?$/i

function isShellProcess(process: string): boolean {
  return SHELL_PROCESS_RE.test(process.split(/[\\/]/).pop() ?? '')
}
