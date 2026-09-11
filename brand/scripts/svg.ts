/** The two attributes the build and the tests read off a brand SVG. Regex on purpose: the sources are ours, single-root, attribute-quoted with `"`, and adding an XML parser for that would be a dependency in search of a job. */
export function allPathData(svg: string): string[] {
  return [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]!)
}

export function pathData(svg: string): string {
  const all = allPathData(svg)
  if (all.length !== 1) throw new Error(`expected exactly one <path>, found ${all.length}`)
  return all[0]!
}

export function viewBox(svg: string): [number, number, number, number] {
  const m = /\sviewBox="([^"]+)"/.exec(svg)
  if (!m) throw new Error('no viewBox')
  const parts = m[1]!.trim().split(/\s+/).map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) throw new Error(`bad viewBox ${m[1]}`)
  return parts as [number, number, number, number]
}

/** The bounding box of every coordinate in a path (on-curve AND control points). For the mark and the wordmark every extreme is an on-curve point, so this equals the true ink bounds — the sources test relies on that. Supports the absolute commands the derivation emits: M L Q H V Z. */
export function hullBounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  let x = 0, y = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const see = (px: number, py: number) => { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py) }
  for (const seg of d.split(/(?=[MLQHVZ])/)) {
    const cmd = seg[0]
    const n = (seg.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    if (cmd === 'M' || cmd === 'L') { x = n[0]!; y = n[1]! }
    else if (cmd === 'Q') { see(n[0]!, n[1]!); x = n[2]!; y = n[3]! }
    else if (cmd === 'H') { x = n[0]! }
    else if (cmd === 'V') { y = n[0]! }
    else if (cmd === 'Z') continue
    else throw new Error(`unsupported command ${cmd}`)
    see(x, y)
  }
  return { minX, minY, maxX, maxY }
}
