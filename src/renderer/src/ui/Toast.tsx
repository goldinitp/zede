import { useEffect } from 'react'

export interface ToastState {
  id: string
  content: string
  /** 'info' shows the content verbatim with no Undo; default is the forgot-memory undo toast. */
  kind?: 'forgot' | 'info'
}

/** Undo toast for soft deletes (spec §7 — nothing vanishes without a trace),
 *  doubling as a plain notice when kind is 'info'. */
export function Toast({ toast, onUndo, onDismiss }: { toast: ToastState | null; onUndo: () => void; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(onDismiss, 7000)
    return () => clearTimeout(id)
  }, [toast, onDismiss])

  if (!toast) return null
  const clipped = toast.content.length > 60 ? toast.content.slice(0, 57) + '…' : toast.content
  return (
    <div className="toast">
      <span className="toast-text">{toast.kind === 'info' ? clipped : `Forgot “${clipped}”`}</span>
      {toast.kind !== 'info' && (
        <button className="toast-undo" onClick={onUndo}>
          Undo
        </button>
      )}
      <button className="toast-x" onClick={onDismiss}>
        ✕
      </button>
    </div>
  )
}
