import type { MailboxProvider } from '../../types.ts'
import { createGmailClient } from './client.ts'
import { gmailAuthorizationUrl, gmailExchangeCode, gmailRefresh, gmailRevoke } from './oauth.ts'

export { METADATA_HEADERS } from './map.ts'

/** `MailboxProvider` for Gmail. `fetchFn` is injectable (tests stub it); defaults to the runtime's
 * own `fetch`, matching every other adapter entry point in this package. */
export function gmailProvider(fetchFn: typeof fetch = globalThis.fetch): MailboxProvider {
  return {
    kind: 'gmail',
    authorizationUrl: gmailAuthorizationUrl,
    exchangeCode: (p) => gmailExchangeCode(p, fetchFn),
    refresh: (p) => gmailRefresh(p, fetchFn),
    revoke: (p) => gmailRevoke(p, fetchFn),
    client: (accessToken, selfAddress) => createGmailClient({ accessToken, selfAddress, fetchFn }),
  }
}
