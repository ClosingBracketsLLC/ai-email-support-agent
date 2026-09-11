import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capBlockText, DEFAULT_PARSE_LIMITS, MAX_PARSED_TEXT_CHARS, runParserInChild } from '../src/index.ts'
import { largeDocx, minimalPdf } from './fixtures.ts'

describe('runParserInChild', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aesa-knowledge-'))
  it('round-trips a large DOCX reply without losing data to the send/exit race', async () => {
    const path = join(dir, 'large.docx'); writeFileSync(path, await largeDocx(400, 600))
    const { blocks, truncated } = await runParserInChild({ kind: 'docx', path, limits: DEFAULT_PARSE_LIMITS })
    expect(blocks).toHaveLength(400)
    expect(truncated).toBe(false)
  }, 20_000)
  it('parses a PDF in a forked process and returns its blocks', async () => {
    const path = join(dir, 'ok.pdf'); writeFileSync(path, minimalPdf(['Returns within 30 days.']))
    const { blocks } = await runParserInChild({ kind: 'pdf', path, limits: DEFAULT_PARSE_LIMITS })
    expect(blocks.map((b) => b.text).join(' ')).toContain('Returns within 30 days.')
  })
  // A3: the reply is capped in the CHILD, before `process.send`. Driven here with a tiny
  // `maxTextChars` rather than a real 6 MB document — the ceiling is `limits.maxTextChars`, so a
  // 20-character cap exercises exactly the code path a 6,000,000-character one would, in a
  // fraction of the time. The unit test below covers the ceiling's own arithmetic.
  it('caps the child reply at maxTextChars and reports truncated', async () => {
    const path = join(dir, 'capped.docx'); writeFileSync(path, await largeDocx(400, 600))
    const { blocks, truncated } = await runParserInChild({ kind: 'docx', path, limits: { ...DEFAULT_PARSE_LIMITS, maxTextChars: 20 } })
    expect(truncated).toBe(true)
    expect(blocks.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(20)
    expect(blocks.length).toBeGreaterThan(0)
  }, 20_000)

  it('kills a child that exceeds the wall clock and reports parse_timeout', async () => {
    const path = join(dir, 'slow.pdf'); writeFileSync(path, minimalPdf(['x']))
    await expect(runParserInChild({ kind: 'pdf', path, limits: { ...DEFAULT_PARSE_LIMITS, timeoutMs: 1 } })).rejects.toMatchObject({ code: 'parse_timeout' })
  }, 15_000)
  it('reports parse_failed for garbage bytes and too_large for a file over maxBytes', async () => {
    const garbage = join(dir, 'garbage.pdf'); writeFileSync(garbage, 'not a pdf at all')
    await expect(runParserInChild({ kind: 'pdf', path: garbage, limits: DEFAULT_PARSE_LIMITS })).rejects.toMatchObject({ code: 'parse_failed' })
    await expect(runParserInChild({ kind: 'pdf', path: garbage, limits: { ...DEFAULT_PARSE_LIMITS, maxBytes: 4 } })).rejects.toMatchObject({ code: 'too_large' })
  })
})

describe('capBlockText', () => {
  const block = (text: string) => ({ headingPath: [], text, kind: 'paragraph' as const })

  it('truncates a block list that runs past the 6,000,000-character ceiling and marks it truncated', () => {
    expect(MAX_PARSED_TEXT_CHARS).toBe(6_000_000)
    // 7 × 1 MB: the first six fit, the seventh crosses the ceiling and takes the rest with it.
    const oversized = Array.from({ length: 7 }, () => block('x'.repeat(1_000_000)))
    const capped = capBlockText(oversized, MAX_PARSED_TEXT_CHARS)
    expect(capped.truncated).toBe(true)
    expect(capped.blocks).toHaveLength(6)
    expect(capped.blocks.reduce((n, b) => n + b.text.length, 0)).toBe(6_000_000)
  })

  it('passes a list that fits through untouched, and slices a single over-ceiling block rather than returning nothing', () => {
    const fits = [block('a'), block('b')]
    expect(capBlockText(fits, 100)).toEqual({ blocks: fits, truncated: false })
    const one = capBlockText([block('abcdef'), block('ghi')], 4)
    expect(one).toEqual({ blocks: [{ headingPath: [], text: 'abcd', kind: 'paragraph' }], truncated: true })
  })
})
