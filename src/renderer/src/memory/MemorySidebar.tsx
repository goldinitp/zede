import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { ChatPrompt, ClaudeInternalItem, ClaudeInternalKind, ForgottenItem, InjectionPreview, Memory, MemoryType, Space, TabPrompts } from '@shared/api'
import { IconChevronRight } from '../ui/icons'
import { promptNeedle } from '../terminal/jump'
import { compareByScopeHierarchy, scopeInfo } from './scope'

/* One collapsible section per kind of context, internals first, then memory
   types — so every skill sits with the other skills, every fact with facts. */
const INTERNAL_SECTIONS: { kind: ClaudeInternalKind; label: string }[] = [
  { kind: 'skill', label: 'Skills' },
  { kind: 'plugin', label: 'Plugins' },
  { kind: 'mcp-server', label: 'MCP Servers' },
  { kind: 'tool', label: 'Tools' }
]
const MEMORY_SECTIONS: { type: MemoryType; label: string }[] = [
  { type: 'preference', label: 'Preferences' },
  { type: 'decision', label: 'Decisions' },
  { type: 'fact', label: 'Facts' },
  { type: 'entity', label: 'Entities' },
  { type: 'todo', label: 'Todos' }
]
const INTERNAL_KIND_LABEL: Record<ClaudeInternalKind, string> = {
  plugin: 'Plugin',
  skill: 'Skill',
  'mcp-server': 'MCP',
  tool: 'Tool'
}

const ALL_SECTION_KEYS: string[] = ['prompts', ...INTERNAL_SECTIONS.map((s) => s.kind), ...MEMORY_SECTIONS.map((s) => s.type)]

const COLLAPSED_KEY = 'zede:contextCollapsed'

function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

const byScopeThenRecency = (a: Memory, b: Memory): number => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  const scopeOrder = compareByScopeHierarchy(a, b)
  if (scopeOrder !== 0) return scopeOrder
  return b.updatedAt - a.updatedAt
}

const byScopeThenName = (a: ClaudeInternalItem, b: ClaudeInternalItem): number =>
  scopeInfo(a.scope).rank - scopeInfo(b.scope).rank || a.name.localeCompare(b.name)

/** Compact time hint for a prompt row: clock time today, date otherwise. */
function promptTime(ts: number): string {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

interface Props {
  /** Visibility — the panel stays mounted while closed so reopening paints instantly. */
  open: boolean
  spaceId: string
  /** The Space's active tab — the Prompts section shows only this tab's chat. */
  activeTabId: string | null
  spaces: Space[]
  notify: (t: { id: string; content: string }) => void
  /** Open a memory in its own tab (full detail + edit/history/sources). */
  onOpen: (m: Memory) => void
  /** Open a skill / plugin / MCP server / tool in its own editable tab. */
  onOpenInternal: (item: ClaudeInternalItem) => void
  /** Jump to a prompt: activate its chat tab and scroll the terminal there. */
  onJumpPrompt: (p: { tabId: string; text: string; occurrence: number }) => void
  onStartResize?: (e: PointerEvent<HTMLDivElement>) => void
  onResizeKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
}

export function MemorySidebar({ open, spaceId, activeTabId, spaces, notify, onOpen, onOpenInternal, onJumpPrompt, onStartResize, onResizeKeyDown }: Props) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [internals, setInternals] = useState<ClaudeInternalItem[]>([])
  const [prompts, setPrompts] = useState<TabPrompts[]>([])
  const [justLearned, setJustLearned] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<InjectionPreview | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)

  const [sharing, setSharing] = useState<string | null>(null)

  const [showForget, setShowForget] = useState(false)
  const [forgetQ, setForgetQ] = useState('')
  const [forgetPrev, setForgetPrev] = useState<Memory[] | null>(null)
  const [showForgotten, setShowForgotten] = useState(false)
  const [forgotten, setForgotten] = useState<ForgottenItem[]>([])

  const refreshPrompts = useCallback(() => {
    window.zede.prompts.list(spaceId).then(setPrompts)
  }, [spaceId])

  const refresh = useCallback(() => {
    window.zede.memory.list(spaceId).then(setMemories)
    window.zede.memory.preview(spaceId).then(setPreview)
    window.zede.internals.list(spaceId).then((snapshot) => setInternals(snapshot.items))
    refreshPrompts()
  }, [spaceId, refreshPrompts])

  useEffect(() => {
    refresh()
    setShowForgotten(false)
    const offLearned = window.zede.memory.onLearned((m) => {
      if (m.spaceId !== spaceId && scopeInfo(m.scope).key !== 'user') return
      setMemories((prev) => (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [m, ...prev]))
      setJustLearned((prev) => new Set(prev).add(m.id))
      setTimeout(() => setJustLearned((prev) => {
        const n = new Set(prev)
        n.delete(m.id)
        return n
      }), 4000)
      window.zede.memory.preview(spaceId).then(setPreview)
    })
    const offForgotten = window.zede.memory.onForgotten((id) => {
      setMemories((prev) => prev.filter((m) => m.id !== id))
      window.zede.memory.preview(spaceId).then(setPreview)
    })
    const offChanged = window.zede.memory.onChanged(refresh)
    return () => {
      offLearned()
      offForgotten()
      offChanged()
    }
  }, [spaceId, refresh])

  useEffect(() => {
    if (showForgotten) window.zede.memory.recentlyForgotten(spaceId).then(setForgotten)
  }, [showForgotten, spaceId, memories])

  // Refetch when the panel opens and on every tab switch, so the newly active
  // tab's chat is current the moment it's shown.
  useEffect(() => {
    if (open) refreshPrompts()
  }, [open, activeTabId, refreshPrompts])

  // Keep the Prompts section current while the panel is showing. Primary
  // signal: main pushes prompts:changed when the transcript watcher sees a
  // session write (already throttled main-side) — that covers hand-started and
  // external-terminal claudes whose session row binds after PTY output went
  // quiet. The PTY-quiet debounce stays as a fallback for a transcript dir the
  // watcher failed to attach to. Also refetch on tab create/close/rename.
  useEffect(() => {
    if (!open) return
    let timer: number | undefined
    const offPrompts = window.zede.prompts.onChanged(() => refreshPrompts())
    const offData = window.zede.pty.onData(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(refreshPrompts, 1000)
    })
    const offTab = window.zede.tab.onChanged(() => refreshPrompts())
    return () => {
      offPrompts()
      offData()
      offTab()
      if (timer) window.clearTimeout(timer)
    }
  }, [open, refreshPrompts])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? memories.filter((m) => m.content.toLowerCase().includes(q)) : memories
  }, [memories, query])

  const filteredInternals = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return internals
    return internals.filter((item) =>
      [item.name, item.description, item.kind, item.source, item.path ?? ''].some((value) => value.toLowerCase().includes(q))
    )
  }, [internals, query])

  const internalsByKind = useMemo(() => {
    const g = new Map<ClaudeInternalKind, ClaudeInternalItem[]>()
    for (const item of [...filteredInternals].sort(byScopeThenName)) {
      const list = g.get(item.kind)
      if (list) list.push(item)
      else g.set(item.kind, [item])
    }
    return g
  }, [filteredInternals])

  // Filtered prompt view: only the ACTIVE tab's chat (the fetch still covers
  // the whole Space, so a tab switch repaints instantly from state while the
  // refetch runs). Each prompt keeps its index in the FULL per-tab list so
  // occurrence counting (for the buffer jump) ignores the filter.
  const promptView = useMemo(() => {
    const q = query.trim().toLowerCase()
    return prompts
      .filter((g) => !activeTabId || g.tabId === activeTabId)
      .map((g) => ({
        ...g,
        prompts: g.prompts.map((p, idx) => ({ ...p, idx })).filter((p) => !q || p.text.toLowerCase().includes(q))
      }))
      .filter((g) => g.prompts.length > 0)
  }, [prompts, query, activeTabId])
  const promptCount = useMemo(() => promptView.reduce((n, g) => n + g.prompts.length, 0), [promptView])

  const jumpPrompt = (tabId: string, p: ChatPrompt & { idx: number }): void => {
    const all = prompts.find((g) => g.tabId === tabId)?.prompts ?? []
    const needle = promptNeedle(p.text)
    // nth rendering of this exact needle in the chat = how many earlier prompts share it
    const occurrence = all.slice(0, p.idx).filter((q) => promptNeedle(q.text) === needle).length
    onJumpPrompt({ tabId, text: p.text, occurrence })
  }

  const memoriesByType = useMemo(() => {
    const g = new Map<MemoryType, Memory[]>()
    for (const m of [...filtered].sort(byScopeThenRecency)) {
      const list = g.get(m.type)
      if (list) list.push(m)
      else g.set(m.type, [m])
    }
    return g
  }, [filtered])

  const toggleSection = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const allCollapsed = ALL_SECTION_KEYS.every((k) => collapsed.has(k))
  const toggleAllSections = (): void => {
    const next = allCollapsed ? new Set<string>() : new Set(ALL_SECTION_KEYS)
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    setCollapsed(next)
  }

  // While filtering, always show matches — a remembered collapse shouldn't hide hits.
  const filtering = query.trim().length > 0
  const isOpen = (key: string): boolean => filtering || !collapsed.has(key)

  const sectionHead = (key: string, label: string, count: number): ReactNode => (
    <button className="section-head" aria-expanded={isOpen(key)} onClick={() => toggleSection(key)}>
      <span className={`section-chevron${isOpen(key) ? ' open' : ''}`}>
        <IconChevronRight size={11} />
      </span>
      <span className="section-label">{label}</span>
      <span className="scope-count">{count}</span>
    </button>
  )

  const softDelete = (m: Memory): void => {
    window.zede.memory.delete(m.id).then(() => notify({ id: m.id, content: m.content }))
  }
  const hardDelete = (m: Memory): void => {
    if (confirm(`Permanently purge this memory?\n\n“${m.content}”\n\nThe fingerprint is kept so it can’t be re-derived.`))
      window.zede.memory.delete(m.id, true)
  }
  const runForgetPreview = (): void => {
    if (forgetQ.trim()) window.zede.memory.forgetAboutPreview(spaceId, forgetQ.trim()).then(setForgetPrev)
  }
  const confirmForget = (): void => {
    window.zede.memory.forgetAboutConfirm(spaceId, forgetQ.trim()).then(() => {
      setForgetPrev(null)
      setForgetQ('')
    })
  }

  return (
    <aside className="memory" style={{ display: open ? undefined : 'none' }}>
      <div
        className="memory-resizer"
        role="separator"
        aria-label="Resize memory panel"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={onStartResize}
        onKeyDown={onResizeKeyDown}
      />
      <div className="memory-scroll">
        <div className="memory-head">
          <span className="memory-title">Claude Context</span>
          <span className="count">{internals.length + memories.length}</span>
          <button
            className="memory-collapse-all"
            title={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
            onClick={toggleAllSections}
          >
            {allCollapsed ? '⊞' : '⊟'}
          </button>
          <button className="memory-refresh" title="Refresh Claude context" onClick={refresh}>
            ⟳
          </button>
        </div>

      <input className="memory-search" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />

      {filtered.length === 0 && filteredInternals.length === 0 && promptView.length === 0 && (
        <div className="empty">
          {memories.length === 0 && internals.length === 0 && prompts.length === 0
            ? 'No Claude context found yet. Memories, skills, plugins and MCP tools will appear here as they are discovered.'
            : 'No Claude context matches your filter.'}
        </div>
      )}

      {/* Even with no prompts yet the section stays visible (unless a filter is
          active) — an invisible feature reads as a broken one. */}
      {(promptView.length > 0 || !filtering) && (
        <section className="group context-section">
          {sectionHead('prompts', 'Prompts', promptCount)}
          {isOpen('prompts') && promptView.length === 0 && (
            <div className="empty">Prompts you send in this tab’s Claude chat appear here — click one to jump back to it.</div>
          )}
          {isOpen('prompts') &&
            promptView.map((g) => (
              <div key={g.tabId}>
                {promptView.length > 1 && <div className="prompt-group">{g.tabTitle}</div>}
                {g.prompts.map((p) => (
                  <div
                    key={p.idx}
                    className="ctx-row prompt-row"
                    role="button"
                    tabIndex={0}
                    title={`${p.text}\n\nClick to jump to this prompt in the chat`}
                    onClick={() => jumpPrompt(g.tabId, p)}
                    onKeyDown={(e) => e.key === 'Enter' && jumpPrompt(g.tabId, p)}
                  >
                    <span className="prompt-mark">›</span>
                    <span className="ctx-name">{p.text}</span>
                    {p.ts !== null && <span className="ctx-scope">{promptTime(p.ts)}</span>}
                  </div>
                ))}
              </div>
            ))}
        </section>
      )}

      {INTERNAL_SECTIONS.map(({ kind, label }) => {
        const items = internalsByKind.get(kind)
        if (!items?.length) return null
        return (
          <section key={kind} className="group context-section">
            {sectionHead(kind, label, items.length)}
            {isOpen(kind) &&
              items.map((item) => {
                const itemScope = scopeInfo(item.scope)
                return (
                  <div
                    key={item.id}
                    className={`ctx-row ${itemScope.className}`}
                    title={`${item.name} · ${INTERNAL_KIND_LABEL[item.kind]}${item.path ? ` — ${item.path}` : ''} — click to view & edit`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenInternal(item)}
                    onKeyDown={(e) => e.key === 'Enter' && onOpenInternal(item)}
                  >
                    <span className="ctx-dot" />
                    <span className="ctx-name">{item.name}</span>
                    <span className="ctx-scope">{itemScope.label.toLowerCase()}</span>
                  </div>
                )
              })}
          </section>
        )
      })}

      {MEMORY_SECTIONS.map(({ type, label }) => {
        const groupMemories = memoriesByType.get(type)
        if (!groupMemories?.length) return null
        return (
          <section key={type} className="group context-section">
            {sectionHead(type, label, groupMemories.length)}
            {isOpen(type) &&
              groupMemories.map((m) => {
                const mScope = scopeInfo(m.scope)
                return (
                  <div
                    key={m.id}
                    className={`ctx-row mem-row ${mScope.className}${justLearned.has(m.id) ? ' new' : ''}${m.pinned ? ' pinned' : ''}`}
                  >
                    <span className="ctx-dot" />
                    <span className="ctx-name" title="Open in a tab" onClick={() => onOpen(m)}>
                      {m.content}
                    </span>
                    <span className="ctx-scope">{mScope.label.toLowerCase()}</span>
                    <span className="ctx-actions">
                      <button className="ctx-act" title="Add to another Space" onClick={() => setSharing(sharing === m.id ? null : m.id)}>
                        ⊕
                      </button>
                      <button
                        className={`ctx-act${m.pinned ? ' on' : ''}`}
                        title={m.pinned ? 'Unpin' : 'Pin'}
                        onClick={() => window.zede.memory.setPinned(m.id, !m.pinned)}
                      >
                        {m.pinned ? '★' : '☆'}
                      </button>
                      <button className="ctx-act" title="Forget (soft — undoable). Shift-click to purge." onClick={(e) => (e.shiftKey ? hardDelete(m) : softDelete(m))}>
                        ✕
                      </button>
                    </span>
                    {sharing === m.id && (
                      <div className="share-pop">
                        {spaces.filter((s) => s.id !== spaceId).length === 0 && <span className="muted">No other Spaces</span>}
                        {spaces
                          .filter((s) => s.id !== spaceId)
                          .map((s) => (
                            <button
                              key={s.id}
                              onClick={() => {
                                window.zede.memory.shareToSpace(m.id, s.id)
                                setSharing(null)
                              }}
                            >
                              {s.icon || '🗂'} {s.name}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )
              })}
          </section>
        )
      })}

      {(filteredInternals.length > 0 || filtered.length > 0) && (
        <div className="ctx-legend">
          <span className="ctx-dot scope-user" /> user scope · click a row to open
        </div>
      )}

      <button className="forgotten-toggle" onClick={() => setShowForget((v) => !v)}>
        {showForget ? '▾' : '▸'} Forget by topic…
      </button>
      {showForget && (
        <div className="forget-box">
          <input
            className="memory-search forget-input"
            placeholder="e.g. “the old database schema” (semantic)"
            value={forgetQ}
            autoFocus
            onChange={(e) => setForgetQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runForgetPreview()}
          />
          {forgetPrev && (
            <div className="forget-prev">
              <div className="forget-prev-head">{forgetPrev.length} match{forgetPrev.length === 1 ? '' : 'es'} — forget all?</div>
              {forgetPrev.slice(0, 6).map((m) => (
                <div key={m.id} className="forget-prev-item">
                  {m.content}
                </div>
              ))}
              <div className="row">
                <button className="danger" disabled={!forgetPrev.length} onClick={confirmForget}>
                  Forget {forgetPrev.length}
                </button>
                <button onClick={() => setForgetPrev(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      <button className="forgotten-toggle" onClick={() => setShowForgotten((v) => !v)}>
        {showForgotten ? '▾' : '▸'} Recently forgotten
      </button>
      {showForgotten && (
        <div className="forgotten">
          {forgotten.length === 0 && <div className="empty">Nothing forgotten yet.</div>}
          {forgotten.map((f) => (
            <div key={f.tombstoneId} className="forgotten-item">
              <span className="forgotten-text" title={f.reason}>
                {f.content}
              </span>
              <button
                className="forgotten-restore"
                title={f.reason === 'hard delete' ? 'Purged — cannot restore' : 'Restore'}
                disabled={f.reason === 'hard delete'}
                onClick={() => window.zede.memory.undo(f.memoryId)}
              >
                ↩
              </button>
            </div>
          ))}
        </div>
      )}

        {preview && (
          <div className="memory-foot" title="What a fresh claude session in this Space is injected with">
            ⤵ Injected into new sessions: <b>{preview.memories.length}</b> memories · ~{preview.tokens} tok ·{' '}
            {preview.adapter === 'flag' ? 'system-prompt flag' : '.zede/context.md'}
          </div>
        )}
      </div>
    </aside>
  )
}
