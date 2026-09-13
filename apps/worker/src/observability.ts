/**
 * Task 11: Sentry with org attribution, the worker's half. `apps/api/src/observability.ts` is the
 * SAME shape on purpose — each file configures a different service (this one wires `@aesa/queue`'s
 * job observer; the api's wires Fastify and tRPC) and CLAUDE.md's package layout keeps the two apps
 * from sharing runtime code for something this small, so this stays its own file rather than a
 * shared package.
 *
 * `packages/queue`'s `observe.ts` knows nothing about Sentry (a deliberate seam) — `src/index.ts`
 * is what calls `setJobObserver({ onFailure: (err, ctx) => captureWithOrg(err, { orgId: ctx.orgId,
 * job: ctx.name }) })` after `initObservability` has run.
 *
 * Verified against the installed `@sentry/node@10.74.0` type declarations before writing this file
 * (see the task report for the exact files read): `init`, `withIsolationScope`, `setTag`,
 * `captureException`, `captureMessage`, `flush`, `isInitialized` and `setupFastifyErrorHandler` are
 * all real exports of `@sentry/node`'s root; `NodeOptions.transport` is
 * `(transportOptions: NodeTransportOptions) => Transport`, and `Transport.send` receives the
 * `Envelope` object directly (an `[EnvelopeHeader, [ItemHeader, Event][]]` tuple) — not a
 * serialized byte string — which is what makes stubbing a fake transport in a test cheap: no
 * envelope-wire-format parsing needed to read back the event `beforeSend` produced.
 */
import * as Sentry from '@sentry/node'
import type pino from 'pino'
import type { Secret } from '@aesa/crypto'
import { scrubJobError } from '@aesa/queue'

/**
 * The alert kinds actually raised, surveyed against every `alert(...)` call site left behind by
 * Tasks 4–8 (eleven, not the brief's nine — three were added by controller rulings after the brief
 * was written). `platform_killswitch_on` is deliberately NOT one of them: it is wired nowhere.
 * `platform_state['killswitch.global']` is set BY HAND by an operator, so an alert telling them
 * what they just did would be pure noise, and "sends are paused" is already visible in the backstop
 * sweep's own log line every minute it skips arm (a) — see the task report for the full reasoning.
 */
export const ALERT_KINDS = [
  'admission_slot_timeout',
  'deletion_billing_unconfigured',
  'export_failed',
  'keys_rotate_failed',
  'knowledge_reembed_stranded',
  'org_spend_capped',
  'purge_failed',
  'stripe_double_subscription',
  'stripe_report_failed',
  'stripe_unknown_customer',
  'stripe_webhook_rejected',
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

/** Case-exact key names `beforeSend` strips wherever they appear in `extra` or inside any one `contexts` entry. */
const SCRUB_KEYS: ReadonlySet<string> = new Set([
  'body', 'bodyText', 'detail', 'payload', 'apiKey', 'key', 'token', 'cookie', 'authorization',
])
const BREADCRUMB_MESSAGE_MAX = 200

function scrubKeys(rec: Record<string, unknown> | undefined): void {
  if (!rec) return
  for (const key of SCRUB_KEYS) delete rec[key]
}

/**
 * The PII boundary (CLAUDE.md: bodies, transcripts and tool results are PII at rest; secrets are
 * never logged). A stack trace's locals, a manually-attached `extra`, or Fastify's own request
 * context can all carry a customer body or a bearer token — none of it may leave this process for
 * Sentry's servers. Exported past what the Produces interface lists on purpose, so it can be
 * exercised directly rather than only trusted through `Sentry.init`'s option wiring.
 */
export function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) delete event.request.data
  scrubKeys(event.extra as Record<string, unknown> | undefined)
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) scrubKeys(event.contexts[key] as Record<string, unknown> | undefined)
  }
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.message && crumb.message.length > BREADCRUMB_MESSAGE_MAX) crumb.message = crumb.message.slice(0, BREADCRUMB_MESSAGE_MAX)
    }
  }
  return event
}

/**
 * `false` = no-op mode (no `SENTRY_DSN`, the normal state of a dev box — CLAUDE.md). `alert` and
 * `captureWithOrg` both stay safe to call either way: the pino line always fires, and the Sentry
 * half is skipped rather than throwing on an uninitialised client.
 */
export function initObservability(config: { sentry: { dsn: Secret; environment: string } | null; release?: string }): boolean {
  if (!config.sentry) return false
  Sentry.init({
    dsn: config.sentry.dsn.expose(),
    environment: config.sentry.environment,
    release: config.release,
    beforeSend,
  })
  return true
}

/**
 * The pino error line is UNCONDITIONAL — an operator reading logs alone (no Sentry configured) must
 * still see every alert. The Sentry half is additive: a `captureMessage` tagged with `org_id` and
 * `kind`, so a workspace's own alerts are filterable in Sentry the same way `llm_calls` are here.
 */
export function alert(
  logger: pino.Logger,
  kind: AlertKind,
  ctx: { orgId?: string | null } & Record<string, string | number | boolean | null>,
): void {
  logger.error({ alert: true, kind, ...ctx }, kind)
  if (!Sentry.isInitialized()) return
  Sentry.captureMessage(kind, { level: 'error', tags: { org_id: ctx.orgId ?? null, kind } })
}

/**
 * The job observer's real implementation, wired at boot via `setJobObserver`. A no-op when Sentry
 * isn't initialised, same as `alert`. `scrubJobError` runs on the way in — the SAME function
 * `registerJob`'s own catch uses before pg-boss ever sees the error — so a raw `DrizzleQueryError`
 * (its SQL and bound parameters) can never reach Sentry, an EXTERNAL service. `registerJob` already
 * scrubs before calling `notifyJobFailure`, so this is a second, defensive layer for any OTHER
 * caller of `captureWithOrg` — cheap, and idempotent on an already-scrubbed error.
 */
export function captureWithOrg(err: unknown, ctx: { orgId?: string | null; job?: string; path?: string }): void {
  if (!Sentry.isInitialized()) return
  const safe = scrubJobError(err)
  Sentry.withIsolationScope((scope) => {
    scope.setTag('org_id', ctx.orgId ?? null)
    if (ctx.job !== undefined) scope.setTag('job', ctx.job)
    if (ctx.path !== undefined) scope.setTag('path', ctx.path)
    Sentry.captureException(safe)
  })
}
