/**
 * The platform-mail transports. Moved verbatim from `apps/api/test/mail.test.ts` when the transport
 * and templates became `@aesa/platform-mail` (the template cases moved to `templates.test.ts`).
 */
import { Secret } from '@aesa/crypto'
import { describe, expect, it } from 'vitest'
import { createDevSink, createMailTransport, createResendTransport } from '../src/transport.ts'

describe('mail transports', () => {
  it('devsink keeps the newest message per recipient (case-insensitive) and caps memory', async () => {
    const sink = createDevSink(3)
    await sink.send({ to: 'a@x.test', subject: '1', text: 'one' })
    await sink.send({ to: 'a@x.test', subject: '2', text: 'two' })
    await sink.send({ to: 'b@x.test', subject: '3', text: 'three' })
    await sink.send({ to: 'c@x.test', subject: '4', text: 'four' })
    expect(sink.kind).toBe('devsink')
    expect(sink.latestTo('A@X.TEST')?.subject).toBe('2')
    expect(sink.all()).toHaveLength(3)
    expect(sink.latestTo('nobody@x.test')).toBeUndefined()
  })

  it('resend transport sends with the configured from and reports failures without the recipient', async () => {
    const calls: unknown[] = []
    const ok = createResendTransport(new Secret('re_key'), 'aesa <no-reply@x.test>', { emails: { send: async (m) => { calls.push(m); return { data: { id: 'e_1' }, error: null } } } })
    await ok.send({ to: 'a@x.test', subject: 'Hi', text: 'body' })
    expect(ok.kind).toBe('resend')
    expect(calls[0]).toEqual({ from: 'aesa <no-reply@x.test>', to: 'a@x.test', subject: 'Hi', text: 'body' })
    const failing = createResendTransport(new Secret('re_key'), 'f', { emails: { send: async () => ({ data: null, error: { name: 'validation_error', message: 'bad a@x.test' } }) } })
    await expect(failing.send({ to: 'a@x.test', subject: 's', text: 't' })).rejects.toThrow(/^resend: validation_error$/)
  })

  it('createMailTransport builds the transport named by the config', () => {
    expect(createMailTransport({ transport: 'devsink', from: 'aesa <dev@x.test>' }).kind).toBe('devsink')
  })
})
