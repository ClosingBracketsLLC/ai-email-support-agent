import { describe, expect, it } from 'vitest'
import { REFERENCES_CAP, buildReferences, tokenizeReferences } from '../src/threading.ts'

describe('buildReferences', () => {
  it('keeps the thread root and the newest CAP-1, parent guaranteed last', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`)
    const out = buildReferences(ids, '<parent@x>')
    expect(out).toHaveLength(REFERENCES_CAP)
    expect(out[0]).toBe('<m0@x>') // root survives — a tail slice was the reference's recorded bug
    expect(out.at(-1)).toBe('<parent@x>')
  })
  it('dedupes and skips nulls', () => {
    expect(buildReferences(['<a@x>', null, '<a@x>', '<b@x>'], '<b@x>')).toEqual(['<a@x>', '<b@x>'])
  })
})
describe('tokenizeReferences', () => {
  it('caps a hostile 10KB header at 20 tokens, newest last', () => {
    const header = Array.from({ length: 500 }, (_, i) => `<t${i}@x>`).join(' ')
    const out = tokenizeReferences(header)
    expect(out).toHaveLength(20)
    expect(out.at(-1)).toBe('<t499@x>')
  })
  it('returns [] for null', () => {
    expect(tokenizeReferences(null)).toEqual([])
  })
})
