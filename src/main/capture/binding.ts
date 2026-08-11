import type { Tab } from '../../shared/api'

/** Executable-name tests shared by the binding arbiter and Core's foreground
 *  polling. TabBar.tsx keeps renderer-side copies (separate tsconfig) — keep
 *  the patterns in sync. */
export const CLAUDE_PROC_RE = /^claude(\.exe)?$/i
export const SHELL_PROC_RE = /^-?(zsh|bash|fish|sh|dash|tcsh|nu|pwsh|powershell|cmd)(\.exe)?$/i

/** Basename of a foreground-proc value — macOS `ps -o comm=` reports the full
 *  executable path, Linux /proc/…/comm the bare name. */
export function procBase(proc?: string | null): string {
  return proc?.split(/[\\/]/).pop() ?? ''
}

export type BindableTab = Pick<Tab, 'id' | 'kind' | 'cwd'>

/** Read-only snapshot of everything the arbiter may consult. Core adapts its
 *  live state (PTY table, foreground polling, cwd polling); selftest fakes it. */
export interface BindingView {
  tab(tabId: string): BindableTab | undefined
  tabsInSpace(spaceId: string): BindableTab[]
  /** Session id of the tab's auto-spawned claude (undefined once the PTY exits
   *  or for tabs whose PTY never spawned this run). */
  liveSessionId(tabId: string): string | undefined
  /** basename of the OS-resolved foreground executable ('' when unknown). */
  foregroundBase(tabId: string): string
  /** True once the tab's auto-spawned claude handed the screen back to a shell. */
  spawnEnded(tabId: string): boolean
  /** The discovered session currently claimed as the tab's on-screen claude. */
  handSession(tabId: string): string | undefined
  /** Live (polled) cwd of the tab's shell, when it differs from the tab row. */
  liveCwd(tabId: string): string | undefined
  /** sessions.tab_id for a session row (null = unbound or unknown). */
  boundTab(sessionId: string): string | null
  /** When claude first appeared in this pane's foreground and still is. */
  claudeSince(tabId: string): number | undefined
  /** Creation time of a transcript file (undefined if it cannot be read). */
  transcriptBornAt(path: string): number | undefined
}

/** How long before a pane's claude was noticed its transcript may already have
 *  been written and still count as "the claude that just started here": the
 *  foreground poll runs every 2s and `ps` itself may lag, while claude writes
 *  its first record almost immediately. Generous on purpose — the gate exists
 *  to reject sessions that have been streaming for minutes, not to time-race
 *  the poll. */
const HAND_START_SLACK_MS = 30_000

export interface BindClaim {
  sessionId: string
  /** The project entry's representative tab, already FK-validated (or null). */
  repTabId: string | null
  cwd: string
  spaceId: string
  transcriptPath: string
}

export interface BindDecision {
  tabId: string | null
  /** Record sessionId as this tab's on-screen hand-started claude. */
  handClaim?: string
  /** Confidently-foreign stale binding: unbind sessionId from this tab. */
  unbindFrom?: string
}

/**
 * Which tab (if any) does a transcript session that just changed on disk run
 * in? Transcripts land in one dir per cwd, so a claude driven from ANOTHER app
 * on the same project writes to the very dir Zede watches — before this
 * arbiter existed every such session was blindly bound to the watching tab,
 * its prompts polluted the sidebar, and jumping to them always missed the
 * buffer (they were never rendered in any pane).
 *
 * A session belongs to a tab only when it is plausibly on that tab's screen —
 * and only tabs whose terminal is currently in this transcript's own project
 * dir are even considered:
 *  1. It IS the tab's auto-spawned (or resumed) claude session.
 *  2. Or the tab's foreground process is claude, that claude can only be a
 *     hand-started one (shell tab, or claude tab whose spawned claude already
 *     exited back to the shell), the pane's hand slot is free, and the session
 *     was first seen writing no earlier than claude appeared there. That last
 *     test is what separates "the claude the user just started in this pane"
 *     from "a claude that has been streaming elsewhere all along" — without it
 *     whichever transcript happened to write first won the pane.
 * Everything else stays unbound: captured for memory, invisible to the
 * prompts sidebar.
 *
 * Accepting always carries the session away from any tab that still holds it
 * (`unbindFrom`), because bindSession only claims rows whose tab_id is NULL.
 *
 * Self-heal: when the session is refused but currently bound to a tab whose
 * screen is provably owned by something else (its spawned claude, an
 * identified hand session, or a plain shell), the stale binding is dropped. A
 * dead PTY or a non-shell foreground (claude often parks the screen on
 * editors/pagers) is NOT proof; those bindings are left alone. Bindings that
 * outlive a restart are cleared wholesale by Core.pruneStaleSessionBindings.
 */
export function decideSessionTab(v: BindingView, p: BindClaim): BindDecision {
  // Every candidate must be a tab whose terminal is actually sitting in this
  // transcript's project dir — including the representative tab, which is only
  // a hint from the watcher and goes stale the moment its shell `cd`s away.
  const isTerminal = (t: BindableTab): boolean => t.kind === 'claude' || t.kind === 'shell'
  const atCwd = (t: BindableTab): boolean => t.cwd === p.cwd || v.liveCwd(t.id) === p.cwd
  const rep = p.repTabId ? v.tab(p.repTabId) : undefined
  // The rep tab goes first (the watcher's own hint), then any other terminal
  // tab parked in the same dir — a project can legitimately be open in several.
  const repId = rep && isTerminal(rep) && atCwd(rep) ? rep.id : undefined
  const candidates: BindableTab[] = repId && rep ? [rep] : []
  for (const t of v.tabsInSpace(p.spaceId)) {
    if (t.id === repId || !isTerminal(t)) continue
    if (atCwd(t)) candidates.push(t)
  }

  /** Accepting a session that some OTHER tab still holds has to take it away
   *  first: bindSession only claims rows whose tab_id is NULL, so without this
   *  the bind is a silent no-op and the session keeps listing under the tab it
   *  was wrongly attached to (while occupying this pane's hand slot). */
  const accept = (tabId: string, handClaim?: string): BindDecision => {
    const held = v.boundTab(p.sessionId)
    return { tabId, handClaim, ...(held && held !== tabId ? { unbindFrom: held } : {}) }
  }

  for (const t of candidates) if (v.liveSessionId(t.id) === p.sessionId) return accept(t.id)

  for (const t of candidates) {
    if (v.liveSessionId(t.id) === undefined) continue // no PTY — nothing on screen to own it
    if (!CLAUDE_PROC_RE.test(v.foregroundBase(t.id))) continue // pane isn't showing a claude right now
    if (t.kind === 'claude' && !v.spawnEnded(t.id)) continue // its claude IS the spawned session (≠ this one)
    const hand = v.handSession(t.id)
    if (hand === p.sessionId) return accept(t.id)
    if (hand !== undefined) continue // pane's hand-started claude is already identified
    // The pane shows an unidentified claude. Only a session that STARTED
    // around when claude appeared here can be it: one whose transcript already
    // existed belongs to whatever has been running it all along (typically
    // another app on the same project), and letting it take the free slot
    // would list its prompts here AND lock the user's real session out.
    // Judged by the transcript's creation time, not by when this run first
    // happened to notice it — a foreign session that merely paused between
    // turns must not read as brand new.
    const since = v.claudeSince(t.id)
    const born = v.transcriptBornAt(p.transcriptPath)
    if (since !== undefined && born !== undefined && born < since - HAND_START_SLACK_MS) continue
    return accept(t.id, t.id)
  }

  const boundTabId = v.boundTab(p.sessionId)
  if (boundTabId) {
    const t = v.tab(boundTabId)
    const liveId = t && v.liveSessionId(t.id)
    if (t && liveId !== undefined) {
      const hand = v.handSession(t.id)
      // Positive evidence only: some OTHER session demonstrably owns that
      // pane. "A shell is in the foreground" is NOT evidence — the user
      // quitting claude leaves the whole conversation sitting in the
      // scrollback, and unbinding there used to throw the tab's conversation
      // away (no more "save conversation", no resume) the moment they exited.
      const spawnedOwns = t.kind === 'claude' && !v.spawnEnded(t.id) && liveId !== p.sessionId
      const handOwns = hand !== undefined && hand !== p.sessionId
      if (spawnedOwns || handOwns) return { tabId: null, unbindFrom: t.id }
    }
  }
  return { tabId: null }
}
