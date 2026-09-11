import { describe, expect, it } from 'vitest'
import { chunkBlocks, type Block } from '../src/index.ts'

const b = (kind: Block['kind'], path: string[], text: string): Block => ({ kind, headingPath: path, text })

describe('chunkBlocks', () => {
  it('merges small blocks under one heading into one chunk and carries the heading path', () => {
    const chunks = chunkBlocks([b('heading', ['Returns'], 'Returns'), b('paragraph', ['Returns'], 'Within 30 days.'), b('list', ['Returns'], '• Sale items\n• Gift cards')])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ ordinal: 0, headingPath: ['Returns'] })
    expect(chunks[0]!.content).toBe('Returns\n\nWithin 30 days.\n\n• Sale items\n• Gift cards')
    expect(chunks[0]!.tokenCount).toBe(Math.ceil(chunks[0]!.content.length / 4))
  })
  it('starts a new chunk when the heading path changes', () => {
    const chunks = chunkBlocks([b('paragraph', ['A'], 'a'), b('paragraph', ['B'], 'b')])
    expect(chunks.map((c) => c.headingPath)).toEqual([['A'], ['B']])
  })
  it('splits a long block at sentence boundaries with a 200-character overlap and never exceeds max', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog near the river bank today. '
    const chunks = chunkBlocks([b('paragraph', ['Long'], sentence.repeat(60))], { target: 1600, max: 3000, overlap: 200 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(3000)
    expect(chunks[1]!.content.startsWith(chunks[0]!.content.slice(-200).trimStart().split('. ').slice(-1)[0]!.slice(0, 20))).toBe(true)
  })
  it('hard-splits a sentence longer than max and caps the chunk count', () => {
    const chunks = chunkBlocks([b('paragraph', [], 'x'.repeat(10_000))], { max: 3000, maxChunks: 2 })
    expect(chunks).toHaveLength(2)
    expect(chunks.every((c) => c.content.length <= 3000)).toBe(true)
  })
})
