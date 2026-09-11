import { type Block, collapse } from './blocks.ts'

/** Plain text: one paragraph per blank-line-separated run (two or more consecutive newlines),
 * whitespace collapsed within each run. A single line break stays inside its paragraph. */
export function parseText(text: string): Block[] {
  const runs = text.split(/\n\s*\n+/)
  const blocks: Block[] = []
  for (const run of runs) {
    const collapsed = collapse(run)
    if (collapsed.length > 0) blocks.push({ kind: 'paragraph', headingPath: [], text: collapsed })
  }
  return blocks
}
