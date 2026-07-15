import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import type { ClaudeInternalDetail, ClaudeInternalItem, ClaudeInternalKind } from '@shared/api'
import { IconDoc } from '../ui/icons'
import { scopeInfo } from './scope'

const KIND_LABEL: Record<ClaudeInternalKind, string> = {
  skill: 'Skill',
  plugin: 'Plugin',
  'mcp-server': 'MCP Server',
  tool: 'Tool'
}

/** Abbreviate the user's home directory to `~` for a compact full path. */
const prettyPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')

/**
 * A Claude internal (skill / plugin / MCP server / tool) opened in its own tab
 * (kind 'internal'). File-backed items (SKILL.md, tool .json) open into a
 * full-bleed editor with a slim header bar; directory-backed ones (plugins, MCP
 * servers) show their metadata plus the nested items, each clickable into a tab.
 */
export function InternalDetailPane({
  spaceId,
  itemId,
  active,
  onOpenInternal
}: {
  tabId: string
  spaceId: string
  itemId: string | null
  active: boolean
  onOpenInternal: (item: ClaudeInternalItem) => void
}) {
  const [detail, setDetail] = useState<ClaudeInternalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!itemId) {
      setDetail(null)
      setLoading(false)
      return
    }
    window.zede.internals.detail(spaceId, itemId).then((d) => {
      setDetail(d)
      setText(d?.content ?? '')
      setLoading(false)
    })
  }, [spaceId, itemId])

  useEffect(() => {
    setLoading(true)
    setError(null)
    load()
  }, [load])

  const item = detail?.item
  const dirty = !!detail?.editable && text !== (detail?.content ?? '')

  const save = (): void => {
    if (!itemId || !dirty) return
    setSaving(true)
    setError(null)
    window.zede.internals.save(spaceId, itemId, text).then((ok) => {
      setSaving(false)
      if (!ok) {
        setError('Could not save — the file may have moved or is not writable.')
        return
      }
      setDetail((d) => (d ? { ...d, content: text } : d))
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1600)
    })
  }

  const editorKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      save()
    }
  }

  const editorLayout = !!(item && detail?.editable)

  return (
    <div className={editorLayout ? 'editor-pane' : 'memdetail-pane'} style={{ display: active ? (editorLayout ? 'flex' : 'block') : 'none' }}>
      {loading ? (
        <div className="memdetail-empty">Loading…</div>
      ) : !item ? (
        <div className="memdetail-empty">This item no longer exists — it may have been removed from disk.</div>
      ) : editorLayout ? (
        <>
          <div className="editor-head" title={item.path ?? item.name}>
            <span className="editor-doc">
              <IconDoc size={14} />
            </span>
            <span className="editor-title">{item.name}</span>
            <span className={`editor-tag kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
            <span className={`editor-tag ${scopeInfo(item.scope).className}`}>{scopeInfo(item.scope).label}</span>
            {item.path && <span className="editor-path">{prettyPath(item.path)}</span>}
            <span className="editor-spacer" />
            {error ? (
              <span className="editor-status err">Save failed</span>
            ) : saving ? (
              <span className="editor-status">Saving…</span>
            ) : savedFlash ? (
              <span className="editor-status ok">Saved ✓</span>
            ) : dirty ? (
              <span className="editor-status dirty">Unsaved</span>
            ) : (
              <span className="editor-status">Saved</span>
            )}
            <button className="editor-save" onClick={save} disabled={!dirty || saving}>
              Save
            </button>
          </div>
          <textarea
            className="editor-body"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={editorKeyDown}
            spellCheck={false}
          />
          {error && <div className="editor-error">{error}</div>}
        </>
      ) : (
        <div className="memdetail intdetail">
          <div className="memdetail-badges">
            <span className={`md-badge internal-kind kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
            <span className={`md-badge md-scope ${scopeInfo(item.scope).className}`} title={scopeInfo(item.scope).description}>
              {scopeInfo(item.scope).label}
            </span>
            <span className="md-badge md-origin">{item.source}</span>
          </div>

          <h2 className="memdetail-content">{item.name}</h2>
          {item.description && <p className="intdetail-desc">{item.description}</p>}
          {item.path && (
            <div className="memdetail-path intdetail-path" title={item.path}>
              {prettyPath(item.path)}
            </div>
          )}

          {detail?.children.length === 0 && (
            <div className="memdetail-empty">Nothing editable here — this item has no file content.</div>
          )}

          {detail && detail.children.length > 0 && (
            <section className="memdetail-section">
              <h4>Contains</h4>
              {detail.children.map((child) => (
                <button key={child.id} className="intdetail-child" onClick={() => onOpenInternal(child)}>
                  <span className={`type-badge internal-kind kind-${child.kind}`}>{KIND_LABEL[child.kind]}</span>
                  <span className="intdetail-child-name">{child.name}</span>
                  <span className="intdetail-child-desc">{child.description}</span>
                </button>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
