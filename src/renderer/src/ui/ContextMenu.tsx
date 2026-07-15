import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onClick?: () => void
  submenu?: MenuItem[]
  danger?: boolean
  disabled?: boolean
  hint?: string
}
export type MenuEntry = MenuItem | 'separator'

interface Props {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}

/**
 * A lightweight right-click menu (Arc-style): rendered to <body> so it escapes
 * the sidebar's overflow/stacking, clamped into the viewport, closes on Escape
 * or any outside press. One level of submenu (used for "Move to Space").
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openSub, setOpenSub] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - r.width - 8)
    const ny = Math.min(y, window.innerHeight - r.height - 8)
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // capture so we beat other handlers; `true` also catches right-clicks elsewhere
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  const run = (it: MenuItem): void => {
    if (it.disabled) return
    it.onClick?.()
    onClose()
  }

  const renderItem = (it: MenuItem, key: number): ReactNode => {
    if (it.submenu) {
      return (
        <div
          key={key}
          className={`ctx-item has-sub${it.disabled ? ' disabled' : ''}`}
          onMouseEnter={() => setOpenSub(key)}
        >
          <span className="ctx-label">{it.label}</span>
          <span className="ctx-caret">›</span>
          {openSub === key && !it.disabled && (
            <div className="ctx-menu ctx-sub">
              {it.submenu.length === 0 ? (
                <div className="ctx-item disabled">
                  <span className="ctx-label muted">No other Spaces</span>
                </div>
              ) : (
                it.submenu.map((s, j) => (
                  <button key={j} className="ctx-item" onClick={() => run(s)}>
                    <span className="ctx-label">{s.label}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )
    }
    return (
      <button
        key={key}
        className={`ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
        disabled={it.disabled}
        onClick={() => run(it)}
        role="menuitem"
      >
        <span className="ctx-label">{it.label}</span>
        {it.hint && <span className="ctx-hint">{it.hint}</span>}
      </button>
    )
  }

  return createPortal(
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => (it === 'separator' ? <div key={i} className="ctx-sep" /> : renderItem(it, i)))}
    </div>,
    document.body
  )
}
