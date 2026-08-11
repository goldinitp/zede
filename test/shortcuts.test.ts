import { describe, expect, it } from 'vitest'
import { isAppShortcut, isMacPlatform, shellTabShortcut } from '../src/renderer/src/ui/shortcuts'

describe('app shortcuts', () => {
  it('uses Command on macOS', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isAppShortcut({ metaKey: true, ctrlKey: false, shiftKey: false }, true)).toBe(true)
    expect(shellTabShortcut(true)).toBe('⌘T')
  })

  it('requires Ctrl+Shift outside macOS', () => {
    expect(isMacPlatform('Win32')).toBe(false)
    expect(isAppShortcut({ metaKey: false, ctrlKey: true, shiftKey: false }, false)).toBe(false)
    expect(isAppShortcut({ metaKey: false, ctrlKey: true, shiftKey: true }, false)).toBe(true)
    expect(shellTabShortcut(false)).toBe('Ctrl+Shift+T')
  })
})
