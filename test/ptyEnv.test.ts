import { describe, expect, it } from 'vitest'
import { terminalEnvironment } from '../src/main/pty/env'

describe('PTY environment', () => {
  it('removes host color suppression and keeps normal variables', () => {
    const env = terminalEnvironment({
      PATH: '/usr/bin',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CURSOR_AGENT: '1'
    })

    expect(env.PATH).toBe('/usr/bin')
    expect(env.NO_COLOR).toBeUndefined()
    expect(env.FORCE_COLOR).toBeUndefined()
    expect(env.CURSOR_AGENT).toBeUndefined()
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.TERM_PROGRAM).toBe('Zede')
  })
})
