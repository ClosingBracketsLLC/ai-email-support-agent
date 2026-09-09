import { gmailProvider, graphProvider, type MailboxProvider } from '@aesa/mail'

/**
 * Resolves the real Gmail/Graph adapter for a connection's provider. Every mailbox job that needs a
 * `MailboxProvider` (mailbox.sync's token refresh, mailbox.revoke's provider.revoke, mailbox.renew-watch's
 * subscribe/renew) accepts an optional `providerFactory`/`clientFactory` override for tests; production
 * wiring always falls back to this.
 */
export function resolveMailProvider(provider: 'gmail' | 'microsoft'): MailboxProvider {
  return provider === 'gmail' ? gmailProvider() : graphProvider()
}
