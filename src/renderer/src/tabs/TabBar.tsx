import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { Space, Tab, TabKind } from '@shared/api'
import { IconClose, IconDoc, IconGlobe, IconHistory, IconLayers, IconPin, IconPlus, IconSparkle, IconTerminal } from '../ui/icons'
import { ContextMenu, type MenuEntry } from '../ui/ContextMenu'

interface Props {
  tabs: Tab[]
  activeId: string | null
  spaceName: string
  spaceIcon?: string | null
  spaces: Space[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCreate: (kind: TabKind) => void
  onTogglePin: (t: Tab) => void
  /** Persist a new order (pinned first, then unpinned). `pinnedChange` is set
   *  when the drag moved a tab across the pinned/unpinned boundary. */
  onReorder: (orderedIds: string[], pinnedChange?: { id: string; pinned: boolean }) => void
  /** Close every unpinned tab (pinned tabs are kept). */
  onCloseAll: () => void
  onRename: (t: Tab) => void
  onDuplicate: (t: Tab) => void
  onMove: (t: Tab, spaceId: string) => void
  /** Snapshot the tab's Claude conversation to a local JSON file. */
  onSaveConversation: (t: Tab) => void
  /** Build the "Saved conversations" picker entries (load / load & compact / delete). */
  loadSavedMenu: () => Promise<MenuEntry[]>
  onRenameSpace: () => void
  onChangeSpaceIcon: () => void
  onMakeDefaultSpace: () => void
  onRemoveSpace: () => void
}

const KindGlyph = ({ kind }: { kind: TabKind }) =>
  kind === 'shell' ? <IconTerminal /> : kind === 'memory' ? <IconLayers /> : kind === 'internal' ? <IconDoc /> : <IconSparkle />

/**
 * Build the next ordering when `dragId` is dropped onto `targetId` (before/after
 * it) or into empty space (append). The dragged tab joins the target's group —
 * dropping onto a pinned row pins it, onto an unpinned row unpins it — so pin
 * state is expressed purely by position (pinned rows sit at the top). Returns the
 * flat pinned-first id list plus any pin-state change to persist. Pure.
 */
function computeReorder(
  tabs: Tab[],
  dragId: string,
  targetId: string | null,
  after: boolean
): { orderedIds: string[]; pinnedChange?: { id: string; pinned: boolean } } {
  const wasPinned = tabs.find((t) => t.id === dragId)?.pinned ?? false
  const target = targetId ? tabs.find((t) => t.id === targetId) : null
  const willBePinned = target ? target.pinned : wasPinned

  const pinned = tabs.filter((t) => t.pinned && t.id !== dragId).map((t) => t.id)
  const unpinned = tabs.filter((t) => !t.pinned && t.id !== dragId).map((t) => t.id)
  const dest = willBePinned ? pinned : unpinned

  let idx = dest.length
  if (targetId && targetId !== dragId) {
    const i = dest.indexOf(targetId)
    if (i !== -1) idx = after ? i + 1 : i
  }
  dest.splice(idx, 0, dragId)

  return {
    orderedIds: [...pinned, ...unpinned],
    pinnedChange: wasPinned !== willBePinned ? { id: dragId, pinned: willBePinned } : undefined
  }
}

/**
 * The sidebar body of the "standard terminal" layout: a Space header, a New Tab
 * row, then the tabs as one flat list — pinned tabs sit at the top carrying a
 * small pin glyph, everything else below. Rows are draggable to reorder; drag a
 * row up among the pinned tabs (or down out of them) to pin / unpin it.
 */
export function TabBar({
  tabs,
  activeId,
  spaceName,
  spaceIcon,
  spaces,
  onSelect,
  onClose,
  onCreate,
  onTogglePin,
  onReorder,
  onRename,
  onDuplicate,
  onMove,
  onSaveConversation,
  loadSavedMenu,
  onRenameSpace,
  onChangeSpaceIcon,
  onMakeDefaultSpace,
  onRemoveSpace
}: Props) {
  // Pinned first, preserving each group's server order (stable sort).
  const ordered = [...tabs].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))

  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string | null; after: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)

  const openMenu = (e: { preventDefault: () => void; clientX: number; clientY: number }, items: MenuEntry[]): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const tabMenu = (t: Tab): MenuEntry[] => [
    { label: 'Rename…', onClick: () => onRename(t) },
    { label: 'Duplicate', onClick: () => onDuplicate(t) },
    { label: 'Copy working directory', onClick: () => navigator.clipboard?.writeText(t.cwd) },
    ...(t.kind === 'claude' || t.kind === 'shell'
      ? [{ label: 'Save conversation', hint: 'to local JSON', onClick: () => onSaveConversation(t) } as MenuEntry]
      : []),
    {
      label: 'Move to Space',
      disabled: spaces.filter((s) => s.id !== t.spaceId).length === 0,
      submenu: spaces
        .filter((s) => s.id !== t.spaceId)
        .map((s) => ({ label: `${s.icon || '🗂'}  ${s.name}`, onClick: () => onMove(t, s.id) }))
    },
    'separator',
    { label: t.pinned ? 'Unpin' : 'Pin', onClick: () => onTogglePin(t) },
    { label: t.pinned ? 'Close Tab (keeps pin)' : 'Close Tab', danger: !t.pinned, onClick: () => onClose(t.id) }
  ]
  // Anchor the picker under the button; grab the rect before the await — the
  // synthetic event's currentTarget is gone by the time the list resolves.
  const openSavedMenu = async (e: ReactMouseEvent<HTMLButtonElement>): Promise<void> => {
    const r = e.currentTarget.getBoundingClientRect()
    const items = await loadSavedMenu()
    setMenu({ x: r.left, y: r.bottom + 4, items })
  }
  const spaceMenu = (): MenuEntry[] => [
    { label: 'Make Default Space', onClick: onMakeDefaultSpace },
    { label: 'Rename Space…', onClick: onRenameSpace },
    { label: 'Change Icon…', onClick: onChangeSpaceIcon },
    'separator',
    { label: 'Delete Space', danger: true, disabled: spaces.length <= 1, onClick: onRemoveSpace }
  ]

  const startDrag = (e: DragEvent, id: string): void => {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', id)
    } catch {
      /* some platforms disallow setData outside trusted handlers */
    }
  }
  const endDrag = (): void => {
    setDragId(null)
    setOver(null)
  }
  const overItem = (e: DragEvent, id: string): void => {
    if (!dragId) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    setOver({ id, after: e.clientY > r.top + r.height / 2 })
  }
  const overZone = (e: DragEvent): void => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOver({ id: null, after: true })
  }
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    if (dragId && over && over.id !== dragId) {
      const { orderedIds, pinnedChange } = computeReorder(tabs, dragId, over.id, over.after)
      onReorder(orderedIds, pinnedChange)
    }
    endDrag()
  }
  const dropAttr = (id: string): 'before' | 'after' | undefined =>
    over && over.id === id ? (over.after ? 'after' : 'before') : undefined

  return (
    <div className="sb-body">
      <div
        className="sb-space"
        title={`${spaceName} — right-click to rename`}
        onContextMenu={(e) => openMenu(e, spaceMenu())}
        onDoubleClick={onRenameSpace}
      >
        <span className="sb-space-ico">{spaceIcon ? <span style={{ fontSize: 15 }}>{spaceIcon}</span> : <IconGlobe />}</span>
        <span className="sb-space-name">{spaceName || 'Space'}</span>
        <span className="sb-space-tag">Space</span>
      </div>

      <div className="sb-newtab-row">
        <button className="sb-newtab" title="New Claude tab (⌘T)" onClick={() => onCreate('claude')}>
          <IconPlus size={13} />
          New Tab
          <span className="sb-newtab-hint">⌘T</span>
        </button>
        <button className="sb-newtab-icon" title="New shell tab" onClick={() => onCreate('shell')}>
          <IconTerminal size={13} />
        </button>
        <button className="sb-newtab-icon" title="Saved conversations" onClick={openSavedMenu}>
          <IconHistory size={13} />
        </button>
      </div>

      <div className="sb-tabs" onDragOver={overZone} onDrop={drop}>
        {ordered.map((t) => (
          <div
            key={t.id}
            className={`sb-tab${t.id === activeId ? ' active' : ''}${dragId === t.id ? ' dragging' : ''}`}
            data-kind={t.kind}
            data-drop={dropAttr(t.id)}
            draggable
            onDragStart={(e) => startDrag(e, t.id)}
            onDragEnd={endDrag}
            onDragOver={(e) => overItem(e, t.id)}
            onDrop={drop}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => e.button === 1 && onClose(t.id)}
            onContextMenu={(e) => openMenu(e, tabMenu(t))}
            title={`${t.kind} · ${t.cwd} — drag to reorder or pin, right-click for options`}
          >
            <span className="sb-tab-ico" data-kind={t.kind}>
              <KindGlyph kind={t.kind} />
            </span>
            <span className="sb-tab-title">{t.title}</span>
            {t.pinned && (
              <span className="sb-tab-pin" title="Pinned">
                <IconPin size={11} />
              </span>
            )}
            <button
              className="sb-tab-btn"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              <IconClose size={13} />
            </button>
          </div>
        ))}
        {tabs.length === 0 && <div className="sb-tab-empty">No tabs yet. Open a Claude or shell tab to get started.</div>}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
