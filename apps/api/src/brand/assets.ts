/**
 * The brand files `pnpm brand:build` writes into apps/api/public/, served by URL from a FIXED allowlist.
 * Read once at registration (they are small and immutable per deploy) — no path parameter ever reaches
 * the filesystem, which is what keeps this from being a file server. The favicons are what a browser
 * asks for on the one-click review pages; og.png is the social card the landing page (its own plan)
 * and platform mail can point at.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

const ASSETS = {
  '/favicon.svg': 'image/svg+xml',
  '/favicon.ico': 'image/x-icon',
  '/favicon-16.png': 'image/png',
  '/favicon-32.png': 'image/png',
  '/apple-touch-icon.png': 'image/png',
  '/og.png': 'image/png',
} as const

export const BRAND_ASSET_PATHS = Object.keys(ASSETS) as (keyof typeof ASSETS)[]

export function registerBrandAssets(app: FastifyInstance): void {
  for (const url of BRAND_ASSET_PATHS) {
    const type = ASSETS[url]
    const body = readFileSync(new URL(`../../public${url}`, import.meta.url))
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`
    app.get(url, async (req, reply) => {
      reply.header('etag', etag).header('cache-control', 'public, max-age=86400')
      if (req.headers['if-none-match'] === etag) return reply.code(304).send()
      return reply.header('content-type', type).send(body)
    })
  }
}
