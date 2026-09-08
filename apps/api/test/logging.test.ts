import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it } from 'vitest'
import { betterAuthLogger, createAppLogger } from '../src/logging.ts'

const SECRET = 'tok_SUPER_SECRET_SESSION_TOKEN'
const QUERY = 'insert into "session" ("token") values ($1)'

/** A pino instance with the same construction createAppLogger always uses, capturing lines instead of stdout. */
function buildCapturingLogger(level = 'trace') {
  const lines: string[] = []
  const logger = createAppLogger({ level, stream: { write: (line: string) => void lines.push(line) } })
  return { logger, log: () => lines.join('') }
}

describe('betterAuthLogger', () => {
  it('collapses a DrizzleQueryError through the same err serializer, at error level, with no secret or SQL', () => {
    const { logger, log } = buildCapturingLogger()
    betterAuthLogger(logger).log('error', 'INTERNAL_SERVER_ERROR', new DrizzleQueryError(QUERY, [SECRET], new Error('duplicate key')))
    expect(log()).toContain('Failed query: [redacted]')
    expect(log()).toContain('"level":50')
    expect(log()).not.toContain(SECRET)
    expect(log()).not.toContain('insert into')
  })

  it('redacts a URL found in the message and drops every argument that is not an Error', () => {
    const { logger, log } = buildCapturingLogger()
    betterAuthLogger(logger).log('warn', 'see https://x.test/cb?code=abc123', 'raw-arg-with-secret')
    expect(log()).toContain('code=[redacted]')
    expect(log()).not.toContain('abc123')
    expect(log()).not.toContain('raw-arg-with-secret')
  })

  it('maps Better Auth\'s "success" level to pino info', () => {
    const { logger, log } = buildCapturingLogger()
    betterAuthLogger(logger).log('success', 'ok')
    expect(log()).toContain('"level":30')
    expect(log()).toContain('"msg":"ok"')
  })
})
