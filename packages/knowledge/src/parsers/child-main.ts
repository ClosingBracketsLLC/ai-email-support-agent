import { readFileSync, statSync } from 'node:fs'
import type { ParseLimits } from '../bounds.ts'
import { ParseError } from '../bounds.ts'
import type { Block } from './blocks.ts'
import { parseDocx } from './docx.ts'
import { parsePdf } from './pdf.ts'

/** The parser child's forked entry point: reads exactly one IPC message, parses the file it
 * names, and replies with either `{ blocks }` or `{ error, message }` before exiting. Never logs —
 * the child's stdout/stderr are piped and discarded by the parent, but a bounded, single-purpose
 * process that talks only over IPC should stay silent regardless. */
type ChildInput = { kind: 'pdf' | 'docx'; path: string; limits: ParseLimits }
type ChildReply = { blocks: Block[] } | { error: string; message?: string }

function toReply(err: unknown): ChildReply {
  if (err instanceof ParseError) return { error: err.code, message: err.message }
  return { error: 'parse_failed', message: err instanceof Error ? err.message : String(err) }
}

process.once('message', (input: ChildInput) => {
  void run(input)
})

async function run(input: ChildInput): Promise<void> {
  let reply: ChildReply
  try {
    const size = statSync(input.path).size
    if (size > input.limits.maxBytes) {
      reply = { error: 'too_large', message: `file is ${size} bytes, over the ${input.limits.maxBytes}-byte limit` }
    } else {
      const bytes = new Uint8Array(readFileSync(input.path))
      const blocks = input.kind === 'pdf' ? await parsePdf(bytes, input.limits) : await parseDocx(bytes, input.limits)
      reply = { blocks }
    }
  } catch (err) {
    reply = toReply(err)
  }
  // `process.send` is asynchronous — a reply that doesn't fit the IPC socket's buffer in one write
  // is still draining when a bare `process.exit(0)` on the next line tears the process down, and
  // the parent sees an `exit` with no `message` ever having arrived. Exit only once the callback
  // confirms the write landed.
  if (process.send) process.send(reply, () => process.exit(0))
  else process.exit(0)
}
