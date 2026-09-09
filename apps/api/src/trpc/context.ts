import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { fromNodeHeaders } from 'better-auth/node'
import type { Auth } from '../auth.ts'
import type { ServerDeps } from '../deps.ts'

export type SessionBundle = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>

export interface TrpcContext {
  deps: ServerDeps
  /** The request headers as a fetch Headers object — what every auth.api.* call needs. */
  headers: Headers
  session: SessionBundle | null
  ip: string
  userAgent: string | null
}

export function createContextFactory(deps: ServerDeps) {
  return async ({ req }: CreateFastifyContextOptions): Promise<TrpcContext> => {
    const headers = fromNodeHeaders(req.headers)
    const session = await deps.auth.api.getSession({ headers })
    return { deps, headers, session, ip: req.ip, userAgent: req.headers['user-agent'] ?? null }
  }
}
