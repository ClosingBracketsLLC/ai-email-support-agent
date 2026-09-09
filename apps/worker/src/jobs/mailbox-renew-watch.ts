/**
 * `mailbox.renew-watch` — the hourly cron that keeps push subscriptions alive (spec: renew when < 36 h
 * remain). Reads candidates in one cross-org pass, then does every subscribe/renew call OUTSIDE any
 * transaction (each is real network I/O) and writes its own small `withOrg` update per connection
 * afterward. A failure on one connection is logged and counted (`consecutive_failures`) but never
 * thrown — per the brief, mailbox.poll-sweep keeps mail flowing without push, so one bad connection
 * must not stop this cron from reaching the rest.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { generateToken, type KekRing } from '@aesa/crypto'
import { mailboxConnections, withOrg, withPlatform, type Db } from '@aesa/db'
import { getAccessToken, ProviderAuthError, type MailboxClient, type MailboxProvider } from '@aesa/mail'
import { registerCron } from '@aesa/queue'
import type { WorkerConfig } from '../config.ts'
import { errorMessage } from '../err-message.ts'
import { resolveMailProvider } from '../mail-provider.ts'
import { notifyReauthRequired } from '../reauth-notify.ts'

const RENEW_WINDOW_MS = 36 * 60 * 60 * 1000

export interface MailboxRenewWatchDeps {
  db: Db
  ring: KekRing
  config: WorkerConfig
  logger: pino.Logger
  /** Test seam for the client subscribe/renew calls run against; production builds it off `providerFactory`. */
  clientFactory?: (provider: 'gmail' | 'microsoft', accessToken: string, selfAddress: string) => MailboxClient
  /** Test seam for the whole adapter (covers `.refresh` for `getAccessToken` too); production always
   *  resolves the real Gmail/Graph adapter. */
  providerFactory?: (provider: 'gmail' | 'microsoft') => MailboxProvider
  now?: () => Date
}

export async function runMailboxRenewWatch(boss: PgBoss, deps: MailboxRenewWatchDeps): Promise<void> {
  const now = deps.now?.() ?? new Date()
  const providers: ('gmail' | 'microsoft')[] = []
  if (deps.config.gmailPubsubTopic) providers.push('gmail')
  if (deps.config.webhookPublicUrl) providers.push('microsoft')
  if (providers.length === 0) return

  const candidates = await withPlatform(deps.db, 'cron:mailbox.renew-watch', (tx) =>
    tx
      .select({
        id: mailboxConnections.id,
        orgId: mailboxConnections.orgId,
        provider: mailboxConnections.provider,
        emailAddress: mailboxConnections.emailAddress,
        pushSubscriptionId: mailboxConnections.pushSubscriptionId,
        pushExpiresAt: mailboxConnections.pushExpiresAt,
      })
      .from(mailboxConnections)
      .where(and(eq(mailboxConnections.status, 'connected'), inArray(mailboxConnections.provider, providers))),
  )

  const renewThreshold = now.getTime() + RENEW_WINDOW_MS

  for (const c of candidates) {
    const needsSubscribe = c.pushSubscriptionId === null
    const needsRenew = !needsSubscribe && c.pushExpiresAt !== null && c.pushExpiresAt.getTime() < renewThreshold
    if (!needsSubscribe && !needsRenew) continue

    const provider = c.provider as 'gmail' | 'microsoft'
    try {
      const oauth = provider === 'gmail' ? deps.config.gmailOauth : deps.config.msOauth
      if (!oauth) throw new Error(`no OAuth client configured for provider ${provider}`)
      const providerObj = (deps.providerFactory ?? resolveMailProvider)(provider)

      const accessToken = await getAccessToken(
        { db: deps.db, ring: deps.ring, provider: providerObj, clientId: oauth.clientId, clientSecret: oauth.clientSecret.expose() },
        c.orgId,
        c.id,
        'mailbox.renew-watch',
      )
      const client = deps.clientFactory ? deps.clientFactory(provider, accessToken, c.emailAddress) : providerObj.client(accessToken, c.emailAddress)

      if (needsSubscribe) {
        if (provider === 'gmail') {
          const { subscriptionId, expiresAt } = await client.subscribe({ topicOrUrl: deps.config.gmailPubsubTopic! })
          await withOrg(deps.db, c.orgId, (tx) =>
            tx
              .update(mailboxConnections)
              .set({ pushSubscriptionId: subscriptionId, pushExpiresAt: expiresAt, pushClientStateHash: null })
              .where(eq(mailboxConnections.id, c.id)),
          )
        } else {
          const { token, hash } = generateToken('action')
          const notificationUrl = `${deps.config.webhookPublicUrl}/webhooks/microsoft`
          const { subscriptionId, expiresAt } = await client.subscribe({ topicOrUrl: notificationUrl, clientState: token })
          await withOrg(deps.db, c.orgId, (tx) =>
            tx
              .update(mailboxConnections)
              .set({ pushSubscriptionId: subscriptionId, pushExpiresAt: expiresAt, pushClientStateHash: hash })
              .where(eq(mailboxConnections.id, c.id)),
          )
        }
      } else {
        const { subscriptionId, expiresAt } = await client.renewSubscription(c.pushSubscriptionId!)
        await withOrg(deps.db, c.orgId, (tx) =>
          tx.update(mailboxConnections).set({ pushSubscriptionId: subscriptionId, pushExpiresAt: expiresAt }).where(eq(mailboxConnections.id, c.id)),
        )
      }
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        // Task 8 already flipped this connection to reauth_required (only when the hash it tried was
        // still current). Once reauth_required, the connection is excluded from BOTH mailbox.sync's
        // lease claim (status must be 'connected') and mailbox.poll-sweep's (a) selection — this is
        // the only place left that can ever tell the owner about it (fix review, Important 3), so
        // route it through the same day-deduped notification mailbox.sync uses rather than just
        // bumping consecutive_failures (which nothing would ever act on for a reauth_required row).
        deps.logger.warn({ connectionId: c.id, provider }, 'mailbox.renew_watch_reauth_required')
        try {
          await notifyReauthRequired(boss, deps.db, c.orgId, c.id, now)
        } catch (notifyErr) {
          deps.logger.warn({ connectionId: c.id, error: errorMessage(notifyErr) }, 'mailbox.renew_watch_reauth_notify_failed')
        }
        continue
      }
      deps.logger.warn({ connectionId: c.id, provider, error: errorMessage(err) }, 'mailbox.renew_watch_failed')
      try {
        await withOrg(deps.db, c.orgId, (tx) =>
          tx.update(mailboxConnections).set({ consecutiveFailures: sql`${mailboxConnections.consecutiveFailures} + 1` }).where(eq(mailboxConnections.id, c.id)),
        )
      } catch (writeErr) {
        deps.logger.warn({ connectionId: c.id, error: errorMessage(writeErr) }, 'mailbox.renew_watch_failure_write_failed')
      }
    }
  }
}

export async function registerMailboxRenewWatch(boss: PgBoss, deps: MailboxRenewWatchDeps): Promise<void> {
  await registerCron(
    boss,
    'mailbox.renew-watch',
    '17 * * * *',
    async () => {
      await runMailboxRenewWatch(boss, deps)
    },
    { policy: 'singleton', singletonKey: 'mailbox.renew-watch', retryLimit: 0, expireInSeconds: 600 },
  )
}
