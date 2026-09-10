import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../apps/app/src/', import.meta.url))
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}
const files = walk(SRC)

describe('the app follows the brand type and colour rules', () => {
  it('never sets fontWeight — each weight is a registered family (theme.ts `font`)', () => {
    const offenders = files.filter((f) => /fontWeight\s*:/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([])
  })
  it('never hard-codes a colour outside theme.ts', () => {
    const offenders = files.filter((f) => !f.endsWith('theme.ts') && /#[0-9a-fA-F]{6}\b|rgba?\(/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([])
  })
  it('never imports the icon font', () => {
    const offenders = files.filter((f) => /@expo\/vector-icons/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([])
  })
})
