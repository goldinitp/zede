import { useEffect, useRef, useState, type ReactNode } from 'react'

interface PromptOpts {
  /** Icon-picker mode: auto-opens the native macOS Emoji & Symbols panel and
   *  holds a single chosen glyph (the latest pick replaces the previous one). */
  emoji?: boolean
}

interface PromptReq extends PromptOpts {
  title: string
  value: string
  resolve: (v: string | null) => void
}

/**
 * Promise-based replacement for `window.prompt()`, which Electron deliberately
 * does NOT implement (it silently returns null). Returns `{ ask, node }`: render
 * `node` once in the tree, then `await ask('Title', 'default')` anywhere — it
 * resolves to the entered string, or null if cancelled. Pass `{ emoji: true }`
 * for the native icon picker.
 */
export function useTextPrompt(): {
  ask: (title: string, defaultValue?: string, opts?: PromptOpts) => Promise<string | null>
  node: ReactNode
} {
  const [req, setReq] = useState<PromptReq | null>(null)

  const ask = (title: string, defaultValue = '', opts: PromptOpts = {}): Promise<string | null> =>
    new Promise((resolve) => setReq({ title, value: defaultValue, resolve, ...opts }))

  const done = (v: string | null): void => {
    req?.resolve(v)
    setReq(null)
  }

  const node = req ? (
    <TextPromptModal
      title={req.title}
      initial={req.value}
      emoji={req.emoji}
      onSubmit={done}
      onCancel={() => done(null)}
    />
  ) : null

  return { ask, node }
}

/** The last grapheme cluster of a string, so a fresh emoji pick (appended by the
 *  native panel at the cursor) replaces the previous one — the icon stays a
 *  single glyph even for multi-codepoint emoji (flags, ZWJ sequences). */
function lastGrapheme(s: string): string {
  type Seg = { segment(input: string): Iterable<{ segment: string }> }
  type SegCtor = new (locale?: string, opts?: { granularity: 'grapheme' }) => Seg
  const Segmenter = (Intl as unknown as { Segmenter?: SegCtor }).Segmenter
  if (!Segmenter) return [...s].slice(-1).join('') // fallback: last code point
  const parts = [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(s)]
  return parts.length ? parts[parts.length - 1].segment : ''
}

function TextPromptModal({
  title,
  initial,
  emoji,
  onSubmit,
  onCancel
}: {
  title: string
  initial: string
  emoji?: boolean
  onSubmit: (v: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
    // Auto-summon the native picker so "Change Icon…" lands straight in it.
    if (emoji) window.zede.ui.showEmojiPanel()
  }, [emoji])

  // The native panel inserts the glyph into the focused input; reduce to one.
  const onChange = (raw: string): void => setV(emoji ? lastGrapheme(raw) : raw)

  const openPicker = (): void => {
    ref.current?.focus() // the panel inserts into the focused field
    window.zede.ui.showEmojiPanel()
  }

  const inputEl = (
    <input
      ref={ref}
      className="prompt-input"
      value={v}
      placeholder={emoji ? 'Pick or type an emoji' : undefined}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onSubmit(v)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-prompt" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prompt-title">{title}</div>
        {emoji ? (
          <div className="prompt-emoji">
            <div className={`prompt-emoji-preview${v ? '' : ' empty'}`}>{v || 'No icon'}</div>
            <div className="prompt-emoji-body">
              {inputEl}
              <button className="prompt-pick" onClick={openPicker}>
                Open Emoji &amp; Symbols
              </button>
            </div>
          </div>
        ) : (
          inputEl
        )}
        <div className="row prompt-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="prompt-ok" onClick={() => onSubmit(v)}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
