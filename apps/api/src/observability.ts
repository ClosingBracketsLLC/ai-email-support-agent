/**
 * Task 11: Sentry with org attribution, the api's half. `apps/worker/src/observability.ts` is the
 * SAME shape on purpose — each file configures a different service (this one wires Fastify's error
 * handler and tRPC's `onError`; the worker's wires `@aesa/queue`'s job observer) and CLAUDE.md's
 * package layout keeps the two apps from sharing runtime code for something this small, so this
 * stays its own file rather than a shared package.
 *
 * `src/server.ts` calls `setupFastifyErrorHandler(app)` right after `initObservability` says it is
 * initialised, and the tRPC plugin's `onError` calls `captureWithOrg` for every
 * `INTERNAL_SERVER_ERROR`, tagged with the request's `orgId` (when `orgProcedure`'s middleware ever
 * reached) and the failed `path`.
 *
 * **The PII boundary is `beforeSend`, and it is EVENT-level, not call-site-level.** `alert()` and
 * `captureWithOrg()` are not the only way an error reaches Sentry: `setupFastifyErrorHandler`'s own
 * `onError` hook and the DEFAULT `onUncaughtExceptionIntegration`/`onUnhandledRejectionIntegration`
 * all call `Sentry.captureException` on the raw error directly, bypassing both helpers entirely —
 * and neither `review/routes.ts`'s `approveDraft(...)` call nor the Stripe webhook route's
 * `applyStripeEvent(...)` call sits inside a try/catch, so a `DrizzleQueryError` from either reaches
 * Sentry through the Fastify path alone. Its `.message` is `Failed query: <sql>\nparams: <bound values>`
 * — for `drafts`, that bound value can be `final_body`: customer reply text and quoted customer
 * mail. `apps/api/src/logging.ts`'s pino `err` serializer already collapses exactly this string to
 * `Failed query: [redacted]` for the LOCAL log line; the external path must not be weaker than the
 * local one, so `beforeSend` — which runs on EVERY event regardless of how it was captured — applies
 * the SAME `redactText` to `event.exception.values[].value`. The default `requestDataIntegration`
 * also means a captured event's `request.headers` carries the live session cookie unfiltered (the
 * filtering helper it ships only applies on the SPAN path, not the event path) and, for the review
 * routes, `request.url`/`request.query_string` carry the `/a/:draftId?t=` one-click action token —
 * `withIsolationScope` FORKS the current isolation scope, so this reaches `captureWithOrg`'s own
 * events too, not only Fastify's. `beforeSend` strips both.
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
import { redactText } from './logging.ts'
import { redactUrl } from './redact.ts'

/**
 * The alert kinds actually raised, surveyed against every `alert(...)` call site left behind by
 * Tasks 4–8 (eleven, not the brief's nine — three were added by controller rulings after the brief
 * was written). `platform_killswitch_on` is deliberately NOT one of them: it is wired nowhere.
 * `platform_state['killswitch.global']` is set BY HAND by an operator, so an alert telling them
 * what they just did would be pure noise, and "sends are paused" is already visible in the worker's
 * backstop sweep's own log line every minute it skips arm (a) — see the task report for the full
 * reasoning.
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

// ---------------------------------------------------------------------------------------------
// beforeSend's building blocks
// ---------------------------------------------------------------------------------------------

/** Lower-cased key names `beforeSend` strips wherever they appear in `extra`, inside any one
 *  `contexts` entry, or nested up to `SCRUB_MAX_DEPTH` levels inside either (`extra.request.body`,
 *  not only `extra.body`) — the compare is case-insensitive so `extra.Authorization` is caught too. */
const SCRUB_KEYS: ReadonlySet<string> = new Set([
  'body', 'bodytext', 'detail', 'payload', 'apikey', 'key', 'token', 'cookie', 'authorization',
])
const SCRUB_MAX_DEPTH = 3
const BREADCRUMB_MESSAGE_MAX = 200
/** Header names `beforeSend` deletes outright from `event.request.headers` — `requestDataIntegration`
 *  copies these in UNFILTERED on the event path (its own filtering helper applies only to spans),
 *  and `createAppLogger`'s pino `redact` option already treats the same two as unconditional. */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set(['cookie', 'authorization', 'x-api-key'])

function scrubKeys(rec: Record<string, unknown> | undefined, depth = 0): void {
  if (!rec || depth > SCRUB_MAX_DEPTH) return
  for (const key of Object.keys(rec)) {
    if (SCRUB_KEYS.has(key.toLowerCase())) { delete rec[key]; continue }
    const value = rec[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) scrubKeys(value as Record<string, unknown>, depth + 1)
  }
}

/** Same value-masking convention as `redactUrl`'s query branch, generalised over Sentry's three
 *  `QueryParams` shapes (a raw `t=<action-token>` string, an object, or `[key, value]` pairs). */
function redactQueryParams(qs: Sentry.RequestEventData['query_string']): Sentry.RequestEventData['query_string'] {
  if (qs === undefined) return qs
  if (typeof qs === 'string') return qs.split('&').map((pair) => { const i = pair.indexOf('='); return i === -1 ? pair : `${pair.slice(0, i)}=[redacted]` }).join('&')
  if (Array.isArray(qs)) return qs.map(([key]) => [key, '[redacted]'] as [string, string])
  return Object.fromEntries(Object.keys(qs).map((key) => [key, '[redacted]'])) as Record<string, string>
}

function redactHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) delete headers[key]
  }
}

/**
 * The PII boundary (CLAUDE.md: bodies, transcripts and tool results are PII at rest; secrets are
 * never logged). A stack trace's message, a manually-attached `extra`, Fastify's own request
 * context (headers, cookies, the URL's query string) or a console breadcrumb's raw argument dump
 * can all carry a customer body, a session cookie or an action token — none of it may leave this
 * process for Sentry's servers. This runs on EVERY event regardless of how it was captured — see
 * the module doc comment for why that matters more than any one call site's own scrubbing.
 * Exported past what the Produces interface lists on purpose, so it can be exercised directly
 * rather than only trusted through `Sentry.init`'s option wiring.
 */
export function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = redactText(ex.value)
    }
  }
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    redactHeaders(event.request.headers)
    if (event.request.url) event.request.url = redactUrl(event.request.url)
    if (event.request.query_string !== undefined) event.request.query_string = redactQueryParams(event.request.query_string)
  }
  scrubKeys(event.extra as Record<string, unknown> | undefined)
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) scrubKeys(event.contexts[key] as Record<string, unknown> | undefined)
  }
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.message && crumb.message.length > BREADCRUMB_MESSAGE_MAX) crumb.message = crumb.message.slice(0, BREADCRUMB_MESSAGE_MAX)
      // Dropped wholesale, not scrubbed key-by-key: the default `consoleIntegration` records
      // `data.arguments` — the raw argument array — beside the formatted message, so
      // `console.error('[pg-boss]', e)` (packages/queue/src/pg-boss.ts, apps/api/src/boss.ts) would
      // otherwise put a raw pg error object (a DatabaseError's `detail`/`where` can repeat the
      // offending row value) into breadcrumb data untruncated. `category`/`type`/`message` still
      // carry the breadcrumb's own information; only the free-form bag is removed. Disabling
      // `consoleIntegration` outright was the alternative — rejected because it would also drop
      // every operationally useful console breadcrumb, not just the risky `data` field.
      delete crumb.data
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
 * Wrapped in try/catch: several `alert()` call sites sit inside last-resort catches
 * (`lifecycle.ts`'s rollback catch) — a throw out of Sentry's own client must never turn an
 * already-handled failure into an unhandled one.
 */
export function alert(
  logger: pino.Logger,
  kind: AlertKind,
  ctx: { orgId?: string | null } & Record<string, string | number | boolean | null>,
): void {
  logger.error({ alert: true, kind, ...ctx }, kind)
  if (!Sentry.isInitialized()) return
  try {
    Sentry.captureMessage(kind, { level: 'error', tags: { org_id: ctx.orgId ?? null, kind } })
  } catch {
    // See the doc comment above — never let Sentry's own failure escape.
  }
}

/**
 * The tRPC plugin's `onError` (INTERNAL_SERVER_ERROR only) funnels through this. A no-op when
 * Sentry isn't initialised, same as `alert`. `scrubJobError` runs on the way in — the same function
 * `@aesa/queue`'s `registerJob` uses before pg-boss ever sees a job's error — so a raw
 * `DrizzleQueryError` (its SQL and bound parameters) is scrubbed before it even becomes an event;
 * `beforeSend` above is the backstop that holds regardless. `withOrg`'s own query failures are
 * exactly the shape that error class wraps, and pino's `err` serializer (`logging.ts`) already
 * redacts it for the LOCAL log line the same `onError` writes — this is the same guarantee for the
 * one that leaves the process. Wrapped in try/catch for the same reason `alert()` is.
 */
export function captureWithOrg(err: unknown, ctx: { orgId?: string | null; job?: string; path?: string }): void {
  if (!Sentry.isInitialized()) return
  try {
    const safe = scrubJobError(err)
    Sentry.withIsolationScope((scope) => {
      scope.setTag('org_id', ctx.orgId ?? null)
      if (ctx.job !== undefined) scope.setTag('job', ctx.job)
      if (ctx.path !== undefined) scope.setTag('path', ctx.path)
      Sentry.captureException(safe)
    })
  } catch {
    // See alert()'s doc comment — never let Sentry's own failure escape.
  }
}
