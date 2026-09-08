import { describe, expect, it } from 'vitest'
import { parseWorkerRoles } from '../src/roles.ts'

describe('parseWorkerRoles', () => {
  it('defaults to every role', () => expect([...parseWorkerRoles(undefined)]).toEqual(['sync', 'agent', 'send', 'knowledge', 'cron']))
  it('parses a comma list and trims', () => expect([...parseWorkerRoles(' sync, cron ')]).toEqual(['sync', 'cron']))
  it('rejects unknown roles', () => expect(() => parseWorkerRoles('sync,mailer')).toThrow(/unknown worker role/))
})
