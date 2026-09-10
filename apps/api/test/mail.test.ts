import { Secret } from '@aesa/crypto'
import { describe, expect, it } from 'vitest'
import { invitationMail, mailboxClaimedMail, otpMail } from '../src/mail/templates.ts'
import { createDevSink, createResendTransport } from '../src/mail/transport.ts'

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

  it('templates carry the code and the invitation link', () => {
    const otp = otpMail('a@x.test', '123456')
    expect(otp.to).toBe('a@x.test'); expect(otp.subject).toContain('123456'); expect(otp.text).toContain('123456'); expect(otp.text).toContain('10 minutes')
    const inv = invitationMail({ to: 'b@x.test', inviterName: 'Robert', orgName: 'Acme', url: 'http://localhost:8081/invite/abc' })
    expect(inv.subject).toContain('Acme'); expect(inv.text).toContain('Robert'); expect(inv.text).toContain('http://localhost:8081/invite/abc'); expect(inv.text).toContain('48 hours')
  })

  it('mailboxClaimedMail names the address, the provider, the claiming user, and the settings link', () => {
    const claimed = mailboxClaimedMail({
      to: 'support@acme.test', emailAddress: 'support@acme.test', provider: 'gmail',
      claimedByEmail: 'owner@acme.test', settingsUrl: 'http://localhost:8081/settings/mailboxes',
    })
    expect(claimed.to).toBe('support@acme.test')
    expect(claimed.subject).toBe('Your mailbox support@acme.test was connected to aesa')
    expect(claimed.text).toContain('gmail')
    expect(claimed.text).toContain('owner@acme.test')
    expect(claimed.text).toContain('http://localhost:8081/settings/mailboxes')
  })
})
