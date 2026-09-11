import { describe, expect, it } from 'vitest'
import { createHashEmbedder } from '../src/index.ts'

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)
describe('createHashEmbedder', () => {
  const e = createHashEmbedder()
  it('is deterministic, unit-length, 1024-dim, and reports estimated tokens', async () => {
    const a = await e.embed(['returns within 30 days'], 'document')
    const b = await e.embed(['returns within 30 days'], 'query')
    expect(a.vectors[0]).toEqual(b.vectors[0]); expect(a.vectors[0]).toHaveLength(1024)
    expect(Math.sqrt(cosine(a.vectors[0]!, a.vectors[0]!))).toBeCloseTo(1, 6)
    expect(a.tokens).toBe(Math.ceil('returns within 30 days'.length / 4))
    expect(e.model).toBe('hash-v1')
  })
  it('scores lexical overlap: a paraphrase with shared nouns beats an unrelated sentence', async () => {
    const [q, near, far] = (await e.embed(['how long do I have to return an item', 'returns are accepted within 30 days of delivery', 'we ship worldwide with tracked parcels'], 'document')).vectors
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!))
  })
})
