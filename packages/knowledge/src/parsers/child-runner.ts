import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ParseError, type ParseLimits } from '../bounds.ts'
import type { Block } from './blocks.ts'

const CHILD = fileURLToPath(new URL('./child-main.ts', import.meta.url))

/** The loader flag the child needs to run a .ts entry: inherited when the parent already runs under tsx, added otherwise (vitest transforms in-process, so its execArgv carries none). */
function childExecArgv(maxHeapMb: number): string[] {
  const inherited = process.execArgv.filter((a) => !a.startsWith('--max-old-space-size'))
  const hasTsx = inherited.some((a) => a.includes('tsx'))
  return [...inherited, ...(hasTsx ? [] : ['--import', 'tsx']), `--max-old-space-size=${maxHeapMb}`]
}

export function runParserInChild(input: { kind: 'pdf' | 'docx'; path: string; limits: ParseLimits }): Promise<Block[]> {
  return new Promise((resolve, reject) => {
    // stderr is 'ignore', not 'pipe': an unread stderr pipe fills its OS buffer once the child
    // writes enough to it and blocks the child on the next write — a hang vector for no benefit,
    // since nothing here ever reads child.stderr.
    const child = fork(CHILD, [], { execArgv: childExecArgv(input.limits.maxHeapMb), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' })
    let settled = false
    const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn() } }
    const timer = setTimeout(() => { child.kill('SIGKILL'); settle(() => reject(new ParseError('parse_timeout', `parser exceeded ${input.limits.timeoutMs} ms`))) }, input.limits.timeoutMs)
    child.once('message', (msg: { blocks?: Block[]; error?: string; message?: string }) => {
      settle(() => msg.blocks ? resolve(msg.blocks) : reject(new ParseError((msg.error ?? 'parse_failed') as ParseError['code'], msg.message)))
      child.kill()
    })
    child.once('error', (err) => settle(() => reject(new ParseError('parse_failed', err.message))))
    child.once('exit', (code, signal) => settle(() => reject(new ParseError(signal === 'SIGKILL' ? 'parse_timeout' : 'parse_failed', `parser exited ${code ?? signal}`))))
    child.send(input)
  })
}
