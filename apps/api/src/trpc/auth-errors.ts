import { TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server'
import { APIError } from 'better-auth/api'

/**
 * Better Auth's `APIError.statusCode` is the numeric HTTP status (`.status` is the STRING key it was
 * built from, e.g. "FORBIDDEN" — see `better-call/error`'s `statusCodes` table); this maps the numeric
 * side to a tRPC code. Anything outside this short list (a 409, a 5xx, …) is deliberately NOT passed
 * through as its own tRPC code — it becomes a masked INTERNAL_SERVER_ERROR, same as every other
 * unexpected failure (init.ts's errorFormatter overwrites its message on the wire regardless).
 */
const STATUS_TO_CODE: Record<number, TRPC_ERROR_CODE_KEY> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'TOO_MANY_REQUESTS',
}

/**
 * Translates a thrown Better Auth `APIError` into a `TRPCError` with the right client-visible code
 * instead of every auth failure surfacing as a masked 500 (Phase 1 carry-over: `organizationLimit`'s
 * "You have reached the maximum number of organizations" never reached the client — `createOrganization`
 * throws a raw `APIError` no procedure translated). A non-`APIError` (or an `APIError` whose status maps
 * to none of the above) becomes `INTERNAL_SERVER_ERROR` with `fallback` as its message; one of the mapped
 * 4xx statuses keeps Better Auth's own `body.message` (falling back to `fallback` if that's absent).
 */
export function mapAuthError(e: unknown, fallback: string): TRPCError {
  if (!(e instanceof APIError)) return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback, cause: e })
  const code = STATUS_TO_CODE[e.statusCode]
  if (!code) return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallback, cause: e })
  return new TRPCError({ code, message: e.body?.message ?? fallback })
}
