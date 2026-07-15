// Shared IPC channel names + payload types, imported by both preload and main.
// This is the typed seam the renderer is allowed to touch (spec §4.2).
// Grows as spikes land: pty.*, memory.*, space.*, tab.*.

export const IPC = {
  ping: 'ping'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
