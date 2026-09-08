import type pg from 'pg'
import { withOrg, withPlatform, type Db, type OrgTx, type PlatformTx } from '@aesa/db'
import type { Auth } from './auth.ts'
import type { ApiConfig } from './config.ts'
import type { MailTransport } from './mail/transport.ts'

export interface HealthReport { db: 'ok' | 'error'; migrations: { count: number; latest: string | null } }

/**
 * Everything a request handler may touch. No Db, no Pool (Phase 0 review I9): tenancy is enforced by
 * construction because the only data paths are withOrg (branded OrgTx) and withPlatform (audited).
 */
export interface ApiFacade {
  withOrg<T>(orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T>
  withPlatform<T>(reason: string, fn: (tx: PlatformTx) => Promise<T>): Promise<T>
  health(): Promise<HealthReport>
}

/** Called only by the composition root (src/index.ts) and test helpers — the two places that hold a raw handle. */
export function createApiFacade(handle: { db: Db; pool: pg.Pool }): ApiFacade {
  return {
    withOrg: (orgId, fn) => withOrg(handle.db, orgId, fn),
    withPlatform: (reason, fn) => withPlatform(handle.db, reason, fn),
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
  logLevel?: string
  /** Test seam: a pino destination so a suite can assert on the real log output. Production logs to stdout. */
  logStream?: { write(line: string): void }
}
