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
  it('carries a whole-sentence cross-chunk overlap: as many trailing sentences of the previous piece as fit within `overlap` characters, at least one (phase-4 controller ruling, reversing fix review #7\'s single-sentence rule)', () => {
    // Distinct sentences (fix review #7): with the original fixture's IDENTICAL repeated sentence,
    // any overlap window would trivially "match". Each sentence is unique here, so the assertion
    // only passes if chunks[1] genuinely opens with chunks[0]'s actual trailing sentence(s).
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about topic ${i} in a fairly detailed and thorough way for our customers. `).join('')
    const chunks = chunkBlocks([b('paragraph', ['Long'], sentences)], { target: 1600, max: 3000, overlap: 200 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(3000)

    // Re-derive, from chunks[1] ALONE (not from chunker internals), the prefix formed by its own
    // leading whole sentences that together fit the 200-char overlap window — that is exactly what
    // the chunker carried over from the end of chunks[0], so chunks[0] must end with it.
    const chunk1Sentences = chunks[1]!.content.split(/(?<=[.!?])\s+/)
    let prefix = chunk1Sentences[0]!
    let sentenceCount = 1
    for (let i = 1; i < chunk1Sentences.length; i++) {
      const candidate = `${prefix} ${chunk1Sentences[i]}`
      if (candidate.length > 200) break
      prefix = candidate
      sentenceCount++
    }
    expect(chunks[0]!.content.endsWith(prefix)).toBe(true)
    // More than a single trailing sentence is carried here — this fixture's ~95-char sentences let
    // two fit within the 200-char window, distinguishing this from the old exactly-one-sentence rule.
    expect(sentenceCount).toBeGreaterThanOrEqual(2)
  })
  it('hard-splits a sentence longer than max and caps the chunk count', () => {
    const chunks = chunkBlocks([b('paragraph', [], 'x'.repeat(10_000))], { max: 3000, maxChunks: 2 })
    expect(chunks).toHaveLength(2)
    expect(chunks.every((c) => c.content.length <= 3000)).toBe(true)
  })
  it('a heading block always starts a new chunk, even a sibling heading with identical text/path (fix review #6)', () => {
    const chunks = chunkBlocks([b('heading', ['FAQ'], 'FAQ'), b('paragraph', ['FAQ'], 'one'), b('heading', ['FAQ'], 'FAQ'), b('paragraph', ['FAQ'], 'two')])
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.content).toBe('FAQ\n\none')
    expect(chunks[1]!.content).toBe('FAQ\n\ntwo')
  })
})
