/** One structural unit of a parsed document: a heading (which also extends the heading path for
 * everything that follows it), a paragraph, a bulleted/numbered list, a table row group, or a
 * code block. `headingPath` is the stack of ancestor heading texts the block sits under. */
export interface Block {
  headingPath: string[]
  text: string
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'code'
}

/** Collapse all whitespace runs to a single space and trim the ends. No Unicode normalization. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Push a new heading onto the path at `level` (1-6): ancestors deeper than `level - 1` are
 * dropped, the new heading text is appended, and the result is capped at 6 entries. */
export function pushHeading(path: string[], level: number, text: string): string[] {
  const truncated = path.slice(0, Math.max(level - 1, 0))
  return [...truncated, text].slice(0, 6)
}
