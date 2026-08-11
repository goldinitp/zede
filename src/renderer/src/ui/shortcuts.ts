export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform)
}

export function isAppShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean
): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey
}

export function shellTabShortcut(isMac: boolean): string {
  return isMac ? '⌘T' : 'Ctrl+Shift+T'
}
