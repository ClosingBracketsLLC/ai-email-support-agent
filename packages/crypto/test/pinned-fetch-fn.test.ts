import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPinnedFetch, PinnedFetchError } from '../src/index.ts'
import { buildPinnedDispatcher, fetchThroughPinnedDispatcher } from '../src/ssrf/pinned-fetch.ts'
import { startLocalOrigin, type LocalOrigin } from './helpers/ssrf-server.ts'

const privateResolver = async () => [{ address: '10.0.0.5', family: 4 as const }]
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }]
const rebindingResolver = (() => {
  let n = 0
  return async () => (n++ === 0 ? [{ address: '93.184.216.34', family: 4 as const }] : [{ address: '127.0.0.1', family: 4 as const }])
})()

describe('createPinnedFetch', () => {
  it('refuses http, an IP literal, and a hostname that resolves privately', async () => {
    const f = createPinnedFetch({ resolver: privateResolver })
    await expect(f('http://llm.example.com/v1/chat')).rejects.toThrow(/https/)
    await expect(f('https://10.0.0.5/v1/chat')).rejects.toThrow(/hostname/)
    await expect(f('https://llm.example.com/v1/chat')).rejects.toThrow(/private|blocked|public/i)
  })

  it('resolves on EVERY call, so a rebinding hostname is refused on the second request', async () => {
    const f = createPinnedFetch({ resolver: rebindingResolver, timeoutMs: 200 })
    await f('https://llm.example.com/v1/models').catch(() => undefined) // the first resolves public and fails only on connect
    await expect(f('https://llm.example.com/v1/models')).rejects.toThrow(/private|blocked|public/i)
  })

  it('an aborted signal rejects promptly', async () => {
    const f = createPinnedFetch({ resolver: publicResolver })
    const ac = new AbortController()
    ac.abort()
    await expect(f('https://llm.example.com/v1/models', { signal: ac.signal })).rejects.toThrow()
  })

  it('hands the transport the validated URL, the pinned dispatcher, and a redirect: "error" init', async () => {
    const seen: { url: URL; init: Parameters<typeof fetchThroughPinnedDispatcher>[2] }[] = []
    const f = createPinnedFetch({
      resolver: publicResolver,
      timeoutMs: 1234,
      maxBodyBytes: 4096,
      transport: async (url, dispatcher, init) => {
        seen.push({ url, init })
        await dispatcher.destroy()
        return new Response('{}', { status: 200 })
      },
    })
    const ac = new AbortController()
    await f('https://llm.example.com/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      body: '{"model":"m"}',
      signal: ac.signal,
    })

    const call = seen[0]!
    expect(call.url.href).toBe('https://llm.example.com/v1/chat')
    expect(call.init?.method).toBe('POST')
    expect(call.init?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test' })
    expect(call.init?.body).toBe('{"model":"m"}')
    expect(call.init?.signal).toBe(ac.signal)
    expect(call.init?.redirect).toBe('error')
    expect(call.init?.timeoutMs).toBe(1234)
    expect(call.init?.maxBodyBytes).toBe(4096)
  })
})

/**
 * The real transport, against a real socket. `resolvePublic` refuses loopback, so the full
 * createPinnedFetch path can never reach a local origin — the `transport` seam substitutes the
 * DESTINATION only, keeping the init createPinnedFetch itself built (method, headers, body,
 * redirect: 'error') and the real `fetchThroughPinnedDispatcher` under test.
 */
describe('createPinnedFetch over the real transport (local origin)', () => {
  let origin: LocalOrigin

  beforeAll(async () => {
    origin = await startLocalOrigin((req, res) => {
      if (req.url === '/redirect') return void res.writeHead(302, { location: 'https://elsewhere.example/' }).end('go away')
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
    })
  })
  afterAll(async () => { await origin.close() })

  const localFetch = () =>
    createPinnedFetch({
      resolver: publicResolver,
      timeoutMs: 5_000,
      transport: (url, _dispatcher, init) =>
        fetchThroughPinnedDispatcher(new URL(`http://pinned.invalid:${origin.port}${url.pathname}`), buildPinnedDispatcher('127.0.0.1', 4), init),
    })

  it('forwards method, headers and body to the origin', async () => {
    const res = await localFetch()('https://llm.example.com/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: '{"model":"m"}',
    })
    const echo = (await res.json()) as { method: string; url: string; headers: Record<string, string>; body: string }
    expect(echo.method).toBe('POST')
    expect(echo.url).toBe('/v1/chat')
    expect(echo.headers['content-type']).toBe('application/json')
    expect(echo.headers.authorization).toBe('Bearer sk-test')
    expect(echo.body).toBe('{"model":"m"}')
  })

  it('throws PinnedFetchError(redirect_not_followed) on a 3xx instead of following it', async () => {
    const err = await localFetch()('https://llm.example.com/redirect').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PinnedFetchError)
    expect((err as PinnedFetchError).code).toBe('redirect_not_followed')
  })

  it('forwards an abort raised mid-flight', async () => {
    const ac = new AbortController()
    const pending = localFetch()('https://llm.example.com/v1/chat', { method: 'POST', body: 'x', signal: ac.signal })
    ac.abort()
    await expect(pending).rejects.toThrow()
  })
})
