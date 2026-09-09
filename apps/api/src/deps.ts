import type pg from 'pg'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import type { MailProvider } from '@aesa/contracts'
import { withOrg, type Db, type OrgTx } from '@aesa/db'
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
}
