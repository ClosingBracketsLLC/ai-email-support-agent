/** The brand files the api serves from apps/api/public/ — a fixed allowlist read at boot, never a file server. No database. */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BRAND_ASSET_PATHS } from '../src/brand/assets.ts'
import { buildServer } from '../src/server.ts'
import { stubDeps } from './helpers/app.ts'

const TYPES: Record<string, string> = {
  '/favicon.svg': 'image/svg+xml', '/favicon.ico': 'image/x-icon', '/favicon-16.png': 'image/png',
  '/favicon-32.png': 'image/png', '/apple-touch-icon.png': 'image/png', '/og.png': 'image/png',
}

describe('brand assets', () => {
  const app = buildServer(stubDeps())
  beforeAll(async () => { await app.ready() })
  afterAll(async () => { await app.close() })

  it('serves exactly the six documented paths', () => {
    expect([...BRAND_ASSET_PATHS].sort()).toEqual(Object.keys(TYPES).sort())
  })

  it.each(Object.keys(TYPES))('GET %s → 200, the committed bytes, a day of public caching, an ETag', async (url) => {
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe(TYPES[url])
    expect(res.headers['cache-control']).toBe('public, max-age=86400')
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]{16}"$/)
    expect(res.rawPayload.equals(readFileSync(new URL(`../public${url}`, import.meta.url)))).toBe(true)
  })

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await app.inject({ method: 'GET', url: '/favicon.ico' })
    const res = await app.inject({ method: 'GET', url: '/favicon.ico', headers: { 'if-none-match': first.headers.etag as string } })
    expect(res.statusCode).toBe(304)
    expect(res.rawPayload.length).toBe(0)
  })

  it('og.png is 1200×630 and favicon.ico is an ICO with three entries', async () => {
    const og = (await app.inject({ method: 'GET', url: '/og.png' })).rawPayload
    expect([og.readUInt32BE(16), og.readUInt32BE(20)]).toEqual([1200, 630])
    const ico = (await app.inject({ method: 'GET', url: '/favicon.ico' })).rawPayload
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3])
  })

  it('anything else under the same names is still a 404 (no directory is exposed)', async () => {
    expect((await app.inject({ method: 'GET', url: '/favicon-64.png' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/public/og.png' })).statusCode).toBe(404)
  })
})
