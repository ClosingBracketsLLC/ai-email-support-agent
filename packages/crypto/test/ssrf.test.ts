import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isBlockedAddress } from '../src/ssrf/ranges.ts'
import { resolvePublic } from '../src/ssrf/resolve-public.ts'
import { buildPinnedDispatcher, fetchThroughPinnedDispatcher, pinnedFetch, validateOutboundUrl } from '../src/ssrf/pinned-fetch.ts'

describe('ssrf ranges', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::'])(
    'blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))
  it.each(['8.8.8.8', '104.18.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false))
})

describe('resolvePublic', () => {
  it('rejects a host with ANY private answer (DNS rebinding defence)', async () => {
    const resolver = async () => [{ address: '104.18.0.1', family: 4 as const }, { address: '10.0.0.1', family: 4 as const }]
    await expect(resolvePublic('evil.example', { resolver })).rejects.toThrow(/private|blocked/i)
  })
  it('returns the first public answer', async () => {
    const resolver = async () => [{ address: '104.18.0.1', family: 4 as const }]
    await expect(resolvePublic('api.example', { resolver })).resolves.toEqual({ address: '104.18.0.1', family: 4 })
  })
})

describe('validateOutboundUrl', () => {
  it('requires https, a hostname (no IP literal) and port 443', () => {
    expect(() => validateOutboundUrl('http://api.example/v1')).toThrow(/https/)
    expect(() => validateOutboundUrl('https://104.18.0.1/v1')).toThrow(/hostname/)
    expect(() => validateOutboundUrl('https://api.example:8443/v1')).toThrow(/port/)
    expect(validateOutboundUrl('https://api.example:8443/v1', { allowNonstandardPort: true }).port).toBe('8443')
  })
})

describe('pinnedFetch', () => {
  it('refuses a private target before any connection is made', async () => {
    const resolver = async () => [{ address: '169.254.169.254', family: 4 as const }]
    await expect(pinnedFetch('https://metadata.example/latest', { resolver })).rejects.toThrow(/blocked/i)
  })

  it('answers an all:true lookup with an array (Node >= 20 autoSelectFamily)', async () => {
    const dispatcher = buildPinnedDispatcher('104.18.0.1', 4)
    type Lookup = (h: string, o: unknown, cb: (e: Error | null, a: unknown, f?: number) => void) => void
    const lookup = (dispatcher as unknown as { pinnedLookup: Lookup }).pinnedLookup
    const all = await new Promise((resolve) => lookup('api.example', { all: true }, (_e, a) => resolve(a)))
    expect(all).toEqual([{ address: '104.18.0.1', family: 4 }])
    const single = await new Promise((resolve) => lookup('api.example', {}, (_e, a, f) => resolve([a, f])))
    expect(single).toEqual(['104.18.0.1', 4])
    await dispatcher.destroy()
  })
})

/**
 * Real sockets: the server listens on 127.0.0.1 but every request names `pinned.invalid`, a host that
 * cannot resolve — so a response at all proves the dispatcher connected to the pinned address.
 */
describe('pinnedFetch transport (real sockets)', () => {
  const LARGE = 256 * 1024
  // Highly repetitive so gzip crushes it — the point is a decoded size far larger than the wire size,
  // so a content-length bug that trusts the origin's (compressed) header is easy to catch.
  const GZIP_PAYLOAD = 'x'.repeat(1080)
  const GZIPPED = gzipSync(GZIP_PAYLOAD)
  let server: Server
  let port = 0

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/small') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('hello')
      if (req.url === '/large') return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(LARGE, 0x61))
      if (req.url === '/redirect') return void res.writeHead(302, { location: 'https://elsewhere.example/' }).end('go away')
      // a HEAD response: the origin declares content-length: 42 (what a GET's body would be) but node
      // sends no body bytes for a HEAD request, whatever is passed to end() — an empty wire body.
      if (req.url === '/head') return void res.writeHead(200, { 'content-length': '42' }).end()
      // an accurate content-length for the COMPRESSED wire bytes, alongside content-encoding: gzip —
      // undici decodes the body before we ever see it, so this header must not survive verbatim.
      if (req.url === '/gzip') {
        return void res
          .writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(GZIPPED.byteLength) })
          .end(GZIPPED)
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))) })

  const get = (path: string, init = {}) =>
    fetchThroughPinnedDispatcher(new URL(`http://pinned.invalid:${port}${path}`), buildPinnedDispatcher('127.0.0.1', 4), init)

  it('connects to the pinned address and returns a small body', async () => {
    const res = await get('/small')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(await res.text()).toBe('hello')
  })

  it('returns a 256 KiB body in full', async () => {
    const res = await get('/large')
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBe(LARGE)
  })

  it('rejects a redirect promptly instead of hanging on its unread body', async () => {
    const started = Date.now()
    await expect(get('/redirect')).rejects.toThrow(/redirect/i)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('rejects a body over maxBodyBytes with code body_too_large', async () => {
    await expect(get('/large', { maxBodyBytes: 1024 })).rejects.toMatchObject({ code: 'body_too_large' })
  })

  it('preserves the origin content-length on a bodyless HEAD-style response', async () => {
    // a HEAD response carries content-length: 42 with an empty body; the guard must not rewrite it to 0
    const res = await get('/head', { method: 'HEAD' })
    expect(res.headers.get('content-length')).toBe('42')
  })

  it('sets content-length to the DECODED size for a compressed body, ignoring the origin\'s wire-size header', async () => {
    expect(GZIPPED.byteLength).toBeLessThan(GZIP_PAYLOAD.length)   // sanity: the fixture is actually compressed
    const res = await get('/gzip')
    expect(res.headers.get('content-length')).toBe(String(GZIP_PAYLOAD.length))
    expect(await res.text()).toBe(GZIP_PAYLOAD)
  })
})
