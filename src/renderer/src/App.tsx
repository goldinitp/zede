import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { ClaudeInternalItem, Memory, SavedConversation, Settings, Space, Tab, TabKind } from '@shared/api'
import { TerminalPane } from './terminal/Terminal'
import { jumpTerminalToPrompt } from './terminal/jump'
import { applyAppearance } from './ui/appearance'
import { MemorySidebar } from './memory/MemorySidebar'
import { MemoryDetailPane } from './memory/MemoryDetail'
import { InternalDetailPane } from './memory/InternalDetail'
import { SpacesRail } from './spaces/SpacesRail'
import { TabBar } from './tabs/TabBar'
import { SettingsPanel } from './settings/Settings'
import type { MenuEntry } from './ui/ContextMenu'
import { Toast, type ToastState } from './ui/Toast'
import { useTextPrompt } from './ui/Prompt'
import { IconGear, IconPlus, IconRightPanel, IconSidebar, IconTerminal } from './ui/icons'

/** Abbreviate the user's home directory to `~`, macOS/Linux style. */
function prettyCwd(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

/** Strip Electron's "Error invoking remote method '…':" wrapper off IPC rejections. */
function ipcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/** The window title shown centered in the titlebar: `process — cwd — cols×rows`,
 *  matching the active tab (terminal tabs report their live grid size). */
function titleFor(tab: Tab | undefined, dims: { cols: number; rows: number } | null): string {
  if (!tab) return 'Zede'
  if (tab.kind === 'shell') return `shell — ${prettyCwd(tab.cwd)}${dims ? ` — ${dims.cols}×${dims.rows}` : ''}`
  if (tab.kind === 'claude') return `${tab.title} — ${prettyCwd(tab.cwd)}`
  return tab.title // memory / internal panes
}

const SIDEBAR_WIDTH_KEY = 'zede:sidebarWidth'
const SIDEBAR_DEFAULT_WIDTH = 248
const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 520
const MEMORY_WIDTH_KEY = 'zede:memoryWidth'
const MEMORY_DEFAULT_WIDTH = 330
const MEMORY_MIN_WIDTH = 260
const MEMORY_MAX_WIDTH = 560

function sidebarMaxWidth(): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * 0.42)))
}

function memoryMaxWidth(): number {
  return Math.max(MEMORY_MIN_WIDTH, Math.min(MEMORY_MAX_WIDTH, Math.floor(window.innerWidth * 0.45)))
}

function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), sidebarMaxWidth()))
}

function clampMemoryWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, MEMORY_MIN_WIDTH), memoryMaxWidth()))
}

function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_WIDTH
}

function readMemoryWidth(): number {
  const stored = Number(localStorage.getItem(MEMORY_WIDTH_KEY))
  return Number.isFinite(stored) ? clampMemoryWidth(stored) : MEMORY_DEFAULT_WIDTH
}

export default function App() {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [activeSpace, setActiveSpace] = useState<string>('')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(true)
  const [railOpen, setRailOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [memoryWidth, setMemoryWidth] = useState(readMemoryWidth)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [resizingMemory, setResizingMemory] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appearance, setAppearance] = useState<Settings | null>(null)
  const [termDims, setTermDims] = useState<{ cols: number; rows: number } | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const { ask, node: promptNode } = useTextPrompt()
  const sidebarWidthRef = useRef(sidebarWidth)
  const memoryWidthRef = useRef(memoryWidth)
  const activeSpaceRef = useRef('')
  activeSpaceRef.current = activeSpace
  const activeTabRef = useRef<string | null>(null)
  activeTabRef.current = activeTab

  // The active terminal reports its grid size for the window title; clear it on
  // tab switch so a stale size never shows before the new pane refits.
  useEffect(() => setTermDims(null), [activeTab])
  const reportDims = useCallback((tabId: string, cols: number, rows: number) => {
    if (tabId === activeTabRef.current) setTermDims({ cols, rows })
  }, [])

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])
  useEffect(() => {
    memoryWidthRef.current = memoryWidth
    localStorage.setItem(MEMORY_WIDTH_KEY, String(memoryWidth))
  }, [memoryWidth])

  const loadSpaces = useCallback(async () => {
    const [list, active] = await Promise.all([window.zede.space.list(), window.zede.space.getActive()])
    setSpaces(list)
    setActiveSpace((cur) => cur || active)
  }, [])

  const loadTabs = useCallback(async (spaceId: string) => {
    const list = await window.zede.tab.list(spaceId)
    setTabs(list)
    setActiveTab((cur) => (cur && list.some((t) => t.id === cur) ? cur : (list[0]?.id ?? null)))
  }, [])

  // initial load + subscriptions
  useEffect(() => {
    loadSpaces()
    const offSpace = window.zede.space.onChanged(loadSpaces)
    const offTab = window.zede.tab.onChanged((sid) => {
      if (sid === activeSpaceRef.current) loadTabs(sid)
    })
    // ⌘S toggles the Spaces sidebar (left edge), ⌘M the Memory panel (right
    // edge). These come exclusively from the menu accelerators so they fire
    // once — handling them again here would double-toggle and cancel out.
    const offToggle = window.zede.ui.onToggleMemory(() => setMemoryOpen((v) => !v))
    const offToggleSide = window.zede.ui.onToggleSidebar(() => setRailOpen((v) => !v))
    const offSettings = window.zede.ui.onOpenSettings(() => setSettingsOpen(true))
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 't') {
        // New Claude tab in the active Space (the live ref avoids a stale closure).
        e.preventDefault()
        const sid = activeSpaceRef.current
        if (sid) window.zede.tab.create({ spaceId: sid, kind: 'claude' }).then((t) => setActiveTab(t.id))
      } else if (k === 'w') {
        // Close the active tab (pinned tabs keep their slot — handled in Core).
        e.preventDefault()
        const id = activeTabRef.current
        if (id) window.zede.tab.close(id).then(() => loadTabs(activeSpaceRef.current))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offSpace()
      offTab()
      offToggle()
      offToggleSide()
      offSettings()
      window.removeEventListener('keydown', onKey)
    }
  }, [loadSpaces, loadTabs])

  // load tabs whenever the active Space changes
  useEffect(() => {
    if (activeSpace) loadTabs(activeSpace)
  }, [activeSpace, loadTabs])

  // appearance: apply on load + whenever settings change (from the Settings panel)
  useEffect(() => {
    window.zede.settings.get().then((s) => {
      setAppearance(s)
      applyAppearance(s)
    })
    return window.zede.settings.onChanged((s) => {
      setAppearance(s)
      applyAppearance(s)
    })
  }, [])

  // macOS hides the traffic lights in fullscreen — reclaim the chrome inset then.
  useEffect(() => window.zede.ui.onFullScreenChanged(setFullscreen), [])

  useEffect(() => {
    const onResize = (): void => {
      setSidebarWidth((w) => clampSidebarWidth(w))
      setMemoryWidth((w) => clampMemoryWidth(w))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const resizeSidebarBy = (delta: number): void => {
    setSidebarWidth((w) => clampSidebarWidth(w + delta))
  }
  const resizeMemoryBy = (delta: number): void => {
    setMemoryWidth((w) => clampMemoryWidth(w + delta))
  }

  const startSidebarResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current
    setResizingSidebar(true)

    const onMove = (ev: PointerEvent): void => {
      setSidebarWidth(clampSidebarWidth(startWidth + ev.clientX - startX))
    }
    const onUp = (): void => {
      setResizingSidebar(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startMemoryResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = memoryWidthRef.current
    setResizingMemory(true)

    const onMove = (ev: PointerEvent): void => {
      setMemoryWidth(clampMemoryWidth(startWidth + startX - ev.clientX))
    }
    const onUp = (): void => {
      setResizingMemory(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const switchSpace = (id: string): void => {
    if (id === activeSpace) return
    setActiveTab(null)
    setActiveSpace(id)
    window.zede.space.setActive(id)
  }

  const createSpace = async (): Promise<void> => {
    const name = (await ask('New Space name'))?.trim()
    if (!name) return
    const s = await window.zede.space.create(name)
    await loadSpaces()
    switchSpace(s.id)
  }
  const renameSpace = async (s: Space): Promise<void> => {
    const name = (await ask('Rename Space', s.name))?.trim()
    if (name) await window.zede.space.rename(s.id, name)
  }
  const removeSpace = async (s: Space): Promise<void> => {
    if (!confirm(`Delete Space “${s.name}” and its tabs? Memories are kept.`)) return
    await window.zede.space.remove(s.id)
    setActiveSpace('')
    await loadSpaces()
    const active = await window.zede.space.getActive()
    setActiveSpace(active)
  }
  const changeSpaceIcon = async (s?: Space): Promise<void> => {
    if (!s) return
    const icon = (await ask('Change Space icon', s.icon ?? '', { emoji: true }))?.trim()
    if (icon) await window.zede.space.setIcon(s.id, icon)
  }
  const makeDefaultSpace = async (s?: Space): Promise<void> => {
    if (s) await window.zede.space.setDefault(s.id)
  }

  const createTab = async (kind: TabKind): Promise<void> => {
    const t = await window.zede.tab.create({ spaceId: activeSpace, kind })
    await loadTabs(activeSpace)
    setActiveTab(t.id)
  }
  // Open a memory in its own tab (or focus the one already showing it).
  const openMemory = async (m: Memory): Promise<void> => {
    const existing = tabs.find((t) => t.kind === 'memory' && t.ref === m.id)
    if (existing) {
      setActiveTab(existing.id)
      return
    }
    const label = m.content.length > 32 ? `${m.content.slice(0, 31)}…` : m.content
    const t = await window.zede.tab.create({ spaceId: activeSpace, kind: 'memory', ref: m.id, title: label })
    await loadTabs(activeSpace)
    setActiveTab(t.id)
  }
  // Open a skill/plugin/MCP/tool in its own editable tab (or focus the existing one).
  const openInternal = async (item: ClaudeInternalItem): Promise<void> => {
    const existing = tabs.find((t) => t.kind === 'internal' && t.ref === item.id)
    if (existing) {
      setActiveTab(existing.id)
      return
    }
    const label = item.name.length > 32 ? `${item.name.slice(0, 31)}…` : item.name
    const t = await window.zede.tab.create({ spaceId: activeSpace, kind: 'internal', ref: item.id, title: label })
    await loadTabs(activeSpace)
    setActiveTab(t.id)
  }
  const closeTab = async (id: string): Promise<void> => {
    await window.zede.tab.close(id)
    await loadTabs(activeSpace)
  }
  const closeAllTabs = async (): Promise<void> => {
    await window.zede.tab.closeAll(activeSpace)
    await loadTabs(activeSpace)
  }
  const togglePinTab = async (t: Tab): Promise<void> => {
    await window.zede.tab.setPinned(t.id, !t.pinned)
  }
  const renameTab = async (t: Tab): Promise<void> => {
    const name = (await ask('Rename tab', t.title))?.trim()
    if (name) await window.zede.tab.rename(t.id, name)
  }
  const duplicateTab = async (t: Tab): Promise<void> => {
    const dup = await window.zede.tab.duplicate(t.id)
    if (dup) setActiveTab(dup.id)
  }
  const moveTab = async (t: Tab, spaceId: string): Promise<void> => {
    await window.zede.tab.move(t.id, spaceId)
  }
  // Snapshot a tab's Claude conversation to a local JSON so a long conversation
  // can't get lost; the saved-conversations picker below loads it back. The
  // prompt doubles as confirmation — naming the save, or Esc to not save at all.
  const saveConversation = async (t: Tab): Promise<void> => {
    const name = (await ask('Save conversation as', t.title))?.trim()
    if (!name) return
    try {
      const meta = await window.zede.conversation.save(t.id, name)
      setToast({ id: meta.id, kind: 'info', content: `Saved “${meta.title}” — ${meta.messageCount} messages` })
    } catch (err) {
      setToast({ id: 'conversation-save-error', kind: 'info', content: ipcError(err) })
    }
  }
  // Restore a save into a new tab (resumes the Claude session). With compact,
  // /compact runs once the session settles, so the context comes back lean.
  const loadConversation = async (id: string, compact: boolean): Promise<void> => {
    try {
      const t = await window.zede.conversation.load(id, { spaceId: activeSpace, compact })
      await loadTabs(activeSpace)
      setActiveTab(t.id)
      if (compact) setToast({ id, kind: 'info', content: 'Conversation loading — /compact runs when it settles' })
    } catch (err) {
      setToast({ id: 'conversation-load-error', kind: 'info', content: ipcError(err) })
    }
  }
  const renameSave = async (c: SavedConversation): Promise<void> => {
    const name = (await ask('Rename saved conversation', c.title))?.trim()
    if (name) await window.zede.conversation.rename(c.id, name)
  }
  const savedConversationsMenu = async (): Promise<MenuEntry[]> => {
    const list = await window.zede.conversation.list()
    if (!list.length) return [{ label: 'No saved conversations yet', disabled: true }]
    return list.map((c) => ({
      label: c.title.length > 28 ? `${c.title.slice(0, 27)}…` : c.title,
      hint: `${new Date(c.savedAt).toLocaleDateString()} · ${c.messageCount} msgs`,
      submenu: [
        { label: 'Load conversation', onClick: () => loadConversation(c.id, false) },
        { label: 'Load & compact context', onClick: () => loadConversation(c.id, true) },
        { label: 'Rename save…', onClick: () => renameSave(c) },
        { label: 'Delete save', danger: true, onClick: () => void window.zede.conversation.delete(c.id) }
      ]
    }))
  }
  // Jump from a sidebar prompt to its spot in the chat: activate the tab, then
  // scroll once the pane has refit (activation triggers a fit + PTY resize, so
  // an immediate scroll would race the re-wrap). Already-active tabs jump fast.
  const jumpToPrompt = useCallback((p: { tabId: string; text: string; occurrence: number }): void => {
    const already = activeTabRef.current === p.tabId
    if (!already) setActiveTab(p.tabId)
    window.setTimeout(() => {
      if (!jumpTerminalToPrompt(p.tabId, p.text, p.occurrence))
        setToast({ id: `prompt-jump-${p.tabId}`, kind: 'info', content: 'That prompt is no longer in the terminal scrollback' })
    }, already ? 50 : 350)
  }, [])

  // Drag-and-drop reorder/pin. Apply optimistically (no flash) so the row jumps
  // under the cursor immediately, then persist; the tab:changed reload confirms it.
  const reorderTabs = async (orderedIds: string[], pinnedChange?: { id: string; pinned: boolean }): Promise<void> => {
    setTabs((cur) => {
      const byId = new Map(cur.map((t) => [t.id, t] as const))
      return orderedIds
        .map((id) => byId.get(id))
        .filter((t): t is Tab => !!t)
        .map((t) => (pinnedChange && pinnedChange.id === t.id ? { ...t, pinned: pinnedChange.pinned } : t))
    })
    if (pinnedChange) await window.zede.tab.setPinned(pinnedChange.id, pinnedChange.pinned)
    await window.zede.tab.reorder(activeSpace, orderedIds)
  }

  const undo = (): void => {
    if (toast && toast.kind !== 'info') window.zede.memory.undo(toast.id)
    setToast(null)
  }

  const activeSpaceObj = spaces.find((s) => s.id === activeSpace)
  const spaceName = activeSpaceObj?.name ?? ''
  const activeTabObj = tabs.find((t) => t.id === activeTab)
  const windowTitle = titleFor(activeTabObj, termDims)
  const appStyle = { '--sidebar-width': `${sidebarWidth}px`, '--memory-width': `${memoryWidth}px` } as CSSProperties

  return (
    <div
      className={`app${fullscreen ? ' fullscreen' : ''}${resizingSidebar ? ' resizing-sidebar' : ''}${resizingMemory ? ' resizing-memory' : ''}`}
      style={appStyle}
    >
      {/* Full-width macOS-style titlebar: traffic lights (native, left), the
          centered window title, and the view toggles on the right. */}
      <div className="titlebar">
        <button className="icon-btn tb-sidebar" title="Toggle sidebar (⌘S)" onClick={() => setRailOpen((v) => !v)}>
          <IconSidebar />
        </button>
        <div className="tb-title">{windowTitle}</div>
        <div className="tb-actions">
          <button className="icon-btn" title="Settings (⌘,)" onClick={() => setSettingsOpen(true)}>
            <IconGear />
          </button>
          <button
            className={`icon-btn${memoryOpen ? ' on' : ''}`}
            title="Toggle Claude Context (⌘M)"
            onClick={() => setMemoryOpen((v) => !v)}
          >
            <IconRightPanel />
          </button>
        </div>
      </div>

      <div className="app-body">
        {railOpen ? (
          <aside className="sidebar">
            <TabBar
              tabs={tabs}
              activeId={activeTab}
              spaceName={spaceName}
              spaceIcon={activeSpaceObj?.icon}
              spaces={spaces}
              onSelect={setActiveTab}
              onClose={closeTab}
              onCreate={createTab}
              onTogglePin={togglePinTab}
              onReorder={reorderTabs}
              onCloseAll={closeAllTabs}
              onRename={renameTab}
              onDuplicate={duplicateTab}
              onMove={moveTab}
              onSaveConversation={saveConversation}
              loadSavedMenu={savedConversationsMenu}
              onRenameSpace={() => activeSpaceObj && renameSpace(activeSpaceObj)}
              onChangeSpaceIcon={() => changeSpaceIcon(activeSpaceObj)}
              onMakeDefaultSpace={() => makeDefaultSpace(activeSpaceObj)}
              onRemoveSpace={() => activeSpaceObj && removeSpace(activeSpaceObj)}
            />

            <SpacesRail
              spaces={spaces}
              activeId={activeSpace}
              onSelect={switchSpace}
              onCreate={createSpace}
              onRename={renameSpace}
              onChangeIcon={changeSpaceIcon}
              onMakeDefault={makeDefaultSpace}
              onRemove={removeSpace}
            />
            <div
              className="sidebar-resizer"
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={startSidebarResize}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') {
                  e.preventDefault()
                  resizeSidebarBy(e.shiftKey ? -40 : -12)
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault()
                  resizeSidebarBy(e.shiftKey ? 40 : 12)
                } else if (e.key === 'Home') {
                  e.preventDefault()
                  setSidebarWidth(SIDEBAR_MIN_WIDTH)
                } else if (e.key === 'End') {
                  e.preventDefault()
                  setSidebarWidth(sidebarMaxWidth())
                }
              }}
            />
          </aside>
        ) : null}

        <main className="content">
          <div className="panes">
            {tabs.map((t) =>
              t.kind === 'memory' ? (
                <MemoryDetailPane key={t.id} tabId={t.id} memoryId={t.ref ?? null} active={t.id === activeTab} />
              ) : t.kind === 'internal' ? (
                <InternalDetailPane
                  key={t.id}
                  tabId={t.id}
                  spaceId={t.spaceId}
                  itemId={t.ref ?? null}
                  active={t.id === activeTab}
                  onOpenInternal={openInternal}
                />
              ) : (
                <TerminalPane
                  key={t.id}
                  tabId={t.id}
                  active={t.id === activeTab}
                  appearance={appearance}
                  onDims={reportDims}
                />
              )
            )}
            {tabs.length === 0 && (
              <div className="panes-empty">
                <p>No tabs open.</p>
                <div className="panes-empty-actions">
                  <button className="panes-empty-btn primary" onClick={() => createTab('claude')}>
                    <IconPlus size={14} /> New Claude tab
                  </button>
                  <button className="panes-empty-btn" onClick={() => createTab('shell')}>
                    <IconTerminal size={14} /> New shell tab
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>

        {/* Kept mounted while closed (display:none, like TerminalPane) so ⌘M
            shows an already-populated panel instantly instead of remounting,
            refetching and flashing the empty state. */}
        {activeSpace && (
          <MemorySidebar
            open={memoryOpen}
            spaceId={activeSpace}
            spaces={spaces}
            notify={setToast}
            onOpen={openMemory}
            onOpenInternal={openInternal}
            onJumpPrompt={jumpToPrompt}
            onStartResize={startMemoryResize}
            onResizeKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault()
                resizeMemoryBy(e.shiftKey ? 40 : 12)
              } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                resizeMemoryBy(e.shiftKey ? -40 : -12)
              } else if (e.key === 'Home') {
                e.preventDefault()
                setMemoryWidth(MEMORY_MIN_WIDTH)
              } else if (e.key === 'End') {
                e.preventDefault()
                setMemoryWidth(memoryMaxWidth())
              }
            }}
          />
        )}
      </div>

      <Toast toast={toast} onUndo={undo} onDismiss={() => setToast(null)} />
      {settingsOpen && activeSpace && <SettingsPanel spaceId={activeSpace} onClose={() => setSettingsOpen(false)} />}
      {promptNode}
    </div>
  )
}
