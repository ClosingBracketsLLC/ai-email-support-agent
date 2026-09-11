import { readFileSync, readdirSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import { allPathData, hullBounds, pathData, viewBox } from '../scripts/svg.ts'

const BRAND = new URL('../', import.meta.url)
const read = (rel: string) => readFileSync(new URL(rel, BRAND), 'utf8')

describe('brand/mark.svg', () => {
  const mark = read('mark.svg')
  it('is the derivation\'s path, byte for byte, in azure', () => {
    expect(pathData(mark)).toBe(pathData(read('scripts/derive/mark-derived.svg')))
    expect(mark).toContain('fill="#2563EB"')
  })
  it('has the tight ink box as its viewBox and only M/L/Q/H/V/Z commands', () => {
    expect(viewBox(mark)).toEqual([42, 102, 1277, 918])
    expect(hullBounds(pathData(mark))).toEqual({ minX: 42, minY: 102, maxX: 1319, maxY: 1020 })
    expect(pathData(mark).replace(/[^A-Za-z]/g, '').replace(/[MLQHVZ]/g, '')).toBe('')
  })
})

describe('brand/wordmark.svg', () => {
  const word = read('wordmark.svg')
  it('is the derivation\'s path, byte for byte, in ink', () => {
    expect(pathData(word)).toBe(pathData(read('scripts/derive/wordmark-derived.svg')))
    expect(word).toContain('fill="#0F1B33"')
  })
  it('has the tight ink box as its viewBox (aesa at −0.5% tracking)', () => {
    expect(viewBox(word)).toEqual([42, 100, 3383, 920])
    expect(hullBounds(pathData(word))).toEqual({ minX: 42, minY: 100, maxX: 3425, maxY: 1020 })
  })
})

describe('brand/icons', () => {
  const names = readdirSync(new URL('icons/', BRAND)).filter((f) => f.endsWith('.svg')).sort()
  it('is exactly the eight product icons', () => {
    expect(names).toEqual(['activity.svg', 'agent.svg', 'approve.svg', 'hold.svg', 'inbox.svg', 'reply.svg', 'send.svg', 'settings.svg'])
  })
  it.each(names)('%s: 24 grid, 2 stroke, round caps/joins, no fill, <path> children only', (name) => {
    const svg = read(`icons/${name}`)
    expect(svg).toContain('viewBox="0 0 24 24"')
    for (const attr of ['fill="none"', 'stroke="currentColor"', 'stroke-width="2"', 'stroke-linecap="round"', 'stroke-linejoin="round"']) expect(svg).toContain(attr)
    const inner = svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    const tags = [...inner.matchAll(/<(\w+)/g)].map((m) => m[1])
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.every((t) => t === 'path')).toBe(true)
    expect(allPathData(svg).every((d) => d.trim().length > 0)).toBe(true)
  })
})

describe('every SVG under brand/ parses in the renderer', () => {
  const files = [
    'mark.svg', 'wordmark.svg', 'scripts/derive/mark-derived.svg', 'scripts/derive/wordmark-derived.svg',
    ...readdirSync(new URL('icons/', BRAND)).filter((f) => f.endsWith('.svg')).map((f) => `icons/${f}`),
  ]
  it.each(files)('%s', (rel) => {
    const img = new Resvg(read(rel), { font: { loadSystemFonts: false } })
    expect(img.width).toBeGreaterThan(0)
    expect(img.height).toBeGreaterThan(0)
  })
})
