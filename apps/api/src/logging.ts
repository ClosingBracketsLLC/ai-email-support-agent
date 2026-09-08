import { DrizzleQueryError } from 'drizzle-orm/errors'
import pino from 'pino'
import { redactUrl } from './redact.ts'

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g
/** Short machine codes are safe to log: Postgres SQLSTATEs, Fastify FST_*, Node ECONN*. Never a message. */
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/

/**
 * Masks any URL found inside free-form text (Better Auth log messages, error messages) with redactUrl(), then
 * collapses anything after a `Failed query:` marker — Better Auth's onError path (`api/index.mjs`) can log a
 * drizzle error's plain `.message` string (`Failed query: <sql>\nparams: <bound values>`) directly, not only
 * as an Error object the `err` serializer would otherwise catch.
 */
export function redactText(s: string): string {
  return s.replace(URL_IN_TEXT, (url) => redactUrl(url)).replace(/Failed query:[\s\S]*$/, 'Failed query: [redacted]')
}

interface SerializedError { [key: string]: unknown; type: string; message: string; stack: string; code?: string }

/**
 * pino `err` serializer. Emits type/message/stack (+ a short code) only — never `params`, `query` or `cause`
 * messages: drizzle's DrizzleQueryError message is `Failed query: <sql>\nparams: <bound values>` (session tokens,
 * verification codes) and a pg `cause` repeats the offending value in its own `detail`.
 */
function serializeError(err: Error & { code?: unknown; cause?: unknown }): SerializedError {
  const type = err?.constructor?.name ?? 'Error'
  const raw = err instanceof DrizzleQueryError ? 'Failed query: [redacted]' : String(err?.message ?? err)
  const message = redactText(raw)
  const frames = String(err?.stack ?? '').split('\n').filter((line) => /^\s*at /.test(line))
  const candidate = typeof err?.code === 'string' ? err.code : typeof (err?.cause as { code?: unknown })?.code === 'string' ? (err.cause as { code: string }).code : undefined
  const code = candidate && SAFE_CODE.test(candidate) ? candidate : undefined
  return { type, message, stack: [`${type}: ${message}`, ...frames].join('\n'), ...(code ? { code } : {}) }
}

export interface AppLoggerOptions {
  level: string
  /** Test seam: a pino destination so a suite can assert on the real log output. Production logs to stdout. */
  stream?: pino.DestinationStream
}

/**
 * The one pino instance for the process — shared by Fastify's request/response logging and Better Auth's
 * internal logger (see `betterAuthLogger` below) so every log line, from either source, goes through the
 * same redaction and the same destination.
 */
export function createAppLogger({ level, stream }: AppLoggerOptions): pino.Logger {
  // pino.LoggerOptions (not Parameters<typeof pino>[0]): extracting the parameter type from the overloaded
  // `pino` function loses the CustomLevels default (never), which then makes the return type below mismatch
  // this function's own `pino.Logger` (= Logger<never, boolean>) return type.
  const options: pino.LoggerOptions = {
    level,
    // Defence in depth: the `req` serializer never emits headers, so these paths cannot match today; they stay so
    // that adding a header to that serializer cannot silently start leaking one.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'], censor: '[redacted]' },
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }),
      err: serializeError,
    },
  }
  return stream ? pino(options, stream) : pino(options)
}

type BetterAuthLogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'

/**
 * The shape betterAuth({ logger }) expects — kept local (not re-exported by better-auth or @better-auth/core).
 * `message` is typed `unknown`, not `string`: Better Auth's own documented contract says `string`, but at
 * least one of its call sites (better-auth@1.7.3 dist/api/routes/session.mjs's list-sessions catch block)
 * calls `logger.error(e)` — a raw Error as the sole, positional argument — so the adapter below must survive
 * whatever actually arrives, not only what the type promises. A wider parameter type here is still assignable
 * everywhere Better Auth expects its own (narrower, `string`) `Logger.log`.
 */
export interface BetterAuthLoggerOption {
  level?: 'debug' | 'info' | 'warn' | 'error'
  disableColors?: boolean
  log: (level: BetterAuthLogLevel, message: unknown, ...args: unknown[]) => void
}

/**
 * Routes Better Auth's own diagnostics through the shared pino logger instead of Better Auth's default
 * `console.error`/`console.warn`/`console.log`, which bypasses every redaction guarantee above: the drizzle
 * adapter does not catch query errors, so a raw DrizzleQueryError (session tokens, OTP hashes in its message)
 * can reach Better Auth's logger as an argument and would otherwise print in full.
 */
export function betterAuthLogger(logger: pino.Logger): BetterAuthLoggerOption {
  return {
    level: 'warn',
    disableColors: true,
    log(level, message, ...args) {
      // Named-method dispatch, not a dynamic `logger[level]` index: pino's Logger type is an intersection of
      // named methods, not an index signature, and indexing it by a computed key defeats its own generics.
      const write = level === 'error' ? logger.error.bind(logger)
        : level === 'warn' ? logger.warn.bind(logger)
        : level === 'debug' ? logger.debug.bind(logger)
        : logger.info.bind(logger)   // 'info' and 'success' both land at info
      // `message` itself may be an Error (see the interface note above), not only the `...args`. Either way,
      // only the `err` serializer is allowed to render an Error's own content (it may embed bound SQL
      // parameters) — never this function directly, so a non-string message is replaced with a fixed
      // placeholder rather than stringified. Nothing here may throw regardless of what Better Auth passes.
      const errs = [message, ...args].filter((a): a is Error => a instanceof Error)
      const text = redactText(
        typeof message === 'string' ? message
          : message instanceof Error ? 'better-auth error'
          : `[non-string ${typeof message} message dropped]`,
      )
      if (errs[0]) write({ err: errs[0] }, text)
      else write(text)
    },
  }
}
