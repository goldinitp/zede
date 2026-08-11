import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Settings } from '@shared/api'
import { getTheme } from '@shared/themes'
import { promptNeedle, registerPromptJumper } from './jump'
import { subscribePtyData, subscribePtyExit, type PausableSubscription } from './ptyEvents'
import { quoteDroppedPath, registerTerminalClear } from './actions'
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

/** Decorations only accept #RRGGBB (no rgba/alpha). Prefer the theme's
 *  selection color; otherwise dim the cursor accent toward the background so
 *  the flash reads as a highlight, not a solid accent bar. */
function flashColor(theme: { selectionBackground?: string; cursor?: string; background?: string } | undefined): string {
  const hex = /^#[0-9a-fA-F]{6}$/
  if (theme?.selectionBackground && hex.test(theme.selectionBackground)) return theme.selectionBackground
  if (theme?.cursor && hex.test(theme.cursor)) {
    const c = theme.cursor
    const b = theme.background && hex.test(theme.background) ? theme.background : '#1e2228'
    const mix = (i: number): string =>
      Math.round(parseInt(c.slice(i, i + 2), 16) * 0.35 + parseInt(b.slice(i, i + 2), 16) * 0.65)
        .toString(16)
        .padStart(2, '0')
    return `#${mix(1)}${mix(3)}${mix(5)}`
  }
  return '#3a5b7d'
}

function serialize(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  const start = Math.max(0, buf.length - 600) // cap restored scrollback
  for (let i = start; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\r\n')
}

function applyXtermOptions(term: Terminal, appearance: Settings, exited: boolean): void {
  const o = xtermOptions(appearance)
  term.options.allowTransparency = appearance.bgOpacity < 1
  term.options.fontFamily = o.fontFamily
  term.options.fontSize = o.fontSize
  term.options.lineHeight = o.lineHeight
  term.options.letterSpacing = o.letterSpacing
  term.options.scrollback = o.scrollback
  term.options.cursorStyle = o.cursorStyle
  term.options.cursorBlink = exited ? false : o.cursorBlink
  term.options.theme = o.theme
}

/**
 * A single xterm.js pane bound to a Core-managed PTY over IPC. Persists across
 * Space switches: on unmount it snapshots scrollback and leaves the PTY alive
 * (Core kills it only on explicit close or quit).
 *
 * When the PTY exits the pane enters a "dead session" state: the cursor is left
 * hollow and un-blinking (xterm draws an outline cursor once blurred) and an
 * inline "Restart session" affordance is shown — clicking it, or pressing any
 * key, respawns the PTY in the same tab.
 */
export const TerminalPane = memo(function TerminalPane({
  tabId,
  active,
  appearance,
  layoutResizing,
  onDims
}: {
  tabId: string
  active: boolean
  appearance: Settings | null
  layoutResizing: boolean
  /** Report the live grid size (used for the window title) when this pane is active. */
  onDims?: (tabId: string, cols: number, rows: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const webglLossesRef = useRef(0)
  const dataSubscriptionRef = useRef<PausableSubscription | null>(null)
  const exitSubscriptionRef = useRef<PausableSubscription | null>(null)
  const ptyReadyRef = useRef(false)
  const resizePtyRef = useRef<((immediate?: boolean) => void) | null>(null)
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
  const layoutResizingRef = useRef(layoutResizing)
  layoutResizingRef.current = layoutResizing

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
    // Resize only AFTER spawn resolves: pty:resize is fire-and-forget while the
    // spawn handler awaits injection first, so an immediate resize would land
    // before the PTY exists and the fresh session would sit at 80×24 until the
    // grid happens to change again.
    window.zede.pty
      .spawn({ tabId })
      .then(() => window.zede.pty.resize(tabId, term.cols, term.rows))
      .catch(() => {})
    term.focus()
  }, [tabId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const opts = appearanceRef.current
      ? xtermOptions(appearanceRef.current)
      : { fontFamily: 'Menlo, monospace', fontSize: 13, lineHeight: 1, letterSpacing: 0, scrollback: 1000, cursorStyle: 'block' as const, cursorBlink: true, theme: { background: '#1e2228', foreground: '#abb2bf', cursor: '#61afef' } }
    const term = new Terminal({ allowTransparency: (appearanceRef.current?.bgOpacity ?? 1) < 1, ...opts })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    reportDims()

    const offClear = registerTerminalClear(tabId, () => {
      term.clear()
      term.scrollToBottom()
      term.focus()
    })
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent): void => {
      if (!event.dataTransfer?.files.length) return
      event.preventDefault()
      const paths = [...event.dataTransfer.files]
        .map((file) => {
          try {
            return window.zede.ui.getPathForFile(file)
          } catch {
            return ''
          }
        })
        .filter(Boolean)
      if (!paths.length) return
      const isWindows = /Win/.test(navigator.platform)
      term.paste(`${paths.map((path) => quoteDroppedPath(path, isWindows)).join(' ')} `)
      term.focus()
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)

    const dataSubscription = subscribePtyData(tabId, (e) => term.write(e.chunk))
    const exitSubscription = subscribePtyExit(tabId, (e) => {
      // Don't print the exit notice into the buffer — serialize() would capture it
      // into the snapshot and it would pile up on every restore. Surface it in the
      // React overlay instead. Hollow, still cursor: stop blinking + blur so xterm
      // draws the outline.
      setExitCode(e.exitCode)
      term.options.cursorBlink = false
      term.blur()
      setExited(true)
    })
    dataSubscriptionRef.current = dataSubscription
    exitSubscriptionRef.current = exitSubscription
    ptyReadyRef.current = false
    term.onData((d) => window.zede.pty.input(tabId, d))

    // Prompt navigator jump: scan the buffer for the prompt's needle, scroll
    // there and flash-highlight the whole prompt line. The TUI can echo the
    // same text more than once (the input box, an assistant quoting it back),
    // so land on the nth match COUNTING BACK FROM THE NEWEST — the sidebar
    // counts the same way, because the buffer discards its oldest lines first
    // and only the offset from the end survives that. Running out of matches
    // means this echo really has scrolled away: report the miss instead of
    // landing on an unrelated one, which reads as a broken feature.
    let flashTimer: number | undefined
    let flashDispose: (() => void) | undefined
    const clearFlash = (): void => {
      if (flashTimer) window.clearTimeout(flashTimer)
      flashTimer = undefined
      flashDispose?.()
      flashDispose = undefined
    }
    const offJump = registerPromptJumper(tabId, (text, occurrence) => {
      const needle = promptNeedle(text)
      if (!needle) return false
      const buf = term.buffer.active
      const matches: { row: number; col: number }[] = []
      for (let i = 0; i < buf.length; i++) {
        const col = (buf.getLine(i)?.translateToString(true) ?? '').indexOf(needle)
        if (col !== -1) matches.push({ row: i, col })
      }
      if (occurrence >= matches.length) return false
      const m = matches[matches.length - 1 - occurrence]
      term.scrollToLine(Math.max(0, m.row - 1))
      // Flash the full prompt echo — the matched row plus its soft-wrapped
      // continuations — so the eye lands on it. A decoration (like the search
      // addon uses) renders the highlight behind the text in every renderer;
      // markers can't be placed on the alt screen, so it degrades to plain
      // scrolling there.
      clearFlash()
      let span = 1
      while (buf.getLine(m.row + span)?.isWrapped) span++
      const marker = term.registerMarker(m.row - buf.baseY - buf.cursorY)
      if (marker) {
        const deco = term.registerDecoration({
          marker,
          x: 0,
          width: term.cols,
          height: span,
          backgroundColor: flashColor(term.options.theme)
        })
        if (deco) {
          flashDispose = () => {
            deco.dispose()
            marker.dispose()
          }
          flashTimer = window.setTimeout(clearFlash, 1600)
        } else marker.dispose()
      }
      return true
    })

    // Shift+Enter must insert a newline in Claude Code with zero user setup.
    // Terminals send the same CR for Enter and Shift+Enter, so translate
    // Shift+Enter to LF (^J): Claude Code's default chat:newline binding,
    // while shells treat LF identically to Enter — safe in plain shell tabs.
    // Block keypress/keyup too so xterm never emits its own CR for the chord.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        if (ev.type === 'keydown') window.zede.pty.input(tabId, '\n')
        return false
      }
      return true
    })

    let resizeTimer: number | undefined
    const resizePty = (immediate = false): void => {
      if (disposed || !host.offsetParent) return
      const send = (): void => {
        resizeTimer = undefined
        window.zede.pty.resize(tabId, term.cols, term.rows)
      }
      if (immediate) {
        if (resizeTimer) window.clearTimeout(resizeTimer)
        send()
        return
      }
      if (resizeTimer) window.clearTimeout(resizeTimer)
      // Coalesce repeated metric changes (for example a settings slider).
      resizeTimer = window.setTimeout(send, 160)
    }
    resizePtyRef.current = resizePty

    const resumePtyEvents = (): void => {
      if (disposed) return
      ptyReadyRef.current = true
      if (!activeRef.current) return
      // Buffered output must paint before a buffered exit toggles the overlay.
      dataSubscription.resume()
      exitSubscription.resume()
    }

    // Re-attach to the PTY. Only bridge with the saved scrollback when spawn
    // re-attached to a still-live PTY (a Space switch within one run) — there the
    // snapshot is a faithful, same-width copy. A fresh PTY (the first mount after
    // an app restart) repaints itself, so replaying a stale, differently sized
    // full-screen snapshot would only render a distorted, misaligned ghost of a
    // dead session. Also: no "— session restored —" marker is written, so nothing
    // the app injects can accumulate in a future snapshot.
    const snapshot = window.zede.pty.getSnapshot(tabId).catch(() => null)
    window.zede.pty
      .spawn({ tabId })
      .then(async ({ fresh }) => {
        if (disposed) return
        if (!fresh) {
          const snap = await snapshot
          if (disposed) return
          if (snap?.scrollback) {
            term.write(snap.scrollback, () => {
              resumePtyEvents()
              resizePty(true)
            })
            return
          }
        }
        // A hidden pane mounts at xterm's default 80×24 (fit can't measure a
        // display:none host) — pushing that onto a live PTY would SIGWINCH
        // every background claude into a garbled 80-col repaint on each Space
        // switch. The activation refit sends the real grid once visible.
        resumePtyEvents()
        resizePty(true)
      })
      .catch(() => {
        // Show the existing restart affordance instead of leaving a blank,
        // permanently deaf pane after injection or PTY spawn fails.
        resumePtyEvents()
        setExitCode(null)
        term.options.cursorBlink = false
        term.blur()
        setExited(true)
      })

    // Fit xterm once per frame, but send only the final PTY size after a resize
    // burst. Repeated SIGWINCH events make rich shell prompts append redraws.
    let fitRaf = 0
    const ro = new ResizeObserver(() => {
      if (fitRaf) return
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0
        if (!host.offsetParent) return // hidden — skip (fit would measure 0)
        if (layoutResizingRef.current) return
        const { cols, rows } = term
        fit.fit()
        if (term.cols !== cols || term.rows !== rows) {
          reportDims()
          resizePty()
        }
      })
    })
    ro.observe(host)

    return () => {
      disposed = true
      dataSubscription.pause()
      exitSubscription.pause()
      dataSubscription.dispose()
      exitSubscription.dispose()
      offClear()
      offJump()
      clearFlash() // decoration must die before term.dispose()
      if (fitRaf) cancelAnimationFrame(fitRaf)
      if (resizeTimer) window.clearTimeout(resizeTimer)
      ro.disconnect()
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      // Snapshot for visual restore; do NOT kill — the PTY persists across switches.
      window.zede.pty.snapshot(tabId, { scrollback: serialize(term), cols: term.cols, rows: term.rows })
      term.dispose()
      termRef.current = null
      fitRef.current = null
      webglRef.current = null
      dataSubscriptionRef.current = null
      exitSubscriptionRef.current = null
      ptyReadyRef.current = false
      if (resizePtyRef.current === resizePty) resizePtyRef.current = null
    }
  }, [tabId, reportDims])

  // A browser has a small WebGL-context budget. Keeping one context per hidden
  // tab eventually evicts the active terminal onto the much slower DOM renderer.
  // Give the GPU renderer only to the visible pane; xterm keeps hidden buffers
  // current using its fallback renderer.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (!active) {
      webglRef.current?.dispose()
      webglRef.current = null
      return
    }
    let cancelled = false
    let retryTimer: number | undefined
    const attach = (): void => {
      if (cancelled || webglRef.current || webglLossesRef.current >= 3) return
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          if (webglRef.current === webgl) webglRef.current = null
          webglLossesRef.current++
          webgl.dispose()
          if (!cancelled) retryTimer = window.setTimeout(attach, 1000)
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        webglLossesRef.current++
        /* WebGL unavailable — DOM renderer fallback */
      }
    }
    attach()
    return () => {
      cancelled = true
      if (retryTimer) window.clearTimeout(retryTimer)
      webglRef.current?.dispose()
      webglRef.current = null
    }
  }, [active])

  // Live-apply appearance changes to the existing terminal (no respawn).
  useEffect(() => {
    const term = termRef.current
    if (!term || !appearance || !activeRef.current || layoutResizingRef.current || !hostRef.current?.offsetParent) return
    applyXtermOptions(term, appearance, exited)
    if (fitRef.current) {
      fitRef.current?.fit()
      resizePtyRef.current?.()
      reportDims()
    }
  }, [appearance, tabId, exited, reportDims])

  // Re-apply deferred appearance, resume buffered output, and refit when this
  // pane becomes visible. Inactive panes do no xterm parsing or option churn.
  useEffect(() => {
    if (!active) {
      dataSubscriptionRef.current?.pause()
      exitSubscriptionRef.current?.pause()
      return
    }
    if (layoutResizing) return
    const id = requestAnimationFrame(() => {
      const t = termRef.current
      const currentAppearance = appearanceRef.current
      if (t && currentAppearance) applyXtermOptions(t, currentAppearance, exited)
      fitRef.current?.fit()
      if (t) {
        resizePtyRef.current?.(true)
        if (ptyReadyRef.current) {
          dataSubscriptionRef.current?.resume()
          exitSubscriptionRef.current?.resume()
        }
        reportDims()
        if (!exited) t.focus()
      }
    })
    return () => cancelAnimationFrame(id)
  }, [active, layoutResizing, tabId, exited, reportDims])

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
})
