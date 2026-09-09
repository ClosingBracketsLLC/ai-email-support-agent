/**
 * Postgres error-code duck-typing shared by every call site that needs to distinguish a
 * unique-violation from any other failure inside a `withOrg`/`withPlatform` transaction — moved
 * here (final-review promoted minor) so `connect/routes.ts` and `trpc/routers/mailboxes.ts` share
 * one implementation instead of each declaring their own copy.
 *
 * Postgres unique_violation, surfaced through drizzle's DrizzleQueryError (`.cause` holds the raw pg
 * error, which node-postgres attaches `.code` to) — same duck-typing `logging.ts` already uses to
 * read a wrapped error's code.
 */
export function isUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause
  const code = (cause as { code?: unknown } | null)?.code
  return code === '23505'
}
