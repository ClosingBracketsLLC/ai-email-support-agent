import { z } from 'zod'

export const MAIL_PROVIDERS = ['gmail', 'microsoft'] as const
export type MailProvider = (typeof MAIL_PROVIDERS)[number]

export const CONNECTION_STATUSES = ['pending_claim', 'connected', 'reauth_required', 'disabled'] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

export const StartConnectInput = z.object({ provider: z.enum(MAIL_PROVIDERS), platform: z.enum(['native', 'web']) })
export type StartConnectInput = z.infer<typeof StartConnectInput>

export const ClaimConnectionInput = z.object({ flowId: z.uuid() })
export type ClaimConnectionInput = z.infer<typeof ClaimConnectionInput>

export const DisconnectInput = z.object({ connectionId: z.uuid() })
export type DisconnectInput = z.infer<typeof DisconnectInput>

export const AddAddressInput = z.object({
  connectionId: z.uuid(),
  address: z.email().max(254).transform((s) => s.toLowerCase()),
  replyFromConnection: z.boolean(),
})
export type AddAddressInput = z.infer<typeof AddAddressInput>

export const ResendVerificationInput = z.object({ agentId: z.uuid() })
export type ResendVerificationInput = z.infer<typeof ResendVerificationInput>

export const ConsentAddressInput = z.object({ agentId: z.uuid(), approve: z.boolean() })
export type ConsentAddressInput = z.infer<typeof ConsentAddressInput>

export const RequestGmailAccessInput = z.object({ email: z.email().max(254) })
export type RequestGmailAccessInput = z.infer<typeof RequestGmailAccessInput>

export function emailDomain(address: string): string {
  const parts = address.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new TypeError('not an email address')
  }
  return parts[1]
}
