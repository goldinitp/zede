// Imperative bridge from the sidebar's Prompts section to a TerminalPane's
// xterm buffer: React state can't reach the buffer, so each pane registers a
// jumper keyed by tabId and the sidebar asks for a scroll-to-prompt by tab.

type PromptJumper = (text: string, occurrence: number) => boolean

const jumpers = new Map<string, PromptJumper>()

export function registerPromptJumper(tabId: string, fn: PromptJumper): () => void {
  jumpers.set(tabId, fn)
  return () => {
    if (jumpers.get(tabId) === fn) jumpers.delete(tabId)
  }
}

/** Scroll the tab's terminal to the occurrence-th echo of the prompt.
 *  False = pane not mounted or the prompt is no longer in the scrollback. */
export function jumpTerminalToPrompt(tabId: string, text: string, occurrence: number): boolean {
  return jumpers.get(tabId)?.(text, occurrence) ?? false
}

/** The buffer-searchable core of a prompt: its first line, capped so terminal
 *  re-wrapping can't split the needle across rows. Shared by the pane's buffer
 *  search and the sidebar's occurrence counting so both agree on identity. */
export function promptNeedle(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim().slice(0, 24).trimEnd()
}
