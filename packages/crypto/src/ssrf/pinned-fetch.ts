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

/** An undici Agent whose connector ignores DNS and connects only to the vetted IP (defeats DNS rebinding between check and use). */
export function buildPinnedDispatcher(address: string, family: 4 | 6): Dispatcher {
  const pinnedLookup = (_host: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) =>
    cb(null, address, family)
  const agent = new Agent({ connect: { lookup: pinnedLookup as never, timeout: 10_000 } })
  return Object.assign(agent, { pinnedLookup })
}

export interface PinnedFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  resolver?: Resolver
  allowNonstandardPort?: boolean
}

/** fetch() for customer-supplied endpoints: https only, resolved to a public IP, pinned, no redirects, bounded time. */
export async function pinnedFetch(input: string, init: PinnedFetchInit = {}): Promise<Response> {
  const url = validateOutboundUrl(input, { allowNonstandardPort: init.allowNonstandardPort })
  const { address, family } = await resolvePublic(url.hostname, { resolver: init.resolver })
  const dispatcher = buildPinnedDispatcher(address, family)
  try {
    const res = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
    if (res.status >= 300 && res.status < 400) throw new Error(`redirects are not followed for outbound URLs (${res.status})`)
    return res as unknown as Response
  } finally {
    await dispatcher.close()
  }
}
