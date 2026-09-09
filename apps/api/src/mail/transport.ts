import { Resend } from 'resend'
import type { Secret } from '@aesa/crypto'
import type { MailConfig } from '../config.ts'

/** Platform mail only (sign-in codes, invitations, later digests). Customer mail never goes through here. */
export interface OutgoingMail { to: string; subject: string; text: string }

export interface ResendTransport { readonly kind: 'resend'; send(mail: OutgoingMail): Promise<void> }
export interface DevSink {
  readonly kind: 'devsink'
  send(mail: OutgoingMail): Promise<void>
  /** Newest message for a recipient; what tests and the Playwright smoke read the OTP from. */
  latestTo(email: string): OutgoingMail | undefined
  all(): OutgoingMail[]
}
export type MailTransport = ResendTransport | DevSink

/** In-memory ring buffer. Only constructed when EMAIL_TRANSPORT=devsink, which loadConfig refuses in production. */
export function createDevSink(max = 200): DevSink {
  const box: OutgoingMail[] = []
  return {
    kind: 'devsink',
    async send(mail) { box.push({ ...mail }); if (box.length > max) box.splice(0, box.length - max) },
    latestTo(email) { const key = email.toLowerCase(); for (let i = box.length - 1; i >= 0; i--) if (box[i]!.to.toLowerCase() === key) return { ...box[i]! }; return undefined },
    all() { return box.map((m) => ({ ...m })) },
  }
}

/** The slice of the Resend SDK we use; injectable so the transport is testable without the network. */
export interface ResendLike {
  emails: { send(mail: { from: string; to: string; subject: string; text: string }): Promise<{ data: { id: string } | null; error: { name: string; message: string } | null }> }
}

export function createResendTransport(apiKey: Secret, from: string, client: ResendLike = new Resend(apiKey.expose())): ResendTransport {
  return {
    kind: 'resend',
    async send(mail) {
      const { error } = await client.emails.send({ from, to: mail.to, subject: mail.subject, text: mail.text })
      if (error) throw new Error(`resend: ${error.name}`)   // error.message can echo the address; the name is enough to triage
    },
  }
}

export function createMailTransport(config: MailConfig): MailTransport {
  return config.transport === 'resend' ? createResendTransport(config.apiKey, config.from) : createDevSink()
}
