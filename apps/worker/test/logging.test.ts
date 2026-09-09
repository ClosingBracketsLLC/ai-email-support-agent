import { describe, expect, it } from 'vitest'
import { createWorkerLogger } from '../src/logging.ts'

describe('worker logger', () => {
  it('emits JSON at the configured level and redacts authorization', () => {
    const lines: string[] = []
    const logger = createWorkerLogger('info', { write: (s: string) => void lines.push(s) })
    logger.debug('hidden')
    logger.info({ authorization: 'Bearer abc', job: 'mailbox.sync' }, 'worked')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.msg).toBe('worked')
    expect(parsed.authorization).toBe('[Redacted]')
    expect(parsed.job).toBe('mailbox.sync')
  })
})
