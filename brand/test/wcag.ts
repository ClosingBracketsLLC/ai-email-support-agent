/** WCAG 2.x relative luminance and contrast ratio over the token strings tokens.json uses (`#RRGGBB` or `rgba(r,g,b,a)`). */
export type Rgb = [number, number, number]

export function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 }
  }
  const rgba = /^rgba\((\d+),(\d+),(\d+),(0?\.\d+|1|0)\)$/.exec(value.replace(/\s/g, ''))
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) }
  throw new Error(`unparseable colour: ${value}`)
}

/** `fg` (possibly translucent) composited over an opaque `bg`. */
export function over(fg: string, bg: Rgb): Rgb {
  const f = parseColor(fg)
  return f.rgb.map((c, i) => Math.round(c * f.alpha + bg[i]! * (1 - f.alpha))) as Rgb
}

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Contrast of `text` on `background`, where a translucent background is first laid over the theme `ground` (paper or night). */
export function contrast(text: string, background: string, ground: string): number {
  const bg = over(background, parseColor(ground).rgb)
  const fg = over(text, bg)
  const [a, b] = [luminance(fg), luminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export const round2 = (n: number): number => Math.round(n * 100) / 100
