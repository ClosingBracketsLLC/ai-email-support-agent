import type { MailboxProvider } from '../../types.ts'
import { createGraphClient } from './client.ts'
import { graphAuthorizationUrl, graphExchangeCode, graphRefresh, graphRevoke } from './oauth.ts'

export { FOLDER_KEYS, FOLDER_LABELS, GET_MESSAGE_SELECT_FIELDS } from './map.ts'

/** `MailboxProvider` for Microsoft 365 / Outlook via Graph. `fetchFn` is injectable (tests stub
 * it); defaults to the runtime's own `fetch`, matching the Gmail adapter's entry point. */
export function graphProvider(fetchFn: typeof fetch = globalThis.fetch): MailboxProvider {
  return {
    kind: 'microsoft',
    authorizationUrl: graphAuthorizationUrl,
    exchangeCode: (p) => graphExchangeCode(p, fetchFn),
    refresh: (p) => graphRefresh(p, fetchFn),
    revoke: (p) => graphRevoke(p),
    client: (accessToken, selfAddress) => createGraphClient({ accessToken, selfAddress, fetchFn }),
  }
}
