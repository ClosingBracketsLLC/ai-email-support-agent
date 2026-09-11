import type { Resolver } from '@aesa/crypto'
import type { CrawlFetch } from './crawler/engine.ts'

export interface FakePage {
  status?: number
  headers?: Record<string, string>
  body?: string
}

/** An in-memory site for crawler tests: no real network, no real DNS. `pages` maps a path (with
 * query string, no host — e.g. `/robots.txt`, `/sitemap.xml`, `/a`) to a canned response; a path
 * not in the map answers 404. Every request is recorded, in order, in `hits` (the full URL
 * fetched), so a test can assert both WHAT was fetched and in what ORDER, and — as importantly —
 * what was NEVER fetched at all (a refused hop never appears here).
 *
 * The default resolver is the one the whole crawler test suite is written against: every hostname
 * resolves to the public `93.184.216.34` EXCEPT a name ending in `.internal`, which resolves to
 * the private `10.0.0.5`, and the literal name `metadata.internal`, which resolves to the
 * link-local `169.254.169.254` (the AWS-style metadata address) — used for the "redirect to a
 * private target" case, since `validateOutboundUrl` refuses an IP-literal URL outright and so the
 * redirect's `Location` must be a hostname for `resolvePublic` to be the thing that refuses it. */
export function fakeSite(
  pages: Record<string, FakePage>,
  opts?: { resolver?: Resolver },
): { fetch: CrawlFetch; resolver: Resolver; hits: string[] } {
  const hits: string[] = []

  const resolver: Resolver =
    opts?.resolver ??
    (async (hostname: string) => {
      if (hostname === 'metadata.internal') return [{ address: '169.254.169.254', family: 4 }]
      if (hostname.endsWith('.internal')) return [{ address: '10.0.0.5', family: 4 }]
      return [{ address: '93.184.216.34', family: 4 }]
    })

  const fetch: CrawlFetch = async (url) => {
    hits.push(url)
    const parsed = new URL(url)
    const key = parsed.pathname + parsed.search
    const page = pages[key]
    if (!page) return { status: 404, headers: {}, body: '' }

    const status = page.status ?? 200
    const isRedirect = status >= 300 && status < 400
    // A real HTML response carries a content-type header; a redirect's body is irrelevant and
    // callers set `headers.location` explicitly for those, so no default is forced on them.
    const headers = { ...(isRedirect ? {} : { 'content-type': 'text/html; charset=utf-8' }), ...(page.headers ?? {}) }
    return { status, headers, body: page.body ?? '' }
  }

  return { fetch, resolver, hits }
}
