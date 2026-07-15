import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { Settings } from '@shared/api'
import { getTheme } from '@shared/themes'
import '@xterm/xterm/css/xterm.css'

/** Turn appearance settings into xterm options (theme palette + alpha bg). */
function xtermOptions(a: Settings): {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  scrollback: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  theme: Record<string, string>
} {
  const t = getTheme(a.theme)
  const bgAlpha = a.bgOpacity < 1
  const bg = bgAlpha
    ? `rgba(${[1, 3, 5].map((i) => parseInt(t.term.background.slice(i, i + 2), 16)).join(',')},${a.bgOpacity})`
    : t.term.background
  return {
    fontFamily: a.fontFamily,
    fontSize: a.fontSize,
    // xterm treats lineHeight/letterSpacing as 1/0 when undefined; clamp to sane
    // floors so a stale/blank stored value can't collapse the grid.
    lineHeight: a.lineHeight > 0 ? a.lineHeight : 1,
    letterSpacing: Number.isFinite(a.letterSpacing) ? a.letterSpacing : 0,
    scrollback: a.scrollback >= 0 ? a.scrollback : 1000,
    cursorStyle: a.cursorStyle,
    cursorBlink: a.cursorBlink,
    theme: { ...t.term, background: bg }
  }
}

function serialize(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  const start = Math.max(0, buf.length - 600) // cap restored scrollback
  for (let i = start; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\r\n')
}

/**
 * A single xterm.js pane bound to a Core-managed PTY over IPC. Persists across
 * Space switches: on unmount it snapshots scrollback and leaves the PTY alive
 * (Core kills it only on explicit close/quit — spec §8).
 *
 * When the PTY exits the pane enters a "dead session" state: the cursor is left
 * hollow and un-blinking (xterm draws an outline cursor once blurred) and an
 * inline "Restart session" affordance is shown — clicking it, or pressing any
 * key, respawns the PTY in the same tab.
 */
export function TerminalPane({
  tabId,
  active,
  appearance,
  onDims
}: {
  tabId: string
  active: boolean
  appearance: Settings | null
  /** Report the live grid size (used for the window title) when this pane is active. */
  onDims?: (tabId: string, cols: number, rows: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [exited, setExited] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)

  // Keep the latest props reachable from the mount-scoped effect / listeners
  // without re-running them (which would tear down and respawn the PTY).
  const appearanceRef = useRef(appearance)
  appearanceRef.current = appearance
  const onDimsRef = useRef(onDims)
  onDimsRef.current = onDims
  const activeRef = useRef(active)
  activeRef.current = active

  const reportDims = useCallback(() => {
    const t = termRef.current
    if (t && activeRef.current) onDimsRef.current?.(tabId, t.cols, t.rows)
  }, [tabId])

  // Respawn the PTY in place after it exited: clear the dead state, restore the
  // configured cursor, and refocus so typing lands in the fresh shell.
  const restart = useCallback(() => {
    const term = termRef.current
    if (!term) return
    setExited(false)
    setExitCode(null)
    term.reset() // clear the dead screen so the fresh session paints on a blank slate
    term.options.cursorBlink = appearanceRef.current?.cursorBlink ?? true
    window.zede.pty.spawn({ tabId }).catch(() => {})
    window.zede.pty.resize(tabId, term.cols, term.rows)
    term.focus()
  }, [tabId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const opts = appearanceRef.current
      ? xtermOptions(appearanceRef.current)
      : { fontFamily: 'Menlo, monospace', fontSize: 13, lineHeight: 1, letterSpacing: 0, scrollback: 1000, cursorStyle: 'block' as const, cursorBlink: true, theme: { background: '#1e2228', foreground: '#abb2bf', cursor: '#61afef' } }
    const term = new Terminal({ allowTransparency: true, ...opts })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    reportDims()

    const offData = window.zede.pty.onData((e) => {
      if (e.tabId === tabId) term.write(e.chunk)
    })
    const offExit = window.zede.pty.onExit((e) => {
      if (e.tabId !== tabId) return
      // Don't print the exit notice into the buffer — serialize() would capture it
      // into the snapshot and it would pile up on every restore. Surface it in the
      // React overlay instead. Hollow, still cursor: stop blinking + blur so xterm
      // draws the outline.
      setExitCode(e.exitCode)
      term.options.cursorBlink = false
      term.blur()
      setExited(true)
    })
    term.onData((d) => window.zede.pty.input(tabId, d))

    // Re-attach to the PTY. Only bridge with the saved scrollback when spawn
    // re-attached to a still-live PTY (a Space switch within one run) — there the
    // snapshot is a faithful, same-width copy. A fresh PTY (the first mount after
    // an app restart) repaints itself, so replaying a stale, differently sized
    // full-screen snapshot would only render a distorted, misaligned ghost of a
    // dead session. Also: no "— session restored —" marker is written, so nothing
    // the app injects can accumulate in a future snapshot.
    const snapshot = window.zede.pty.getSnapshot(tabId)
    window.zede.pty
      .spawn({ tabId })
      .then(async ({ fresh }) => {
        if (disposed) return
        if (!fresh) {
          const snap = await snapshot
          if (!disposed && snap?.scrollback) term.write(snap.scrollback)
        }
        window.zede.pty.resize(tabId, term.cols, term.rows)
      })
      .catch(() => {})

    const ro = new ResizeObserver(() => {
      if (!host.offsetParent) return // hidden — skip (fit would measure 0)
      fit.fit()
      window.zede.pty.resize(tabId, term.cols, term.rows)
      reportDims()
    })
    ro.observe(host)

    return () => {
      disposed = true
      offData()
      offExit()
      ro.disconnect()
      // Snapshot for visual restore; do NOT kill — the PTY persists across switches.
      window.zede.pty.snapshot(tabId, { scrollback: serialize(term), cols: term.cols, rows: term.rows })
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [tabId, reportDims])

  // Live-apply appearance changes to the existing terminal (no respawn).
  useEffect(() => {
    const term = termRef.current
    if (!term || !appearance) return
    const o = xtermOptions(appearance)
    term.options.fontFamily = o.fontFamily
    term.options.fontSize = o.fontSize
    term.options.lineHeight = o.lineHeight
    term.options.letterSpacing = o.letterSpacing
    term.options.scrollback = o.scrollback
    term.options.cursorStyle = o.cursorStyle
    // A dead session keeps its blink off until it's restarted.
    term.options.cursorBlink = exited ? false : o.cursorBlink
    term.options.theme = o.theme
    fitRef.current?.fit()
    if (active) {
      window.zede.pty.resize(tabId, term.cols, term.rows)
      reportDims()
    }
  }, [appearance, active, tabId, exited, reportDims])

  // Refit when this pane becomes visible (display:none measures as 0).
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      fitRef.current?.fit()
      const t = termRef.current
      if (t) {
        window.zede.pty.resize(tabId, t.cols, t.rows)
        reportDims()
        if (!exited) t.focus()
      }
    })
    return () => cancelAnimationFrame(id)
  }, [active, tabId, exited, reportDims])

  // Any keypress on a dead, focused session respawns it (matches the pill).
  useEffect(() => {
    if (!active || !exited) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return // leave app shortcuts alone
      // Don't hijack typing in another field (e.g. the Context filter).
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      restart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, exited, restart])

  return (
    <div className="terminal-pane" style={{ display: active ? 'block' : 'none' }}>
      <div ref={hostRef} className="terminal-host" />
      {exited && (
        <div className="term-exited">
          <button className="term-restart" onClick={restart}>
            ↵ Restart session
          </button>
          <span className="term-exited-hint">
            {exitCode !== null ? `process exited (${exitCode}) · ` : ''}or press any key
          </span>
        </div>
      )}
    </div>
  )
}
