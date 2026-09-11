import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PARSE_LIMITS, runParserInChild } from '../src/index.ts'
import { largeDocx, minimalPdf } from './fixtures.ts'

describe('runParserInChild', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aesa-knowledge-'))
  it('round-trips a large DOCX reply without losing data to the send/exit race', async () => {
    const path = join(dir, 'large.docx'); writeFileSync(path, await largeDocx(400, 600))
    const blocks = await runParserInChild({ kind: 'docx', path, limits: DEFAULT_PARSE_LIMITS })
    expect(blocks).toHaveLength(400)
  }, 20_000)
  it('parses a PDF in a forked process and returns its blocks', async () => {
    const path = join(dir, 'ok.pdf'); writeFileSync(path, minimalPdf(['Returns within 30 days.']))
    const blocks = await runParserInChild({ kind: 'pdf', path, limits: DEFAULT_PARSE_LIMITS })
    expect(blocks.map((b) => b.text).join(' ')).toContain('Returns within 30 days.')
  })
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
