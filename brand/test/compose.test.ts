import { describe, expect, it } from 'vitest'
import {
  ASCENDER, BASELINE, MARK_BOX, STEM, WORDMARK_BOX, fmt, lockupHorizontal, lockupStacked, ogImage, placeMark, tile, wrap,
} from '../scripts/compose.ts'
import { viewBox } from '../scripts/svg.ts'

const MARK = 'M42 102h1277v918H42z', WORD = 'M42 100h3383v920H42z'
const s = ASCENDER / (BASELINE - MARK_BOX.y0)              // 1484 / 898
const markW = (MARK_BOX.x1 - MARK_BOX.x0) * s               // 2110.32
const wordW = WORDMARK_BOX.x1 - WORDMARK_BOX.x0             // 3383

describe('placeMark', () => {
  it('puts the ink box\'s top-left at (x, y) and scales to the requested height', () => {
    const p = placeMark(MARK, '#000', 100, 50, 918)          // scale 1
    expect(p).toBe(`<path fill="#000" transform="translate(${fmt(100 - 42)} ${fmt(50 - 102)}) scale(1)" d="${MARK}"/>`)
    expect(placeMark(MARK, '#000', 0, 0, 459)).toContain('scale(0.5)')
  })
})

describe('lockupHorizontal', () => {
  const l = lockupHorizontal(MARK, WORD, '#2563EB', '#0F1B33')
  it('scales the mark so its top meets the ascender line while its baseline stays on the wordmark\'s', () => {
    expect(l.markTransform).toBe(`translate(${fmt(-MARK_BOX.x0 * s)} ${fmt(BASELINE * (1 - s))}) scale(${fmt(s)})`)
    expect(l.y).toBeCloseTo(BASELINE - ASCENDER, 6)          // -484: the ascender line in the y-down box
    expect(l.height).toBeCloseTo(ASCENDER + (MARK_BOX.y1 - BASELINE) * s, 4)   // down to the scaled overshoot
  })
  it('sets the wordmark one stem width to the right of the mark', () => {
    expect(l.wordmarkTransform).toBe(`translate(${fmt(markW + STEM - WORDMARK_BOX.x0)} 0)`)
    expect(l.width).toBeCloseTo(markW + STEM + wordW, 4)
    expect(viewBox(wrap(l))).toEqual([0, Number(fmt(l.y)), Number(fmt(l.width)), Number(fmt(l.height))])
  })
  it('colours the mark and the wordmark independently', () => {
    expect(l.body).toContain(`fill="#2563EB" transform="${l.markTransform}"`)
    expect(l.body).toContain(`fill="#0F1B33" transform="${l.wordmarkTransform}"`)
  })
})

describe('lockupStacked', () => {
  const l = lockupStacked(MARK, WORD, '#2563EB', '#0F1B33')
  it('centres the mark over the wordmark with a gap of half the mark\'s height', () => {
    const markH = (MARK_BOX.y1 - MARK_BOX.y0) * s
    expect(l.width).toBeCloseTo(wordW, 6)
    expect(l.height).toBeCloseTo(markH * 1.5 + (WORDMARK_BOX.y1 - WORDMARK_BOX.y0), 4)
    expect(l.body).toContain(placeMark(MARK, '#2563EB', (wordW - markW) / 2, 0, markH))
    expect(l.body).toContain(`translate(${fmt(-WORDMARK_BOX.x0)} ${fmt(markH * 1.5 - WORDMARK_BOX.y0)})`)
  })
})

describe('tile', () => {
  it('centres the mark at a height ratio over a background', () => {
    const t = wrap(tile(MARK, '#93B4FF', 1024, { height: 0.56 }, '#0B1220'))
    expect(viewBox(t)).toEqual([0, 0, 1024, 1024])
    expect(t).toContain('<rect width="1024" height="1024" fill="#0B1220"/>')
    const h = 1024 * 0.56, w = h * (1277 / 918)
    expect(t).toContain(placeMark(MARK, '#93B4FF', (1024 - w) / 2, (1024 - h) / 2, h))
  })
  it('centres the mark at a width ratio with no background', () => {
    const t = wrap(tile(MARK, '#2563EB', 64, { width: 0.92 }, null))
    expect(t).not.toContain('<rect')
    const w = 64 * 0.92, h = w / (1277 / 918)
    expect(t).toContain(placeMark(MARK, '#2563EB', (64 - w) / 2, (64 - h) / 2, h))
  })
})

describe('ogImage', () => {
  it('is 1200×630, night, with the horizontal lockup 640 wide and centred', () => {
    const og = ogImage(MARK, WORD, '#0B1220', '#93B4FF', '#EEF2F7', 640)
    expect(viewBox(wrap(og))).toEqual([0, 0, 1200, 630])
    expect(og.body).toContain('<rect width="1200" height="630" fill="#0B1220"/>')
    const l = lockupHorizontal(MARK, WORD, '#93B4FF', '#EEF2F7')
    const k = 640 / l.width
    expect(og.body).toContain(`<g transform="translate(${fmt((1200 - 640) / 2)} ${fmt((630 - l.height * k) / 2 - l.y * k)}) scale(${fmt(k)})">${l.body}</g>`)
  })
})
