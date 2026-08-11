import { describe, expect, it } from 'vitest'
import { newestPromptsFirst } from '../src/renderer/src/memory/prompts'

describe('prompt ordering', () => {
  const prompts = [
    { text: 'first question', ts: 1 },
    { text: 'second question', ts: 2 },
    { text: 'latest question', ts: 3 }
  ]

  it('shows the newest prompt first while keeping original indexes', () => {
    expect(newestPromptsFirst(prompts, '', 500)).toEqual([
      { text: 'latest question', ts: 3, idx: 2 },
      { text: 'second question', ts: 2, idx: 1 },
      { text: 'first question', ts: 1, idx: 0 }
    ])
  })

  it('filters before applying the visible limit', () => {
    expect(newestPromptsFirst(prompts, 'question', 2).map((prompt) => prompt.text)).toEqual([
      'latest question',
      'second question'
    ])
  })
})
