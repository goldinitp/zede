import { describe, expect, it, vi } from 'vitest'
import { clearTerminal, quoteDroppedPath, registerTerminalClear } from '../src/renderer/src/terminal/actions'

describe('terminal actions', () => {
  it('routes clear to the active terminal registration', () => {
    const clear = vi.fn()
    const dispose = registerTerminalClear('tab-1', clear)

    expect(clearTerminal('tab-1')).toBe(true)
    expect(clear).toHaveBeenCalledOnce()

    dispose()
    expect(clearTerminal('tab-1')).toBe(false)
  })

  it('shell-quotes dropped paths', () => {
    expect(quoteDroppedPath('/tmp/my file.txt', false)).toBe("'/tmp/my file.txt'")
    expect(quoteDroppedPath("/tmp/user's file", false)).toBe("'/tmp/user'\\''s file'")
    expect(quoteDroppedPath("C:\\User's File.txt", true)).toBe("'C:\\User''s File.txt'")
  })
})
