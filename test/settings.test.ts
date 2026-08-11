import { describe, expect, it } from 'vitest'
import { normalizeSettingsPatch, normalizeSettingValue } from '../src/main/settings'

describe('settings validation', () => {
  it('clamps numeric settings', () => {
    expect(normalizeSettingValue('scrollback', '999999999')).toBe('50000')
    expect(normalizeSettingValue('fontSize', '-1')).toBe('9')
    expect(normalizeSettingValue('bgOpacity', '2')).toBe('1')
  })

  it('rejects unknown keys and invalid enum values', () => {
    expect(normalizeSettingValue('cursorStyle', 'sideways')).toBeUndefined()
    expect(normalizeSettingsPatch({ syncGhToken: 'secret', cursorStyle: 'sideways' } as never)).toEqual({})
  })
})
