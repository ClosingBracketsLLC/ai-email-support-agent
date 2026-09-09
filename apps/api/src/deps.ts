import type pg from 'pg'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import type { MailProvider } from '@aesa/contracts'
import { webhookEvents, withOrg, type Db, type OrgTx } from '@aesa/db'
import { enqueue as enqueueJob, type JobDefinition } from '@aesa/queue'
import type { MailboxProvider } from '@aesa/mail'
import type { Auth } from './auth.ts'
import type { ApiConfig } from './config.ts'
import type { MailTransport } from './mail/transport.ts'

export interface HealthReport { db: 'ok' | 'error'; migrations: { count: number; latest: string | null } }

/**
 * Everything a request handler may touch. No Db, no Pool (Phase 0 review I9), and no withPlatform: the
 * spec says the api never holds aesa_platform, so the only data path here is withOrg (branded OrgTx),
 * plus the two fixed-signature SECURITY DEFINER resolvers (spec net 1) — resolveOauthFlow here,
 * resolveMailboxConnection/resolveMailboxSubscription land in Task 18. This is a convention, not an
 * enforcement boundary — Better Auth's own adapter (auth.$context / auth.options.database) still closes
 * over the raw Db handle passed to createAuth (Phase 1 review, Important 3).
 */
export interface ApiFacade {
  withOrg<T>(orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T>
  health(): Promise<HealthReport>
  /**
   * The OAuth callback carries no session (the system browser, not the app, hits it), so the pending
   * `oauth_flows` row has to be found by flow id alone, before any org is known — migration 0009's
   * `resolve_oauth_flow(uuid)`, SECURITY DEFINER, `aesa_app` EXECUTE. A plain query on the pool-backed
   * handle (same shape as `resolve_mailbox_connection`'s own test): the function is SECURITY DEFINER, so
   * `aesa_app` may call it with no `app.org_id` set at all.
   */
  resolveOauthFlow(flowId: string): Promise<{ flowId: string; orgId: string } | null>
  /**
   * Task 18's provider webhooks (Gmail Pub/Sub, Microsoft Graph) carry no session either — the org has
   * to be found from a provider-supplied identifier alone, via 0006's other two SECURITY DEFINER
   * resolvers. `clientStateHash` is `mailbox_connections.push_client_state_hash` (Graph's clientState
   * check); Gmail rows leave it null.
   */
  resolveMailboxConnection(provider: MailProvider, email: string): Promise<{ connectionId: string; orgId: string; clientStateHash: string | null } | null>
  resolveMailboxSubscription(subscriptionId: string): Promise<{ connectionId: string; orgId: string; clientStateHash: string | null } | null>
  /**
   * `webhook_events` (RLS-exempt platform table, migration 0005/0006): INSERT ... ON CONFLICT
   * (provider, external_id) DO NOTHING. Returns false when the row already existed — a duplicate
   * delivery the caller should ack without redoing any enqueue.
   */
  recordWebhookEvent(provider: string, externalId: string, envelope: unknown): Promise<boolean>
}

/** Called only by the composition root (src/index.ts) and test helpers — the two places that hold a raw handle. */
export function createApiFacade(handle: { db: Db; pool: pg.Pool }): ApiFacade {
  return {
    withOrg: (orgId, fn) => withOrg(handle.db, orgId, fn),
    async resolveOauthFlow(flowId) {
      const res = await handle.pool.query<{ flow_id: string; org_id: string }>('SELECT * FROM resolve_oauth_flow($1)', [flowId])
      const row = res.rows[0]
      return row ? { flowId: row.flow_id, orgId: row.org_id } : null
    },
    async resolveMailboxConnection(provider, email) {
      const res = await handle.pool.query<{ connection_id: string; org_id: string; client_state_hash: string | null }>(
        'SELECT * FROM resolve_mailbox_connection($1, $2)', [provider, email],
      )
      const row = res.rows[0]
      return row ? { connectionId: row.connection_id, orgId: row.org_id, clientStateHash: row.client_state_hash } : null
    },
    async resolveMailboxSubscription(subscriptionId) {
      const res = await handle.pool.query<{ connection_id: string; org_id: string; client_state_hash: string | null }>(
        'SELECT * FROM resolve_mailbox_subscription($1)', [subscriptionId],
      )
      const row = res.rows[0]
      return row ? { connectionId: row.connection_id, orgId: row.org_id, clientStateHash: row.client_state_hash } : null
    },
    async recordWebhookEvent(provider, externalId, envelope) {
      const inserted = await handle.db.insert(webhookEvents)
        .values({ provider, externalId, envelope })
        .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.externalId] })
        .returning({ id: webhookEvents.id })
      return inserted.length > 0
    },
    async health() {
      try {
        await handle.pool.query('SELECT 1')
        const res = await handle.pool.query<{ count: number; latest: string | null }>(
          'SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations')
        return { db: 'ok', migrations: res.rows[0] ?? { count: 0, latest: null } }
      } catch {
        return { db: 'error', migrations: { count: 0, latest: null } }
      }
    },
  }
}

/** Every job payload carries orgId (queue net rule); the rest rides through untouched. */
export type EnqueueFn = (
  name: string,
  data: { orgId: string } & Record<string, unknown>,
  opts: { entityId: string; debounceSeconds?: number },
) => Promise<string | null>

// Loose on purpose: the api only ever sends by job NAME (JOB_NAMES.*) — it never registers a handler, so
// it has no business re-validating a payload shape the worker's own JobDefinition already owns. Requiring
// orgId here is the one invariant `@aesa/queue`'s enqueue() itself depends on (singletonKey namespacing).
const passthroughPayload = z.object({ orgId: z.string() }).passthrough() as unknown as z.ZodType<{ orgId: string } & Record<string, unknown>>

/**
 * Wraps `@aesa/queue`'s `enqueue` with a minimal, name-keyed `JobDefinition`: `queue`/`handler` below are
 * never read by `enqueue()` (it only touches `.name`/`.schema`) and exist solely to satisfy the type — the
 * worker (Task 15) registers the real definition, with the real schema and the real handler, and is the
 * only thing that ever calls `.handler`.
 */
export function createEnqueue(boss: PgBoss): EnqueueFn {
  return (name, data, opts) => {
    const def: JobDefinition<{ orgId: string } & Record<string, unknown>> = {
      name,
      schema: passthroughPayload,
      queue: { expireInSeconds: 60 },
      handler: async () => { throw new Error(`${name}: send-only definition has no handler — the worker registers the real one`) },
    }
    return enqueueJob(boss, def, data, opts)
  }
}

export interface ServerDeps {
  config: ApiConfig
  auth: Auth
  api: ApiFacade
  mail: MailTransport
  /** Shared by Fastify's request logging and Better Auth's own logger (see src/logging.ts). */
  logger: pino.Logger
  /** The api's only path to pg-boss: it enqueues jobs by name, never works one (src/boss.ts). */
  enqueue: EnqueueFn
  /** Test seam: overrides the real Gmail/Graph adapters per provider (connect/routes.ts); production
   * code leaves this unset and resolves the real adapter every time. */
  mailProviders?: Partial<Record<MailProvider, MailboxProvider>>
  /** Test seam for the Gmail Pub/Sub webhook's OIDC verification (webhooks/gmail.ts): overrides the
   * real `jose` JWKS/issuer/audience check with a fake that returns or throws whatever a test needs,
   * so no suite has to mint a Google-signed token. Production leaves this unset and always resolves
   * the real verifier, bound to `config.gmailPubsubAudience` at server-build time. */
  verifyGoogleJwt?: (jwt: string) => Promise<{ email?: string; email_verified?: boolean }>
}
