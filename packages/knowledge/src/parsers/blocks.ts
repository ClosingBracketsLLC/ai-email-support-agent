/** One structural unit of a parsed document: a heading (which also extends the heading path for
 * everything that follows it), a paragraph, a bulleted/numbered list, a table row group, or a
 * code block. `headingPath` is the stack of ancestor heading texts the block sits under. */
export interface Block {
  headingPath: string[]
  text: string
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'code'
}

/** Collapse all whitespace runs to a single space, drop a space landing immediately before a
 * punctuation mark (an artifact of html.ts's `<a>` word-boundary spacing landing right next to
 * source punctuation — "policy , then" should read "policy, then"), and trim the ends. No Unicode
 * normalization. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim()
}

/** Push a new heading onto the path at `level` (1-6): ancestors deeper than `level - 1` are
 * dropped, the new heading text is appended, and the result is capped at 6 entries. */
export function pushHeading(path: string[], level: number, text: string): string[] {
  const truncated = path.slice(0, Math.max(level - 1, 0))
  return [...truncated, text].slice(0, 6)
}

/** Drop whole blocks off the END of `blocks` until the combined `text` fits `maxChars`, reporting
 * whether anything was dropped. A single first block that alone exceeds the ceiling is sliced to
 * it rather than dropped, so a one-block document never comes back empty (which the parsers would
 * read as `no_text`). Used by the parser child to bound its IPC reply (final review A3) — the
 * parent has to buffer and `JSON.parse` whatever the child sends in one string. */
export function capBlockText(blocks: Block[], maxChars: number): { blocks: Block[]; truncated: boolean } {
  let used = 0
  const kept: Block[] = []
  for (const block of blocks) {
    if (used + block.text.length > maxChars) {
      const room = maxChars - used
      if (kept.length === 0 && room > 0) kept.push({ ...block, text: block.text.slice(0, room) })
      return { blocks: kept, truncated: true }
    }
    kept.push(block)
    used += block.text.length
  }
  return { blocks: kept, truncated: false }
}
