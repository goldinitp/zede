import { useState } from 'react'
import type { Space } from '@shared/api'
import { IconPlus } from '../ui/icons'
import { ContextMenu, type MenuEntry } from '../ui/ContextMenu'

interface Props {
  spaces: Space[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (s: Space) => void
  onChangeIcon: (s: Space) => void
  onMakeDefault: (s: Space) => void
  onRemove: (s: Space) => void
}

/**
 * Bottom-of-sidebar Space switcher (Arc's space dots). Click to switch;
 * double-click to rename; right-click for the full options menu. The default
 * Space (opened on launch) is marked with a ★.
 */
export function SpacesRail({ spaces, activeId, onSelect, onCreate, onRename, onChangeIcon, onMakeDefault, onRemove }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)

  const openMenu = (e: React.MouseEvent, s: Space): void => {
    e.preventDefault()
    const items: MenuEntry[] = [
      { label: 'New Space', onClick: onCreate },
      'separator',
      { label: s.isDefault ? 'Default Space ✓' : 'Make Default Space', disabled: s.isDefault, onClick: () => onMakeDefault(s) },
      { label: 'Rename…', onClick: () => onRename(s) },
      { label: 'Change Icon…', onClick: () => onChangeIcon(s) },
      'separator',
      { label: 'Delete Space', danger: true, disabled: spaces.length <= 1, onClick: () => onRemove(s) }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  return (
    <div className="sb-foot">
      <span className="sb-foot-brand" title="Zede">
        🧵
      </span>
      <div className="sb-spaces">
        {spaces.map((s) => (
          <button
            key={s.id}
            className={`sb-sdot${s.id === activeId ? ' active' : ''}${s.isDefault ? ' is-default' : ''}`}
            title={`${s.name}${s.isDefault ? ' · default' : ''} — right-click for options`}
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => onRename(s)}
            onContextMenu={(e) => openMenu(e, s)}
          >
            {s.icon || s.name.slice(0, 1).toUpperCase()}
          </button>
        ))}
      </div>
      <button className="sb-space-add" title="New Space" onClick={onCreate}>
        <IconPlus />
      </button>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
