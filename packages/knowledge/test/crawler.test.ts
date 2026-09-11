import { describe, expect, it } from 'vitest'
import { collectSitemapSeeds, CrawlError, crawlSite, Frontier, normalizeUrl, validateHop, type CrawlFetch } from '../src/index.ts'
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

  it('15. the politeness delay is enforced across concurrent workers too, not just within one worker (review finding 1)', async () => {
    const extra = [0, 1, 2, 3, 4, 5]
    const pages: Record<string, FakePage> = { '/': { body: `<h1>Home</h1><p>Welcome.</p>${extra.map((i) => `<a href="/p${i}">p${i}</a>`).join('')}` } }
    for (const i of extra) pages[`/p${i}`] = page(`P${i}`, `Content ${i}.`)
    const site = fakeSite(pages)
    const timestamps: number[] = []
    const trackedFetch: CrawlFetch = async (url, init) => {
      timestamps.push(Date.now())
      return site.fetch(url, init)
    }
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: 7, concurrency: 2, delayMs: 20, fetch: trackedFetch, resolver: site.resolver, signal: signal(),
      onBatch: async () => {},
    })
    expect(summary.ingested).toBe(7)
    expect(timestamps.length).toBeGreaterThanOrEqual(7)
    // Every same-host fetch is spaced by at least delayMs, INCLUDING the two members of a
    // concurrent wave — the old bug let a wave's pair fire together (a ~0ms gap here) since the
    // slot was claimed only after the delay was awaited, not before.
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]! - timestamps[i - 1]!).toBeGreaterThanOrEqual(15)
    }
  })

  it('16. a sitemapindex with more children than the fetch cap only fetches the cap\'s worth (review finding 2)', async () => {
    const children = [1, 2, 3, 4, 5, 6, 7]
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemapindex.xml` },
      '/sitemapindex.xml': { body: `<sitemapindex>${children.map((i) => `<sitemap><loc>${SITE}/child${i}.xml</loc></sitemap>`).join('')}</sitemapindex>` },
      ...Object.fromEntries(children.map((i) => [`/child${i}.xml`, { body: sitemapXml([`${SITE}/page${i}`]) }])),
      '/': { body: '<nav></nav>' },
    })
    await crawlSite({ startUrl: `${SITE}/`, maxPages: 10, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    const sitemapHits = site.hits.filter((h) => h.includes('sitemapindex.xml') || h.includes('/child'))
    expect(sitemapHits).toHaveLength(5) // the index itself + 4 of the 7 children (5 sitemap-file fetches total)
  })

  it('17. an onBatch failure aborts the crawl as crawl_failed, without silently losing pages (review finding 4)', async () => {
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemap.xml` },
      '/sitemap.xml': { body: sitemapXml([`${SITE}/b`, `${SITE}/a`]) },
      '/': { body: '<nav><a href="/c">Next</a></nav>' },
      '/b': page('B', 'Page b content.'),
      '/a': page('A', 'Page a content.'),
      '/c': page('C', 'Page c content.'),
    })
    const delivered: string[][] = []
    let batchCount = 0
    await expect(
      crawlSite({
        startUrl: `${SITE}/`, maxPages: 3, firstBatch: 2, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
        onBatch: async (pages) => {
          batchCount++
          if (batchCount === 2) throw new Error('persistence boom')
          delivered.push(pages.map((p) => p.url))
        },
      }),
    ).rejects.toMatchObject({ name: 'CrawlError', code: 'crawl_failed' })
    // The first batch (b, a) was delivered exactly once, before the second batch's failure aborted
    // the crawl — it is not retried, re-delivered, or rolled back.
    expect(delivered).toEqual([[`${SITE}/b`, `${SITE}/a`]])
  })

  it('18. the start URL is queued before sitemap seeds, so a full frontier cap never silently drops the homepage (review finding 5)', async () => {
    const bogusUrls = Array.from({ length: 15 }, (_, i) => `${SITE}/bogus${i}`)
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemap.xml` },
      // None of these paths have a real page defined — every one 404s. With maxPages: 1 the
      // frontier's maxSeen cap is 10, so at most 9 of these 15 can be admitted once the start URL
      // claims its own slot first — and since none of them are real pages, the crawl must fall
      // through all of them before it ever reaches (and ingests) the start URL itself.
      '/sitemap.xml': { body: sitemapXml(bogusUrls) },
      '/': page('Home', 'The homepage.'),
    })
    const ingestedUrls: string[] = []
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: 1, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (pages) => { ingestedUrls.push(...pages.map((p) => p.url)) },
    })
    expect(summary.ingested).toBe(1)
    expect(ingestedUrls).toEqual([`${SITE}/`])
  })

  it('19. an abort mid-discovery (right after the robots.txt fetch) stops before any sitemap or page fetch (review finding 6)', async () => {
    const controller = new AbortController()
    const site = fakeSite({
      '/robots.txt': { body: `Sitemap: ${SITE}/sitemap.xml` },
      '/sitemap.xml': { body: sitemapXml([`${SITE}/a`]) },
      '/': page('Home', 'Welcome.'),
      '/a': page('A', 'Page a.'),
    })
    const abortingFetch: CrawlFetch = async (url, init) => {
      const result = await site.fetch(url, init)
      if (url.endsWith('/robots.txt')) controller.abort()
      return result
    }
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: abortingFetch, resolver: site.resolver, signal: controller.signal, onBatch: async () => {},
    })
    expect(summary).toEqual({ fetched: 0, ingested: 0, skipped: 0, refused: [] })
    expect(site.hits).toEqual([`${SITE}/robots.txt`])
  })

  it('20. a redirect with a missing or unparsable Location is refused invalid_location, not too_many_redirects (review finding 8)', async () => {
    const site = fakeSite({
      '/': { body: '<h1>Home</h1><p>Welcome.</p><a href="/no-location">NoLoc</a><a href="/bad-location">BadLoc</a>' },
      '/no-location': { status: 302, headers: {} },
      '/bad-location': { status: 302, headers: { location: 'javascript:void(0)' } },
    })
    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(summary.refused).toContainEqual({ url: `${SITE}/no-location`, reason: 'invalid_location' })
    expect(summary.refused).toContainEqual({ url: `${SITE}/bad-location`, reason: 'invalid_location' })
    expect(summary.refused.some((r) => r.reason === 'too_many_redirects')).toBe(false)
  })

  it('21. robots.txt is re-checked on every redirect hop: a same-site redirect into a disallowed path is skipped, not fetched (review finding 9)', async () => {
    const site = fakeSite({
      '/robots.txt': { body: 'User-agent: *\nDisallow: /private' },
      '/': { body: '<h1>Home</h1><p>Welcome.</p><a href="/redirect-in">RedirectIn</a>' },
      '/redirect-in': { status: 302, headers: { location: `${SITE}/private` } },
      '/private': page('Private', 'Secret.'),
    })
    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(site.hits).toContain(`${SITE}/redirect-in`)
    expect(site.hits).not.toContain(`${SITE}/private`)
    expect(summary.skipped).toBeGreaterThanOrEqual(1)
  })

  it('22. subsequent batches after the first are always the fixed 20, regardless of firstBatch: 45 pages flush as 20, 20, 5 (review finding 12)', async () => {
    const n = 45
    const urls = Array.from({ length: n }, (_, i) => `${SITE}/p${i}`)
    const pages: Record<string, FakePage> = { '/sitemap.xml': { body: sitemapXml(urls) }, '/': { body: '<nav></nav>' } }
    for (let i = 0; i < n; i++) pages[`/p${i}`] = page(`P${i}`, `Content ${i}.`)
    const site = fakeSite(pages)
    const batchSizes: number[] = []
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: n, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (batchPages) => { batchSizes.push(batchPages.length) },
    })
    expect(summary.ingested).toBe(n)
    expect(batchSizes).toEqual([20, 20, 5])
  })

  it('23. an https:// link on a nonstandard port is refused invalid_url and never fetched (review finding 3)', async () => {
    const site = fakeSite({
      '/': { body: `<h1>Home</h1><p>Welcome.</p><a href="https://acme.example:8080/x">Odd port</a>` },
    })
    const summary = await crawlSite({ startUrl: `${SITE}/`, maxPages: 5, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(), onBatch: async () => {} })
    expect(site.hits).not.toContain('https://acme.example:8080/x')
    expect(summary.refused).toContainEqual({ url: 'https://acme.example:8080/x', reason: 'invalid_url' })
  })

  it('24. a slow onBatch under concurrent workers neither loses nor duplicates pages (review finding 4 regression, test 1: deterministic, no wall-clock)', async () => {
    // The start URL is ingested ALONE in wave 1 (its links aren't discovered until it's parsed),
    // leaving `buffer` at length 1 before wave 2's two concurrent workers each push their own page —
    // the first push alone crosses the firstBatch: 2 threshold and triggers a flush; the SECOND
    // worker's push, landing while that flush is still awaiting the gated onBatch below, is exactly
    // what the old aliased-buffer bug mishandled (as either a lost page or a re-delivered batch).
    const extra = [0, 1, 2, 3, 4]
    const site = fakeSite({
      '/': { body: `<h1>Home</h1><p>Welcome.</p>${extra.map((i) => `<a href="/p${i}">p${i}</a>`).join('')}` },
      ...Object.fromEntries(extra.map((i) => [`/p${i}`, page(`P${i}`, `Content ${i}.`)])),
    })

    let releaseFirstBatch: () => void = () => {}
    const firstBatchGate = new Promise<void>((resolve) => { releaseFirstBatch = resolve })
    let firstBatchStarted: () => void = () => {}
    const firstBatchStartedSignal = new Promise<void>((resolve) => { firstBatchStarted = resolve })

    const delivered: string[][] = []
    let batchIndex = 0
    const crawlPromise = crawlSite({
      startUrl: `${SITE}/`, maxPages: 6, firstBatch: 2, concurrency: 2, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (pages) => {
        const isFirst = batchIndex === 0
        batchIndex++
        if (isFirst) {
          firstBatchStarted()
          await firstBatchGate // hold the first flush open — a concurrent worker's push must land safely
        }
        delivered.push(pages.map((p) => p.url))
      },
    })

    await firstBatchStartedSignal // deterministic: resolves exactly when the first flush begins, no timers
    releaseFirstBatch()
    const summary = await crawlPromise

    const deliveredUrls = delivered.flat()
    expect(new Set(deliveredUrls).size).toBe(deliveredUrls.length) // no page delivered twice
    expect(summary.ingested).toBe(deliveredUrls.length) // no page lost
    expect(new Set(deliveredUrls)).toEqual(new Set([`${SITE}/`, `${SITE}/p0`, `${SITE}/p1`, `${SITE}/p2`, `${SITE}/p3`, `${SITE}/p4`]))
    // The precise regression: the buggy aliased buffer let wave 2's second worker's push land
    // INSIDE the array already handed to the gated onBatch call, silently growing the "first" batch
    // from 2 pages to 3 instead of leaving the extra page for a later batch. Confirmed by reverting
    // to the pre-fix `flush()` and observing exactly this — `delivered[0]` came back as
    // `[start, p0, p1]` (3 pages) instead of the 2 the threshold actually called for.
    expect(delivered[0]).toHaveLength(2)
  })

  it('25. a slow onBatch under sustained load neither loses nor duplicates pages, and never delivers an oversized batch (review finding 4 regression, test 2: 44 pages)', async () => {
    // A deliberate one-page offset (review finding 4 investigation): with an EVEN page count and
    // concurrency: 2, `firstBatch`/the fixed batch size (both 20, also even) always lands the
    // threshold-crossing push on the SECOND member of its wave — by then both of that wave's
    // workers have already pushed, so there's no third worker left to race in during the stuck
    // flush, and the bug can't actually manifest (confirmed empirically: without this offset, the
    // buggy code produces the fully correct [20, 20, 4] here too). `/dup1` + `/dup2` (identical
    // content, so `/dup2` is skipped as a duplicate) shift the ingested-push count by exactly one
    // relative to the fetch-wave count, so the 20th push instead lands on the FIRST member of a
    // wave, leaving its wave-mate to push (and race) while that flush is in flight. Reverting to
    // the pre-fix `flush()` against this exact fixture reproduces the review's own symptom almost
    // exactly: batches `[21, 21, 20, 3]`, 65 pages delivered for only 44 unique ones (21 duplicates).
    const n = 44
    const uniqueUrls = Array.from({ length: 43 }, (_, i) => `${SITE}/p${i}`)
    const urls = [`${SITE}/dup1`, `${SITE}/dup2`, ...uniqueUrls]
    const pages: Record<string, FakePage> = {
      '/sitemap.xml': { body: sitemapXml(urls) },
      '/': { body: '<nav></nav>' },
      '/dup1': page('Dup', 'Identical duplicate content.'),
      '/dup2': page('Dup', 'Identical duplicate content.'),
    }
    for (let i = 0; i < 43; i++) pages[`/p${i}`] = page(`P${i}`, `Content ${i}.`)
    const site = fakeSite(pages)
    const delivered: string[][] = []
    const summary = await crawlSite({
      startUrl: `${SITE}/`, maxPages: n, firstBatch: 20, concurrency: 2, delayMs: 0, fetch: site.fetch, resolver: site.resolver, signal: signal(),
      onBatch: async (batchPages) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        delivered.push(batchPages.map((p) => p.url))
      },
    })
    const deliveredUrls = delivered.flat()
    expect(new Set(deliveredUrls).size).toBe(deliveredUrls.length) // no page delivered twice
    expect(deliveredUrls).toHaveLength(n) // no page lost
    expect(summary.ingested).toBe(n)
    expect(summary.skipped).toBe(1) // /dup2, the content duplicate
    for (const batch of delivered.slice(1)) expect(batch.length).toBeLessThanOrEqual(20)
  })
})

describe('normalizeUrl (review finding 3: https only)', () => {
  it('rejects http: outright — a plain http link is silently dropped at discovery, same as mailto:/javascript:', () => {
    expect(normalizeUrl('http://acme.example/x')).toBeNull()
    expect(normalizeUrl('http://acme.example/x', `${SITE}/`)).toBeNull()
  })
  it('still accepts https:', () => {
    expect(normalizeUrl('https://acme.example/x')).toBe('https://acme.example/x')
  })
})

describe('validateHop (review finding 3: invalid_url via validateOutboundUrl, checked before resolvePublic)', () => {
  const siteUrl = new URL(`${SITE}/`)
  it('refuses http: as invalid_url (unreachable through the normal discovery path — normalizeUrl already drops it first — but validateHop independently enforces the same https-only rule)', async () => {
    const result = await validateHop('http://acme.example/x', siteUrl, undefined)
    expect(result).toEqual({ ok: false, reason: 'invalid_url' })
  })
  it('refuses a nonstandard port as invalid_url', async () => {
    const result = await validateHop('https://acme.example:8080/x', siteUrl, undefined)
    expect(result).toEqual({ ok: false, reason: 'invalid_url' })
  })
  it('still accepts a plain https same-site URL', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }]
    const result = await validateHop('https://acme.example/x', siteUrl, resolver)
    expect(result.ok).toBe(true)
  })
})

describe('collectSitemapSeeds (review findings 2, 6, 12 — tested directly: a full crawl through thousands of dummy seeded pages would be far too slow)', () => {
  const siteUrl = new URL(`${SITE}/`)
  const rawPageFetch = (site: ReturnType<typeof fakeSite>) => (url: URL) => site.fetch(url.toString(), { timeoutMs: 10_000, maxBodyBytes: 2 * 1024 * 1024, headers: {} })
  const neverAborted = new AbortController().signal

  it('caps the TOTAL seeded URLs at 5,000 across files, not 5,000 per file: two files of 3,000 seed exactly 5,000', async () => {
    const urlsA = Array.from({ length: 3000 }, (_, i) => `${SITE}/a${i}`)
    const urlsB = Array.from({ length: 3000 }, (_, i) => `${SITE}/b${i}`)
    const site = fakeSite({ '/sitemapA.xml': { body: sitemapXml(urlsA) }, '/sitemapB.xml': { body: sitemapXml(urlsB) } })
    const seeds = await collectSitemapSeeds([`${SITE}/sitemapA.xml`, `${SITE}/sitemapB.xml`], siteUrl, rawPageFetch(site), site.resolver, neverAborted)
    expect(seeds).toHaveLength(5000)
  })

  it('a sitemap file at a private address is silently skipped, contributing no seeds', async () => {
    const site = fakeSite({ '/sitemap.xml': { body: sitemapXml([`${SITE}/x`]) } })
    const seeds = await collectSitemapSeeds(['https://sitemap-host.internal/sitemap.xml'], siteUrl, rawPageFetch(site), site.resolver, neverAborted)
    expect(seeds).toEqual([])
    expect(site.hits).toEqual([])
  })

  it('stops fetching more sitemap files once the signal is already aborted', async () => {
    const site = fakeSite({ '/sitemapA.xml': { body: sitemapXml([`${SITE}/a`]) }, '/sitemapB.xml': { body: sitemapXml([`${SITE}/b`]) } })
    const controller = new AbortController()
    controller.abort()
    const seeds = await collectSitemapSeeds([`${SITE}/sitemapA.xml`, `${SITE}/sitemapB.xml`], siteUrl, rawPageFetch(site), site.resolver, controller.signal)
    expect(seeds).toEqual([])
    expect(site.hits).toEqual([])
  })
})
