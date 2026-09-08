import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { resolvePublic, type Resolver } from './resolve-public.ts'

export function validateOutboundUrl(input: string, opts: { allowNonstandardPort?: boolean } = {}): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new Error('outbound URL must use https')
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new Error('outbound URL must use a hostname, not an IP literal')
  if (url.port && url.port !== '443' && !opts.allowNonstandardPort) throw new Error('outbound URL port must be 443')
  if (url.username || url.password) throw new Error('outbound URL must not carry credentials')
  return url
}

export type PinnedFetchErrorCode = 'redirect_not_followed' | 'body_too_large'

export class PinnedFetchError extends Error {
  readonly code: PinnedFetchErrorCode
  constructor(message: string, code: PinnedFetchErrorCode) {
    super(message)
    this.name = 'PinnedFetchError'
    this.code = code
  }
}

/** An undici Agent whose connector ignores DNS and connects only to the vetted IP (defeats DNS rebinding between check and use). */
export function buildPinnedDispatcher(address: string, family: 4 | 6): Dispatcher {
  // Node >= 20 has autoSelectFamily on by default, which calls lookup(host, { all: true }, cb) and expects
  // an ARRAY; the single-address callback shape makes every connection fail with "Invalid IP address:
  // undefined". Answer both shapes, and turn happy-eyeballs off — there is only ever one pinned address.
  const pinnedLookup = (
    _host: string,
    opts: unknown,
    cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void,
  ) =>
    opts && typeof opts === 'object' && (opts as { all?: boolean }).all
      ? cb(null, [{ address, family }])
      : cb(null, address, family)
  const agent = new Agent({ connect: { lookup: pinnedLookup as never, timeout: 10_000, autoSelectFamily: false } })
  return Object.assign(agent, { pinnedLookup })
}

export interface PinnedTransportInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Hard cap on the response body; the read aborts and the connection is destroyed past it. */
  maxBodyBytes?: number
}

export interface PinnedFetchInit extends PinnedTransportInit {
  resolver?: Resolver
  allowNonstandardPort?: boolean
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024

/**
 * The transport half of pinnedFetch: no URL validation and no DNS of its own — it fetches `url` through
 * `dispatcher`, refuses redirects, and buffers the body under `maxBodyBytes` BEFORE the dispatcher is
 * closed (closing an Agent waits for the in-flight request, which cannot finish while its body is
 * unread — that deadlocked every response larger than the socket buffer). Owns the dispatcher: closed
 * after a complete read, destroyed on every rejection path. Exported so tests can drive it over a real socket.
 */
export async function fetchThroughPinnedDispatcher(url: URL, dispatcher: Dispatcher, init: PinnedTransportInit = {}): Promise<Response> {
  const maxBodyBytes = init.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  try {
    const res = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
    if (res.status >= 300 && res.status < 400) {
      throw new PinnedFetchError(`redirects are not followed for outbound URLs (${res.status})`, 'redirect_not_followed')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > maxBodyBytes) throw new PinnedFetchError(`response body exceeds ${maxBodyBytes} bytes`, 'body_too_large')
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    await dispatcher.close()
    // undici already decoded any content-encoding, so the upstream encoding/length headers would lie.
    const headers = new Headers([...res.headers])
    headers.delete('content-encoding')
    headers.set('content-length', String(body.byteLength))
    return new Response(body.byteLength === 0 ? null : body, { status: res.status, statusText: res.statusText, headers })
  } catch (err) {
    await dispatcher.destroy()
    throw err
  }
}

/** fetch() for customer-supplied endpoints: https only, resolved to a public IP, pinned, no redirects, bounded time and size. */
export async function pinnedFetch(input: string, init: PinnedFetchInit = {}): Promise<Response> {
  const url = validateOutboundUrl(input, { allowNonstandardPort: init.allowNonstandardPort })
  const { address, family } = await resolvePublic(url.hostname, { resolver: init.resolver })
  return fetchThroughPinnedDispatcher(url, buildPinnedDispatcher(address, family), init)
}
