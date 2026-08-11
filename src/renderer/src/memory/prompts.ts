import type { ChatPrompt } from '@shared/api'

export type IndexedPrompt = ChatPrompt & { idx: number }

export function newestPromptsFirst(prompts: ChatPrompt[], query: string, limit: number): IndexedPrompt[] {
  const normalized = query.trim().toLowerCase()
  return prompts
    .map((prompt, idx) => ({ ...prompt, idx }))
    .filter((prompt) => !normalized || prompt.text.toLowerCase().includes(normalized))
    .slice(-limit)
    .reverse()
}
