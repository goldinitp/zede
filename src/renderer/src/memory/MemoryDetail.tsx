import { useCallback, useEffect, useState } from 'react'
import type { MemoryDetail, MemoryType } from '@shared/api'
import { scopeInfo } from './scope'

const TYPE_LABEL: Record<MemoryType, string> = {
  fact: 'Fact',
  decision: 'Decision',
  preference: 'Preference',
  entity: 'Entity',
  todo: 'Todo'
}

const fmt = (ts: number | null): string => (ts ? new Date(ts).toLocaleString() : '—')

/** Last two path segments — enough to recognise a transcript / memory file. */
const shortPath = (p: string): string => {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

/**
 * A memory opened in its own tab (kind 'memory'). Mirrors the way a terminal
 * tab fills the content card, but renders the full record: content, scope/type,
 * provenance (transcript span or the Claude Code .md it was mirrored from), and
 * inline edit / pin / forget. Re-fetches on any memory change so it stays live.
 */
export function MemoryDetailPane({ memoryId, active }: { tabId: string; memoryId: string | null; active: boolean }) {
  const [detail, setDetail] = useState<MemoryDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  const load = useCallback(() => {
    if (!memoryId) {
      setDetail(null)
      setLoading(false)
      return
    }
    window.zede.memory.detail(memoryId).then((d) => {
      setDetail(d)
      setLoading(false)
    })
  }, [memoryId])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  // Stay in sync with edits/forgets/learns happening elsewhere.
  useEffect(() => {
    const off1 = window.zede.memory.onChanged(load)
    const off2 = window.zede.memory.onForgotten(() => load())
    return () => {
      off1()
      off2()
    }
  }, [load])

  const m = detail?.memory
  const mScope = m ? scopeInfo(m.scope) : null
  const save = (): void => {
    if (memoryId && text.trim()) window.zede.memory.edit(memoryId, text.trim()).then(() => setEditing(false))
  }
  const togglePin = (): void => {
    if (m) window.zede.memory.setPinned(m.id, !m.pinned)
  }
  const forget = (): void => {
    if (m && confirm(`Forget this memory? (undoable)\n\n“${m.content}”`)) window.zede.memory.delete(m.id)
  }

  return (
    <div className="memdetail-pane" style={{ display: active ? 'block' : 'none' }}>
      {loading ? (
        <div className="memdetail-empty">Loading…</div>
      ) : !m ? (
        <div className="memdetail-empty">This memory no longer exists — it may have been forgotten.</div>
      ) : (
        <div className="memdetail">
          <div className="memdetail-badges">
            <span className={`md-badge md-type-${m.type}`}>{TYPE_LABEL[m.type]}</span>
            {mScope && (
              <span className={`md-badge md-scope ${mScope.className}`} title={mScope.description}>
                {mScope.label}
              </span>
            )}
            {detail?.origin === 'claude-memory' && (
              <span className="md-badge md-origin" title="Mirrored from Claude Code's own memory store">
                From Claude Code memory
              </span>
            )}
            {m.pinned && <span className="md-badge md-pin">★ Pinned</span>}
          </div>

          {editing ? (
            <div className="memdetail-editbox">
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus />
              <div className="row">
                <button onClick={save}>Save</button>
                <button onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <h2 className="memdetail-content">{m.content}</h2>
          )}

          {!editing && (
            <div className="memdetail-actions">
              <button
                onClick={() => {
                  setText(m.content)
                  setEditing(true)
                }}
              >
                Edit
              </button>
              <button onClick={togglePin}>{m.pinned ? 'Unpin' : 'Pin'}</button>
              <button className="danger" onClick={forget}>
                Forget
              </button>
            </div>
          )}

          <dl className="memdetail-meta">
            <div>
              <dt>Confidence</dt>
              <dd>{m.confidence != null ? `${Math.round(m.confidence * 100)}%` : '—'}</dd>
            </div>
            <div>
              <dt>Salience</dt>
              <dd>{m.salience != null ? m.salience.toFixed(2) : '—'}</dd>
            </div>
            <div>
              <dt>Used</dt>
              <dd>{m.useCount}×</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{fmt(m.createdAt)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{fmt(m.updatedAt)}</dd>
            </div>
          </dl>

          {detail && detail.sources.length > 0 && (
            <section className="memdetail-section">
              <h4>{detail.origin === 'claude-memory' ? 'Source file' : 'Where this came from'}</h4>
              {detail.sources.map((s, i) => (
                <div key={i} className="memdetail-source">
                  <div className="memdetail-path" title={s.transcriptPath}>
                    {shortPath(s.transcriptPath)}
                  </div>
                  {s.excerpt && <pre className="memdetail-excerpt">{s.excerpt}</pre>}
                </div>
              ))}
            </section>
          )}

          {detail && detail.edits.length > 0 && (
            <section className="memdetail-section">
              <h4>Edit history</h4>
              {detail.edits.map((e, i) => (
                <div key={i} className="memdetail-editrow">
                  <span className="was">{e.before}</span>
                  <span className="arrow">→</span>
                  <span className="now">{e.after}</span>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
