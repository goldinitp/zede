import type { PtyDataEvent, PtyExitEvent } from '@shared/api'

type DataCallback = (event: PtyDataEvent) => void
type ExitCallback = (event: PtyExitEvent) => void

interface Subscription<T> {
  callback: T
  active: boolean
}

export interface PausableSubscription {
  pause(): void
  resume(): void
  dispose(): void
}

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const BUFFER_TTL_MS = 10 * 60 * 1000
const dataSubscribers = new Map<string, Set<Subscription<DataCallback>>>()
const exitSubscribers = new Map<string, Set<Subscription<ExitCallback>>>()
const bufferedData = new Map<string, { chunks: string[]; bytes: number }>()
const bufferedExits = new Map<string, PtyExitEvent>()
const bufferExpiry = new Map<string, number>()
let offData: (() => void) | null = null
let offExit: (() => void) | null = null

function deliver<T>(subscriber: Subscription<(event: T) => void>, event: T): void {
  try {
    subscriber.callback(event)
  } catch (error) {
    console.error('[pty-events] subscriber failed', error)
  }
}

function bufferData(event: PtyDataEvent): void {
  const buffered = bufferedData.get(event.tabId) ?? { chunks: [], bytes: 0 }
  buffered.chunks.push(event.chunk)
  buffered.bytes += event.chunk.length * 2
  while (buffered.bytes > MAX_BUFFERED_BYTES && buffered.chunks.length > 1) {
    const dropped = buffered.chunks.shift() as string
    buffered.bytes -= dropped.length * 2
  }
  bufferedData.set(event.tabId, buffered)
}

function scheduleExpiry(tabId: string): void {
  const prior = bufferExpiry.get(tabId)
  if (prior) window.clearTimeout(prior)
  bufferExpiry.set(
    tabId,
    window.setTimeout(() => {
      bufferedData.delete(tabId)
      bufferedExits.delete(tabId)
      bufferExpiry.delete(tabId)
    }, BUFFER_TTL_MS)
  )
}

function clearExpiry(tabId: string): void {
  const timer = bufferExpiry.get(tabId)
  if (timer) window.clearTimeout(timer)
  bufferExpiry.delete(tabId)
}

/** One context-bridge listener routes by tab. Paused or temporarily unmounted
 * panes retain a bounded output backlog, preserving Space-switch continuity
 * without parsing/redrawing invisible terminals. */
export function subscribePtyData(tabId: string, callback: DataCallback): PausableSubscription {
  let subscribers = dataSubscribers.get(tabId)
  if (!subscribers) {
    subscribers = new Set()
    dataSubscribers.set(tabId, subscribers)
  }
  const subscription: Subscription<DataCallback> = { callback, active: false }
  subscribers.add(subscription)
  if (!offData) {
    offData = window.zede.pty.onData((event) => {
      const subscribers = dataSubscribers.get(event.tabId)
      let delivered = false
      for (const subscriber of subscribers ?? []) {
        if (!subscriber.active) continue
        deliver(subscriber, event)
        delivered = true
      }
      if (!delivered) {
        bufferData(event)
      }
    })
  }
  return {
    pause: () => {
      subscription.active = false
    },
    resume: () => {
      if (subscription.active) return
      subscription.active = true
      const buffered = bufferedData.get(tabId)
      bufferedData.delete(tabId)
      clearExpiry(tabId)
      if (buffered?.chunks.length) deliver(subscription, { tabId, chunk: buffered.chunks.join('') })
    },
    dispose: () => {
      const current = dataSubscribers.get(tabId)
      if (!current?.delete(subscription)) return
      if (!current.size) dataSubscribers.delete(tabId)
    }
  }
}

export function subscribePtyExit(tabId: string, callback: ExitCallback): PausableSubscription {
  let subscribers = exitSubscribers.get(tabId)
  if (!subscribers) {
    subscribers = new Set()
    exitSubscribers.set(tabId, subscribers)
  }
  const subscription: Subscription<ExitCallback> = { callback, active: false }
  subscribers.add(subscription)
  if (!offExit) {
    offExit = window.zede.pty.onExit((event) => {
      const subscribers = exitSubscribers.get(event.tabId)
      let delivered = false
      for (const subscriber of subscribers ?? []) {
        if (!subscriber.active) continue
        deliver(subscriber, event)
        delivered = true
      }
      if (!delivered) {
        bufferedExits.set(event.tabId, event)
        // Mounted-but-paused tabs must retain their exit indefinitely. Only an
        // unmounted/orphaned tab needs eventual cleanup.
        if (!subscribers?.size) scheduleExpiry(event.tabId)
      }
    })
  }
  return {
    pause: () => {
      subscription.active = false
    },
    resume: () => {
      if (subscription.active) return
      subscription.active = true
      const buffered = bufferedExits.get(tabId)
      bufferedExits.delete(tabId)
      clearExpiry(tabId)
      if (buffered) deliver(subscription, buffered)
    },
    dispose: () => {
      const current = exitSubscribers.get(tabId)
      if (!current?.delete(subscription)) return
      if (!current.size) exitSubscribers.delete(tabId)
    }
  }
}
