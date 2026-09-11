import { describe, expect, it } from 'vitest'
import { CrawlError, crawlSite, Frontier, type CrawlFetch } from '../src/index.ts'
import { fakeSite, type FakePage } from './fake-site.ts'

const SITE = 'https://acme.example'

function page(heading: string, text: string, extraHtml: string[] = []): FakePage {
  return { body: `<h1>${heading}</h1><p>${text}</p>${extraHtml.join('')}` }
}

function sitemapXml(urls: string[]): string {
  return `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('crawlSite', () => {
  it('1. sitemap-first order: sitemap URLs are ingested before the start URL\'s own links, and robots+sitemap are fetched first', async () => {
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemap.xml` },
      '/sitemap.xml': { body: sitemapXml([`${SITE}/b`, `${SITE}/a`]) },
      '/': { body: '<nav><a href="/c">Next</a></nav>' }, // nav-only: no text of its own, but its link is still followed
      '/b': page('B', 'Page b content.'),
      '/a': page('A', 'Page a content.'),
      '/c': page('C', 'Page c content.'),
    })
    const ingestedUrls: string[] = []
    await crawlSite({
      startUrl: `${SITE}/`, maxPages: 3, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (pages) => { ingestedUrls.push(...pages.map((p) => p.url)) },
    })
    expect(ingestedUrls).toEqual([`${SITE}/b`, `${SITE}/a`, `${SITE}/c`])
    expect(site.hits.slice(0, 2)).toEqual([`${SITE}/robots.txt`, `${SITE}/sitemap.xml`])
  })

  it('2. the first `firstBatch` pages flush immediately, the rest flush at the end', async () => {
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemap.xml` },
      '/sitemap.xml': { body: sitemapXml([`${SITE}/b`, `${SITE}/a`]) },
      '/': { body: '<nav><a href="/c">Next</a></nav>' },
      '/b': page('B', 'Page b content.'),
      '/a': page('A', 'Page a content.'),
      '/c': page('C', 'Page c content.'),
    })
    const batches: string[][] = []
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: 3, firstBatch: 2, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (pages) => { batches.push(pages.map((p) => p.url)) },
    })
    expect(batches).toEqual([[`${SITE}/b`, `${SITE}/a`], [`${SITE}/c`]])
    expect(summary.ingested).toBe(3)
  })

  it('3. a robots Disallow rule is never fetched, and counts toward skipped', async () => {
    const site = fakeSite({
      '/robots.txt': { body: 'User-agent: *\nDisallow: /private' },
      '/': { body: '<h1>Home</h1><p>Welcome to Acme.</p><a href="/private">Private</a><a href="/public">Public</a>' },
      '/private': page('Private', 'Secret content.'),
      '/public': page('Public', 'Public content.'),
    })
    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(site.hits).not.toContain(`${SITE}/private`)
    expect(summary.ingested).toBe(2)
    expect(summary.skipped).toBe(1)
  })

  it('4. a link to a private address is refused private_address; a link to another site is refused off_site — neither is ever fetched', async () => {
    const site = fakeSite({
      // No /robots.txt entry at all: a missing robots.txt (404) means no rules, and the crawl
      // still proceeds — robots.txt is still fetched FIRST, though (rule 2's ordering half).
      '/': { body: `<h1>Home</h1><p>Welcome.</p><a href="https://api.internal/x">Internal</a><a href="https://other.example/">Other</a>` },
    })
    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(site.hits[0]).toBe(`${SITE}/robots.txt`)
    expect(site.hits).not.toContain('https://api.internal/x')
    expect(site.hits).not.toContain('https://other.example/')
    expect(summary.refused).toContainEqual({ url: 'https://api.internal/x', reason: 'private_address' })
    expect(summary.refused).toContainEqual({ url: 'https://other.example/', reason: 'off_site' })
    expect(summary.ingested).toBe(1)
  })

  it('5. redirects: a same-site hop is followed and ingested under its own URL; a hop to a private address is refused with no fetch of the target; a 4th chained redirect is too_many_redirects', async () => {
    // 5a: a 302 is followed to its (same-site, public) target.
    const followed = fakeSite({
      '/': { body: '<h1>Home</h1><p>Welcome.</p><a href="/old">Old</a>' },
      '/old': { status: 302, headers: { location: `${SITE}/new` } },
      '/new': page('New', 'New page content.'),
    })
    const ingestedA: string[] = []
    await crawlSite({
      startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: followed.fetch, resolver: followed.resolver, signal: signal(),
      onBatch: async (pages) => { ingestedA.push(...pages.map((p) => p.url)) },
    })
    expect(ingestedA).toContain(`${SITE}/new`)
    expect(followed.hits).toContain(`${SITE}/old`)
    expect(followed.hits).toContain(`${SITE}/new`)

    // 5b: a 302 to a HOSTNAME the resolver maps to a link-local address (169.254.169.254) is
    // refused by `resolvePublic` re-validating the hop — `validateOutboundUrl` would refuse an
    // IP-literal Location outright, so the target must be a hostname for THIS gate to be the one
    // that catches it.
    const metadata = fakeSite({
      '/': { body: '<h1>Home</h1><p>Welcome.</p><a href="/danger">Danger</a>' },
      '/danger': { status: 302, headers: { location: 'https://metadata.internal/latest' } },
    })
    const summaryB = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: metadata.fetch, resolver: metadata.resolver, signal: signal(), onBatch: async () => {} })
    expect(metadata.hits).toContain(`${SITE}/danger`)
    expect(metadata.hits).not.toContain('https://metadata.internal/latest')
    expect(summaryB.refused).toContainEqual({ url: 'https://metadata.internal/latest', reason: 'private_address' })

    // 5c: four chained redirects exceed the 3-hop limit; the 5th page is never reached.
    const chained = fakeSite({
      '/': { body: '<h1>Home</h1><p>Welcome.</p><a href="/r1">R1</a>' },
      '/r1': { status: 302, headers: { location: `${SITE}/r2` } },
      '/r2': { status: 302, headers: { location: `${SITE}/r3` } },
      '/r3': { status: 302, headers: { location: `${SITE}/r4` } },
      '/r4': { status: 302, headers: { location: `${SITE}/r5` } },
      '/r5': page('R5', 'Should never be reached.'),
    })
    const summaryC = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: chained.fetch, resolver: chained.resolver, signal: signal(), onBatch: async () => {} })
    expect(summaryC.refused.some((r) => r.reason === 'too_many_redirects')).toBe(true)
    expect(chained.hits).not.toContain(`${SITE}/r5`)
  })

  it('6. noindex is skipped; a mismatched canonical queues the canonical and skips itself; duplicate content ingests once', async () => {
    const site = fakeSite({
      '/': { body: `<h1>Home</h1><p>Welcome.</p><a href="/noindexed">N</a><a href="/has-canonical">C</a><a href="/dupA">A</a><a href="/dupB">B</a>` },
      '/noindexed': { body: '<meta name="robots" content="noindex"><h1>Hidden</h1><p>Should not be ingested.</p>' },
      '/has-canonical': { body: `<link rel="canonical" href="${SITE}/canonical-target"><h1>Alt</h1><p>Alternate URL for the same page.</p>` },
      '/canonical-target': page('Canonical', 'The canonical page content.'),
      '/dupA': page('Dup', 'Exactly identical duplicate content.'),
      '/dupB': page('Dup', 'Exactly identical duplicate content.'),
    })
    const ingestedUrls: string[] = []
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: 10, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (pages) => { ingestedUrls.push(...pages.map((p) => p.url)) },
    })
    expect(ingestedUrls).not.toContain(`${SITE}/noindexed`)
    expect(ingestedUrls).not.toContain(`${SITE}/has-canonical`)
    expect(ingestedUrls).toContain(`${SITE}/canonical-target`)
    const dupsIngested = ingestedUrls.filter((u) => u === `${SITE}/dupA` || u === `${SITE}/dupB`)
    expect(dupsIngested).toHaveLength(1)
    expect(summary.ingested).toBe(3) // '/', the canonical target, and exactly one of the duplicates
    expect(summary.skipped).toBe(3) // noindexed, has-canonical, and the losing duplicate
  })

  it('7. maxPages counts ingested pages only, even with a bigger sitemap; the Frontier enforces its own maxSeen cap', async () => {
    const site = fakeSite({
      // No robots.txt at all: falls back to /sitemap.xml (rule 3's fallback half).
      '/sitemap.xml': { body: sitemapXml([`${SITE}/p1`, `${SITE}/p2`, `${SITE}/p3`, `${SITE}/p4`, `${SITE}/p5`]) },
      '/': { body: '<nav><a href="/never-reached">N</a></nav>' },
      '/p1': page('P1', 'One.'), '/p2': page('P2', 'Two.'), '/p3': page('P3', 'Three.'), '/p4': page('P4', 'Four.'), '/p5': page('P5', 'Five.'),
    })
    const ingestedUrls: string[] = []
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: 1, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (pages) => { ingestedUrls.push(...pages.map((p) => p.url)) },
    })
    expect(summary.ingested).toBe(1)
    expect(ingestedUrls).toEqual([`${SITE}/p1`])

    const frontier = new Frontier({ maxSeen: 3 })
    frontier.add(['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4', 'https://a.example/5'], 'link')
    expect(frontier.seen.size).toBe(3)
  })

  it('8. an http start URL fails crawl_failed; an IP-literal start URL is refused too — neither ever fetches', async () => {
    const site = fakeSite({})
    await expect(
      crawlSite({ startUrl: 'http://acme.example', maxPages: 1, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} }),
    ).rejects.toThrow(/https/)
    await expect(
      crawlSite({ startUrl: 'http://acme.example', maxPages: 1, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} }),
    ).rejects.toMatchObject({ name: 'CrawlError', code: 'crawl_failed' })

    await expect(
      crawlSite({ startUrl: 'https://93.184.216.34/', maxPages: 1, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} }),
    ).rejects.toBeInstanceOf(CrawlError)

    expect(site.hits).toHaveLength(0)
  })

  it('9. an already-aborted signal returns immediately, without any fetch', async () => {
    const site = fakeSite({ '/': page('Home', 'Welcome.') })
    const controller = new AbortController()
    controller.abort()
    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: controller.signal, onBatch: async () => {} })
    expect(summary).toEqual({ fetched: 0, ingested: 0, skipped: 0, refused: [] })
    expect(site.hits).toHaveLength(0)
  })

  it('10. every request carries the crawler User-Agent and an html Accept header', async () => {
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemap.xml` },
      '/sitemap.xml': { body: sitemapXml([`${SITE}/p1`]) },
      '/p1': page('P1', 'Content.'),
    })
    const seenHeaders: Record<string, string>[] = []
    const wrappedFetch: CrawlFetch = async (url, init) => {
      seenHeaders.push(init.headers)
      return site.fetch(url, init)
    }
    await crawlSite({ startUrl: `${SITE}/`, maxPages: 2, delayMs: 0, fetch: wrappedFetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(seenHeaders.length).toBeGreaterThan(0)
    for (const h of seenHeaders) {
      expect(h['user-agent']).toBe('aesa-crawler/1.0 (+https://aesa.app)')
      expect(h['accept']).toBe('text/html')
    }
  })

  it('11. a sitemap URL for a different site is refused off_site and never fetched', async () => {
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemap.xml` },
      '/sitemap.xml': { body: sitemapXml([`${SITE}/local`, 'https://other.example/foreign']) },
      '/': { body: '<nav></nav>' },
      '/local': page('Local', 'Local content.'),
    })
    const ingestedUrls: string[] = []
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (pages) => { ingestedUrls.push(...pages.map((p) => p.url)) },
    })
    expect(ingestedUrls).toEqual([`${SITE}/local`])
    expect(site.hits).not.toContain('https://other.example/foreign')
    expect(summary.refused).toContainEqual({ url: 'https://other.example/foreign', reason: 'off_site' })
  })

  it('12. only a 2xx text/html* body within the size bound is parsed: wrong content-type, oversized, and non-2xx are all skipped', async () => {
    const oversized = 'x'.repeat(2 * 1024 * 1024 + 1)
    const site = fakeSite({
      '/': { body: '<h1>Home</h1><p>Welcome.</p><a href="/pdf">PDF</a><a href="/big">Big</a><a href="/broken">Broken</a>' },
      '/pdf': { headers: { 'content-type': 'application/pdf' }, body: '<h1>Not actually html</h1>' },
      '/big': { body: oversized },
      '/broken': { status: 500, body: '<h1>Server error</h1>' },
    })
    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(summary.ingested).toBe(1)
    expect(summary.skipped).toBe(3)
  })

  it('13. never runs more than `concurrency` fetches at once, and genuinely overlaps up to that many', async () => {
    const pages: Record<string, FakePage> = {
      '/': { body: `<h1>Home</h1><p>Welcome.</p>${[0, 1, 2, 3].map((i) => `<a href="/p${i}">p${i}</a>`).join('')}` },
    }
    for (const i of [0, 1, 2, 3]) pages[`/p${i}`] = page(`P${i}`, `Content ${i}.`)
    const site = fakeSite(pages)

    let inFlight = 0
    let peak = 0
    const trackedFetch: CrawlFetch = async (url, init) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      try {
        return await site.fetch(url, init)
      } finally {
        inFlight--
      }
    }

    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, concurrency: 2, delayMs: 0, fetch: trackedFetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(summary.ingested).toBe(5)
    expect(peak).toBe(2)
  })

  it('14. delayMs enforces a minimum gap between requests to the same host', async () => {
    const site = fakeSite({
      '/': { body: '<h1>Home</h1><p>Welcome.</p><a href="/p1">1</a><a href="/p2">2</a>' },
      '/p1': page('P1', 'One.'),
      '/p2': page('P2', 'Two.'),
    })
    const timestamps: number[] = []
    const trackedFetch: CrawlFetch = async (url, init) => {
      timestamps.push(Date.now())
      return site.fetch(url, init)
    }
    await crawlSite({ startUrl: `${SITE}/`, maxPages: 3, concurrency: 1, delayMs: 30, fetch: trackedFetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(timestamps.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]! - timestamps[i - 1]!).toBeGreaterThanOrEqual(25)
    }
  })
})
