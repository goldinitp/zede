import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { PtyDataEvent, PtyExitEvent } from '../src/shared/api'

let emitData: (event: PtyDataEvent) => void
let emitExit: (event: PtyExitEvent) => void

beforeAll(() => {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    zede: {
      pty: {
        onData(callback: (event: PtyDataEvent) => void) {
          emitData = callback
          return () => {}
        },
        onExit(callback: (event: PtyExitEvent) => void) {
          emitExit = callback
          return () => {}
        }
      }
    }
  })
})

describe('PTY event routing', () => {
  it('buffers data while paused and keeps event order', async () => {
    const { subscribePtyData } = await import('../src/renderer/src/terminal/ptyEvents')
    const chunks: string[] = []
    const subscription = subscribePtyData('tab-data', (event) => chunks.push(event.chunk))

    emitData({ tabId: 'tab-data', chunk: 'one' })
    expect(chunks).toEqual([])

    subscription.resume()
    emitData({ tabId: 'tab-data', chunk: 'two' })
    subscription.pause()
    emitData({ tabId: 'tab-data', chunk: 'three' })
    subscription.resume()

    expect(chunks).toEqual(['one', 'two', 'three'])
    subscription.dispose()
  })

  it('delivers a background exit when the tab resumes', async () => {
    const { subscribePtyExit } = await import('../src/renderer/src/terminal/ptyEvents')
    const exits: number[] = []
    const subscription = subscribePtyExit('tab-exit', (event) => exits.push(event.exitCode))

    emitExit({ tabId: 'tab-exit', exitCode: 7 })
    expect(exits).toEqual([])

    subscription.resume()
    expect(exits).toEqual([7])
    subscription.dispose()
  })
})
