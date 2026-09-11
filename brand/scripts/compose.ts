/**
 * The brand's geometry, as pure string builders over the two source paths. Every number here has a
 * named origin: the ink boxes come from brand/mark.svg and brand/wordmark.svg (y-down, baseline at
 * y = 1000 — the box the spec's appendix uses), ASCENDER and STEM were measured on the Fraunces 144pt
 * SemiBold file in scripts/derive/ (see brand.md → Derivation), and the raster ratios live in tokens.json.
 * build.ts writes these out; the app draws the horizontal lockup from the SAME transforms via BRAND.
 */
export interface Box { x0: number; y0: number; x1: number; y1: number }
export const MARK_BOX: Box = { x0: 42, y0: 102, x1: 1319, y1: 1020 }
export const WORDMARK_BOX: Box = { x0: 42, y0: 100, x1: 3425, y1: 1020 }
export const BASELINE = 1000
/** Top of Fraunces' d/l/h/b above the baseline: the x-height (878) plus the ascender's rise (606). */
export const ASCENDER = 1484
/** The a's stem at mid x-height (240; the l measures 239 at every height). */
export const STEM = 240
export const MARK_ASPECT = (MARK_BOX.x1 - MARK_BOX.x0) / (MARK_BOX.y1 - MARK_BOX.y0)

/** Numbers in SVG text: at most four decimals, no trailing zeros, so the files are stable and short. */
export const fmt = (n: number): string => Number(n.toFixed(4)).toString()

export interface Composed { viewBox: string; body: string }
export interface Lockup extends Composed {
  x: number; y: number; width: number; height: number
  markTransform: string; wordmarkTransform: string
}

export function wrap(c: Composed): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${c.viewBox}">${c.body}</svg>\n`
}

/** The bare mark in one colourway, tight box. */
export function markSvg(markPath: string, fill: string): string {
  return wrap({ viewBox: `${MARK_BOX.x0} ${MARK_BOX.y0} ${MARK_BOX.x1 - MARK_BOX.x0} ${MARK_BOX.y1 - MARK_BOX.y0}`, body: `<path fill="${fill}" d="${markPath}"/>` })
}

/** The mark with its ink box's top-left at (x, y) and its ink height `h`, in the caller's coordinates. */
export function placeMark(markPath: string, fill: string, x: number, y: number, h: number): string {
  const k = h / (MARK_BOX.y1 - MARK_BOX.y0)
  return `<path fill="${fill}" transform="translate(${fmt(x - MARK_BOX.x0 * k)} ${fmt(y - MARK_BOX.y0 * k)}) scale(${fmt(k)})" d="${markPath}"/>`
}

/** Spec §2.2: the mark on the wordmark's baseline, its top on the ascender line, one stem width apart. Wordmark unscaled. */
export function lockupHorizontal(markPath: string, wordPath: string, markFill: string, wordFill: string): Lockup {
  const s = ASCENDER / (BASELINE - MARK_BOX.y0)
  const markW = (MARK_BOX.x1 - MARK_BOX.x0) * s
  const top = BASELINE - ASCENDER
  const bottom = BASELINE + (MARK_BOX.y1 - BASELINE) * s
  const markTransform = `translate(${fmt(-MARK_BOX.x0 * s)} ${fmt(BASELINE * (1 - s))}) scale(${fmt(s)})`
  const wordmarkTransform = `translate(${fmt(markW + STEM - WORDMARK_BOX.x0)} 0)`
  const width = markW + STEM + (WORDMARK_BOX.x1 - WORDMARK_BOX.x0)
  const height = bottom - top
  const body = `<path fill="${markFill}" transform="${markTransform}" d="${markPath}"/>`
    + `<path fill="${wordFill}" transform="${wordmarkTransform}" d="${wordPath}"/>`
  return { viewBox: `0 ${fmt(top)} ${fmt(width)} ${fmt(height)}`, body, x: 0, y: top, width, height, markTransform, wordmarkTransform }
}

/** Spec §2.2: the mark (same size as in the horizontal lockup) centred above the wordmark, gap = half the mark's height. */
export function lockupStacked(markPath: string, wordPath: string, markFill: string, wordFill: string): Lockup {
  const s = ASCENDER / (BASELINE - MARK_BOX.y0)
  const markW = (MARK_BOX.x1 - MARK_BOX.x0) * s
  const markH = (MARK_BOX.y1 - MARK_BOX.y0) * s
  const wordW = WORDMARK_BOX.x1 - WORDMARK_BOX.x0
  const wordH = WORDMARK_BOX.y1 - WORDMARK_BOX.y0
  const wordTop = markH * 1.5
  const cx = (wordW - markW) / 2
  // The same transform placeMark(markPath, markFill, cx, 0, markH) emits — spelled out so it can be returned.
  const markTransform = `translate(${fmt(cx - MARK_BOX.x0 * s)} ${fmt(-MARK_BOX.y0 * s)}) scale(${fmt(s)})`
  const wordmarkTransform = `translate(${fmt(-WORDMARK_BOX.x0)} ${fmt(wordTop - WORDMARK_BOX.y0)})`
  const body = `<path fill="${markFill}" transform="${markTransform}" d="${markPath}"/>`
    + `<path fill="${wordFill}" transform="${wordmarkTransform}" d="${wordPath}"/>`
  const height = wordTop + wordH
  return { viewBox: `0 0 ${fmt(wordW)} ${fmt(height)}`, body, x: 0, y: 0, width: wordW, height, markTransform, wordmarkTransform }
}

/** A square canvas with the mark centred at a height OR width ratio, over a background or transparent. */
export function tile(markPath: string, fill: string, size: number, fit: { height: number } | { width: number }, background: string | null): Composed {
  const h = 'height' in fit ? size * fit.height : (size * fit.width) / MARK_ASPECT
  const w = h * MARK_ASPECT
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ''
  return { viewBox: `0 0 ${size} ${size}`, body: bg + placeMark(markPath, fill, (size - w) / 2, (size - h) / 2, h) }
}

/** Spec §2.3: 1200×630, night, the horizontal lockup in lifted (mark) and paper (wordmark), centred at `lockupWidth`. */
export function ogImage(markPath: string, wordPath: string, background: string, markFill: string, wordFill: string, lockupWidth: number): Composed {
  const W = 1200, H = 630
  const l = lockupHorizontal(markPath, wordPath, markFill, wordFill)
  const k = lockupWidth / l.width
  const g = `<g transform="translate(${fmt((W - lockupWidth) / 2)} ${fmt((H - l.height * k) / 2 - l.y * k)}) scale(${fmt(k)})">${l.body}</g>`
  return { viewBox: `0 0 ${W} ${H}`, body: `<rect width="${W}" height="${H}" fill="${background}"/>` + g }
}
