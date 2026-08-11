const clearers = new Map<string, () => void>()

export function registerTerminalClear(tabId: string, clear: () => void): () => void {
  clearers.set(tabId, clear)
  return () => {
    if (clearers.get(tabId) === clear) clearers.delete(tabId)
  }
}

export function clearTerminal(tabId: string): boolean {
  const clear = clearers.get(tabId)
  if (!clear) return false
  clear()
  return true
}

export function quoteDroppedPath(path: string, isWindows: boolean): string {
  return isWindows ? `'${path.replace(/'/g, `''`)}'` : `'${path.replace(/'/g, `'\\''`)}'`
}
