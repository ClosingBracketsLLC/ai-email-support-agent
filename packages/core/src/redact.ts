/**
 * Ruling R25 (Task 11 fix round 2): the ONE home for every pure redaction/scrub helper the api and
 * the worker both need for their Sentry `beforeSend` PII boundary, and that the api's own pino
 * `err`/`req` serializers already used before Sentry entered the picture. Before this ruling,
 * `apps/api/src/redact.ts`/`logging.ts` held the originals and `apps/worker/src/observability.ts`
 * carried a hand-diffed duplicate — "checked manually once" is not parity for a security boundary,
 * and the next edit to one copy would not have reached the other. `@aesa/core` depends on nothing
 * but `@aesa/contracts` and `zod`; every function here is a pure string/object transform (`URL` is
 * a global), so this adds no new dependency to either app.
 *
 * `apps/api/src/redact.ts` is now a bare re-export of `redactUrl`; `apps/api/src/logging.ts`
 * imports `redactText`/`redactUrl` from here (and re-exports `redactText` itself, since
 * `logging.test.ts` still imports it from there); both `observability.ts` files import everything
 * below and carry no private copies.
 */

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g

/** Every query value and any path segment that looks like a token (base64url, 32+ chars) is masked before logging. */
export function redactUrl(url: string): string {
  const [path, query] = url.split('?', 2)
  const safePath = path!.split('/').map((seg) => (/^[A-Za-z0-9_-]{32,}$/.test(seg) && !/^[0-9a-f-]{36}$/i.test(seg) ? '[redacted]' : seg)).join('/')
  if (query === undefined) return safePath
  const safeQuery = query.split('&').map((pair) => { const i = pair.indexOf('='); return i === -1 ? pair : `${pair.slice(0, i)}=[redacted]` }).join('&')
  return `${safePath}?${safeQuery}`
}

/**
 * Masks any URL found inside free-form text (Better Auth log messages, error messages, a Sentry
 * exception value, a breadcrumb message, a `referer`/`origin` header value that carries a
 * `/a/:draftId?t=<action-token>` URL after following a link) with `redactUrl()`, then collapses
 * anything after a `Failed query:` marker — a drizzle error's plain `.message` string
 * (`Failed query: <sql>\nparams: <bound values>`) can reach this either as an Error object's
 * message or as free text Better Auth's own logger sometimes passes directly.
 */
export function redactText(s: string): string {
  return s.replace(URL_IN_TEXT, (url) => redactUrl(url)).replace(/Failed query:[\s\S]*$/, 'Failed query: [redacted]')
}

/** Lower-cased key names `scrubKeys` strips wherever they appear — a request body, a customer's
 *  question or answer text, a provider credential, a session cookie, a bearer token. The compare is
 *  case-insensitive (`Authorization` is caught, not only `authorization`). */
export const SCRUB_KEYS: ReadonlySet<string> = new Set([
  'body', 'bodytext', 'detail', 'payload', 'apikey', 'key', 'token', 'cookie', 'authorization',
])

const SCRUB_MAX_DEPTH = 3

/**
 * Deletes every `SCRUB_KEYS` match found in `rec`, recursing into nested PLAIN objects (not arrays)
 * up to `SCRUB_MAX_DEPTH` levels — `extra.request.body`, not only a top-level `extra.body`. Used on
 * a Sentry event's `extra` and on each of its `contexts` entries.
 */
export function scrubKeys(rec: Record<string, unknown> | undefined, depth = 0): void {
  if (!rec || depth > SCRUB_MAX_DEPTH) return
  for (const key of Object.keys(rec)) {
    if (SCRUB_KEYS.has(key.toLowerCase())) { delete rec[key]; continue }
    const value = rec[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) scrubKeys(value as Record<string, unknown>, depth + 1)
  }
}

/** Header names deleted outright rather than merely redacted — a live credential, never partial text. */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set(['cookie', 'authorization', 'x-api-key'])

/**
 * Deletes every `SENSITIVE_HEADER_NAMES` match (case-insensitive), then runs every REMAINING header
 * value through `redactText` — a `referer` or `origin` header following navigation from
 * `/a/:draftId?t=<token>` carries that token verbatim, and header NAME filtering alone never
 * touches it. Mutates `headers` in place, like `scrubKeys`.
 */
export function redactHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) { delete headers[key]; continue }
    const value = headers[key]
    // The declared type says string, but the value arrives from a Sentry event nobody validated
    // (`string[]` for a repeated header, a number, null). A scrubber never throws: anything that
    // is not a string is dropped rather than passed through unredacted.
    if (typeof value === 'string') headers[key] = redactText(value)
    else delete headers[key]
  }
}

/** Sentry's own `RequestEventData['query_string']` shape, restated here without importing
 *  `@sentry/node` — this package takes no Sentry dependency; the api/worker's own `event.request`
 *  handling is structurally assignable to and from this. */
export type QueryParamsLike = string | Record<string, string> | Array<[string, string]>

/**
 * Same value-masking convention as `redactUrl`'s query branch, generalised over the three
 * `QueryParamsLike` shapes (a raw `t=<action-token>` string, an object, or `[key, value]` pairs) —
 * every value replaced, every key kept. Guards `null` as well as `undefined`: no Sentry path
 * assigns `query_string: null` today, but a scrubber must never be the thing that throws, and
 * `null` is normalised to `undefined` (the field's own declared "absent" state) rather than
 * echoed back.
 */
export function redactQueryParams(qs: QueryParamsLike | null | undefined): QueryParamsLike | undefined {
  if (qs === undefined || qs === null) return undefined
  if (typeof qs === 'string') return qs.split('&').map((pair) => { const i = pair.indexOf('='); return i === -1 ? pair : `${pair.slice(0, i)}=[redacted]` }).join('&')
  if (Array.isArray(qs)) return qs.map(([key]) => [key, '[redacted]'] as [string, string])
  return Object.fromEntries(Object.keys(qs).map((key) => [key, '[redacted]'])) as Record<string, string>
}

/** The cap a Sentry breadcrumb's `message` is truncated to, AFTER redaction (never before — cutting
 *  first can slice off "Failed query:" or a URL's own scheme partway through and leave the tail,
 *  the actually sensitive half, past the cap and therefore never seen by either replace()). */
const BREADCRUMB_MESSAGE_MAX = 200

/**
 * `redactText` then truncate — in that order. The default `consoleIntegration` builds a breadcrumb
 * from `util.format(...args)`, so `console.error('[pg-boss]', someDrizzleQueryError)` renders that
 * error's full `Failed query: <sql>\nparams: <bound values>` into `message` well inside the first
 * 200 characters; truncating alone (the pre-R25 behaviour) never touched it. Breadcrumbs ride along
 * on whatever event is captured NEXT, so this can attach one ticket's customer text to an entirely
 * unrelated later error if left unredacted.
 */
export function redactBreadcrumbMessage(message: string): string {
  return redactText(message).slice(0, BREADCRUMB_MESSAGE_MAX)
}
