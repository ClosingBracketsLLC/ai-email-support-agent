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
 * **The PII boundary is `beforeSend`, and it is EVENT-level, not call-site-level.** `alert()` and
 * `captureWithOrg()` are not the only way an error reaches Sentry: `onUncaughtExceptionIntegration`
 * and `onUnhandledRejectionIntegration` are DEFAULT integrations and call `Sentry.captureException`
 * on the raw error directly, bypassing both helpers entirely. `beforeSend` is the one place that
 * runs on every event regardless of how it was captured, so it — not a per-call-site scrub — is
 * what has to guarantee a `DrizzleQueryError`'s SQL/bound-parameters (`final_body` for a `drafts`
 * row is customer reply text), a session's headers, or a `/a/:draftId?t=` action token never leave
 * this process. `@aesa/queue`'s `scrubJobError` (used by `registerJob`'s catch AND defensively
 * inside `captureWithOrg` below) is still worth keeping — it's cheaper and catches the common job
 * path before the event is even built — but `beforeSend` is the actual guarantee.
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
/** Header names `beforeSend` deletes outright from `event.request.headers` — the same set the
 *  worker's own `createWorkerLogger` redacts (`authorization`) plus `cookie`, which a Fastify
 *  request never reaches this process to redact via that path, but the event-level boundary still
 *  has to hold if a future integration ever attaches one here. */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set(['cookie', 'authorization', 'x-api-key'])

function scrubKeys(rec: Record<string, unknown> | undefined, depth = 0): void {
  if (!rec || depth > SCRUB_MAX_DEPTH) return
  for (const key of Object.keys(rec)) {
    if (SCRUB_KEYS.has(key.toLowerCase())) { delete rec[key]; continue }
    const value = rec[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) scrubKeys(value as Record<string, unknown>, depth + 1)
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g

/**
 * Duplicates `apps/api/src/redact.ts`'s `redactUrl` exactly (same masking rule for a full URL
 * string: any path segment that looks like a token, every query value). The worker has no
 * `redact.ts` of its own to import from — it has no Fastify request path, so `event.request.url`
 * is dead code here today unless some future integration populates it — but the rule has to be
 * identical wherever it applies, which is why this is a literal copy, not an approximation.
 */
function redactUrl(url: string): string {
  const [path, query] = url.split('?', 2)
  const safePath = path!.split('/').map((seg) => (/^[A-Za-z0-9_-]{32,}$/.test(seg) && !/^[0-9a-f-]{36}$/i.test(seg) ? '[redacted]' : seg)).join('/')
  if (query === undefined) return safePath
  const safeQuery = query.split('&').map((pair) => { const i = pair.indexOf('='); return i === -1 ? pair : `${pair.slice(0, i)}=[redacted]` }).join('&')
  return `${safePath}?${safeQuery}`
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
 * Mirrors `apps/api/src/logging.ts`'s `redactText`'s "Failed query:" collapse (mask any URL, then
 * blank everything after `Failed query:`) — a deliberate duplication of that SAME rule, not a
 * second one, for the reason the module doc comment above gives: by the time an event reaches
 * `beforeSend`, Sentry has already turned the thrown Error into a plain `{ type, value }` pair, so
 * this has to be pattern-based (there is no `instanceof DrizzleQueryError` left to check), and the
 * worker has no `logging.ts` helper of its own to reach across the app boundary for.
 */
function redactExceptionValue(value: string): string {
  return value.replace(URL_IN_TEXT, (url) => redactUrl(url)).replace(/Failed query:[\s\S]*$/, 'Failed query: [redacted]')
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
      if (ex.value) ex.value = redactExceptionValue(ex.value)
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
 * (`workspace-purge.ts`'s rows phase, which rethrows; `report-usage.ts`'s `op: 'record'` catch) —
 * a throw out of Sentry's own client must never turn an already-handled failure into an unhandled
 * one.
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
 * The job observer's real implementation, wired at boot via `setJobObserver`. A no-op when Sentry
 * isn't initialised, same as `alert`. `scrubJobError` runs on the way in — the SAME function
 * `registerJob`'s own catch uses before pg-boss ever sees the error — so a raw `DrizzleQueryError`
 * (its SQL and bound parameters) is scrubbed before it even becomes an event; `beforeSend` above is
 * the backstop that holds regardless. `registerJob` already scrubs before calling
 * `notifyJobFailure`, so this is a second, defensive layer for any OTHER caller of
 * `captureWithOrg` — cheap, and idempotent on an already-scrubbed error. Wrapped in try/catch for
 * the same reason `alert()` is.
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
