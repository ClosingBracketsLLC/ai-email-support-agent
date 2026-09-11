import { readFileSync } from 'node:fs'
import { BRAND } from '@aesa/contracts'
import { describe, expect, it } from 'vitest'
import { lockupHorizontal } from '../scripts/compose.ts'
import { allPathData, pathData } from '../scripts/svg.ts'

const BRAND_DIR = new URL('../', import.meta.url)
const read = (rel: string) => readFileSync(new URL(rel, BRAND_DIR), 'utf8')

describe('BRAND (packages/contracts/src/brand.ts) agrees with the sources', () => {
  it('carries tokens.json verbatim', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to exclude these two keys
    const { paths: _p, icons: _i, ...tokens } = BRAND
    expect(tokens).toEqual(JSON.parse(read('tokens.json')))
  })
  it('carries the mark and wordmark paths and boxes', () => {
    expect(BRAND.paths.mark).toEqual({ viewBox: '42 102 1277 918', d: pathData(read('mark.svg')) })
    expect(BRAND.paths.wordmark).toEqual({ viewBox: '42 100 3383 920', d: pathData(read('wordmark.svg')) })
  })
  it('carries the horizontal lockup\'s geometry, identical to lockup-horizontal.svg', () => {
    const l = lockupHorizontal(BRAND.paths.mark.d, BRAND.paths.wordmark.d, '#000', '#000')
    expect(BRAND.paths.lockupHorizontal).toEqual({ viewBox: l.viewBox, width: Number(l.width.toFixed(4)), height: Number(l.height.toFixed(4)), markTransform: l.markTransform, wordmarkTransform: l.wordmarkTransform })
  })
  it('carries the eight icons\' path lists', () => {
    expect(Object.keys(BRAND.icons)).toEqual(['activity', 'agent', 'approve', 'hold', 'inbox', 'reply', 'send', 'settings'])
    for (const name of Object.keys(BRAND.icons) as (keyof typeof BRAND.icons)[]) {
      expect([...BRAND.icons[name]]).toEqual(allPathData(read(`icons/${name}.svg`)))
    }
  })
})
