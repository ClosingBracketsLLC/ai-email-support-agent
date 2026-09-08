import { DrizzleQueryError } from 'drizzle-orm/errors'
import pino from 'pino'
import { redactUrl } from './redact.ts'

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g
/** Short machine codes are safe to log: Postgres SQLSTATEs, Fastify FST_*, Node ECONN*. Never a message. */
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/

/** Masks any URL found inside free-form text (Better Auth log messages, error messages) with redactUrl(). */
export function redactText(s: string): string {
  return s.replace(URL_IN_TEXT, (url) => redactUrl(url))
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

/** The shape betterAuth({ logger }) expects — kept local (not re-exported by better-auth or @better-auth/core). */
export interface BetterAuthLoggerOption {
  level?: 'debug' | 'info' | 'warn' | 'error'
  disableColors?: boolean
  log: (level: BetterAuthLogLevel, message: string, ...args: unknown[]) => void
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
      // Only an Error argument is kept (as `err`, so the serializer above collapses/redacts it); anything
      // else Better Auth passes (raw strings, request bodies) is dropped rather than logged verbatim.
      const err = args.find((a): a is Error => a instanceof Error)
      const text = redactText(message)
      if (err) write({ err }, text)
      else write(text)
    },
  }
}
