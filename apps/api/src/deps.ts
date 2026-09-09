import type pg from 'pg'
import type pino from 'pino'
import { withOrg, type Db, type OrgTx } from '@aesa/db'
import type { Auth } from './auth.ts'
import type { ApiConfig } from './config.ts'
import type { MailTransport } from './mail/transport.ts'

export interface HealthReport { db: 'ok' | 'error'; migrations: { count: number; latest: string | null } }

/**
 * Everything a request handler may touch. No Db, no Pool (Phase 0 review I9), and no withPlatform: the
 * spec says the api never holds aesa_platform, so the only data path here is withOrg (branded OrgTx).
 * This is a convention, not an enforcement boundary — Better Auth's own adapter (auth.$context /
 * auth.options.database) still closes over the raw Db handle passed to createAuth (Phase 1 review,
 * Important 3).
 */
export interface ApiFacade {
  withOrg<T>(orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T>
  health(): Promise<HealthReport>
}

/** Called only by the composition root (src/index.ts) and test helpers — the two places that hold a raw handle. */
export function createApiFacade(handle: { db: Db; pool: pg.Pool }): ApiFacade {
  return {
    withOrg: (orgId, fn) => withOrg(handle.db, orgId, fn),
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

export interface ServerDeps {
  config: ApiConfig
  auth: Auth
  api: ApiFacade
  mail: MailTransport
  /** Shared by Fastify's request logging and Better Auth's own logger (see src/logging.ts). */
  logger: pino.Logger
}
