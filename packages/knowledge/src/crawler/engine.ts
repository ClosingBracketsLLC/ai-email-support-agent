import { createHash } from 'node:crypto'
import type { KnowledgeFailureReason } from '@aesa/contracts'
import { PinnedFetchError, pinnedFetch, resolvePublic, validateOutboundUrl, type Resolver } from '@aesa/crypto'
import type { Block } from '../parsers/blocks.ts'
import { parseHtml } from '../parsers/html.ts'
import { Frontier } from './frontier.ts'
import { parseRobots } from './robots.ts'
import { parseSitemap } from './sitemap.ts'
import { normalizeUrl, sameSite } from './url.ts'

/** Never change these without the controller's say-so — they're the crawler's safety bounds. */
const MAX_REDIRECTS = 3
const MAX_BODY_BYTES = 2 * 1024 * 1024 // 2 MiB
const TIMEOUT_MS = 10_000 // 10 s
const DEFAULT_CONCURRENCY = 2
const DEFAULT_DELAY_MS = 250
const DEFAULT_FIRST_BATCH = 20
const SUBSEQUENT_BATCH_SIZE = 20
const FRONTIER_CAP_MULTIPLIER = 10

/** A safety bound on the sitemap-index recursion (rule 3's "else /sitemap.xml" fallback can chain
 * through nested `<sitemapindex>` children) — not itself a rule the engine is scored against, just
 * a guard against a pathological or hostile sitemap graph. */
const MAX_SITEMAP_FETCHES = 20

/** The exact User-Agent every request carries (rule 12) — also usable by robots.txt reporting/runbooks. */
export const CRAWL_USER_AGENT = 'aesa-crawler/1.0 (+https://aesa.app)'
const FETCH_HEADERS: Record<string, string> = { 'user-agent': CRAWL_USER_AGENT, accept: 'text/html' }
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class CrawlError extends Error {
  code: KnowledgeFailureReason

  constructor(code: KnowledgeFailureReason, message?: string) {
    super(message ?? code)
    this.name = 'CrawlError'
    this.code = code
  }
}

export type CrawlFetch = (
  url: string,
  init: { timeoutMs: number; maxBodyBytes: number; headers: Record<string, string> },
) => Promise<{ status: number; headers: Record<string, string>; body: string }>

export interface CrawledPage {
  url: string
  title: string | null
  blocks: Block[]
  contentHash: string
}

export interface CrawlProgress {
  fetched: number
  ingested: number
  skipped: number
  frontier: number
}

export interface CrawlSummary {
  fetched: number
  ingested: number
  skipped: number
  refused: { url: string; reason: string }[]
}

export interface CrawlOptions {
  startUrl: string
  maxPages: number
  fetch: CrawlFetch
  resolver?: Resolver
  /** How many ingested pages the FIRST `onBatch` call carries (default 20, "first 20 pages
   * fast"). Every flush after the first always carries up to 20, regardless of this value. */
  firstBatch?: number
  onBatch(pages: CrawledPage[]): Promise<void>
  onProgress?(p: CrawlProgress): Promise<void>
  signal: AbortSignal
  delayMs?: number
  concurrency?: number
}

/** Pure translation of a `PinnedFetchError` into the `CrawlFetch` result shape, factored out of
 * `createPinnedCrawlFetch` (below) so both of `PinnedFetchError`'s codes can be exercised by
 * constructing the error directly — no real network call, and no need to mock `@aesa/crypto`.
 * Returns `null` for anything else (including a non-`PinnedFetchError` failure), which the caller
 * re-throws.
 *
 * `redirect_not_followed` can no longer actually be thrown by the call this function guards
 * (`createPinnedCrawlFetch` below passes `redirect: 'manual'`, so `pinnedFetch` RETURNS a 3xx
 * response instead of throwing for it) — this branch stays as a defensive fallback matching
 * `PinnedFetchError`'s full contract, and its status-from-message recovery is still exercised
 * directly in `test/pinned-crawl-fetch.test.ts`. `body_too_large` remains live: a body over the
 * cap throws regardless of redirect mode. */
export function translatePinnedFetchError(err: unknown): { status: number; headers: Record<string, string>; body: string } | null {
  if (!(err instanceof PinnedFetchError)) return null
  if (err.code === 'body_too_large') return { status: 0, headers: {}, body: '' }
  const match = /\((\d{3})\)/.exec(err.message)
  return { status: match ? Number(match[1]) : 302, headers: {}, body: '' }
}

/** Production `CrawlFetch`: pins every request to a pre-resolved public address (`pinnedFetch`),
 * requesting `redirect: 'manual'` so a 3xx comes back as an ordinary `{ status, headers, body }`
 * result (its `location` header included) instead of throwing — the engine's own hop validation
 * (`fetchResolved`: normalize → same-site → `resolvePublic` → fetch) is what actually follows it,
 * exactly as it already does against the fake `CrawlFetch` in tests. `translatePinnedFetchError`
 * still catches an oversized body (`body_too_large`, still thrown regardless of redirect mode) so
 * that ends the ONE fetch attempt, not the whole crawl. */
export function createPinnedCrawlFetch(): CrawlFetch {
  return async (url, init) => {
    try {
      const res = await pinnedFetch(url, { timeoutMs: init.timeoutMs, maxBodyBytes: init.maxBodyBytes, headers: init.headers, redirect: 'manual' })
      const body = await res.text()
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => { headers[key] = value })
      return { status: res.status, headers, body }
    } catch (err) {
      const translated = translatePinnedFetchError(err)
      if (translated) return translated
      throw err
    }
  }
}

type HopRefusal = 'off_site' | 'private_address'

/** The resolved-address check runs BEFORE the same-site check on purpose: a link to a private or
 * blocked address is always reported as `private_address`, even when its hostname also happens to
 * differ from the site (the common case — `api.internal`, an SSRF bait host, is never "this
 * site"). `off_site` is reserved for a hostname that resolves PUBLICLY but still isn't the site
 * being crawled. */
async function validateHop(rawUrl: string, siteUrl: URL, resolver: Resolver | undefined): Promise<{ ok: true; url: URL } | { ok: false; reason: HopRefusal }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'off_site' }
  }
  try {
    await resolvePublic(url.hostname, { resolver })
  } catch {
    return { ok: false, reason: 'private_address' }
  }
  if (!sameSite(url, siteUrl)) return { ok: false, reason: 'off_site' }
  return { ok: true, url }
}

type FetchOutcome =
  | { kind: 'ok'; url: string; status: number; headers: Record<string, string>; body: string }
  | { kind: 'refused'; url: string; reason: HopRefusal | 'too_many_redirects' }

/** Fetches `initialUrl`, following at most `MAX_REDIRECTS` redirects (rule 4): each hop's target
 * is normalized, same-site-checked and re-resolved through `resolvePublic` BEFORE it is fetched —
 * `pageFetch` never sees a redirect target the caller hasn't re-validated. */
async function fetchResolved(
  pageFetch: (url: URL) => Promise<{ status: number; headers: Record<string, string>; body: string }>,
  initialUrl: string,
  siteUrl: URL,
  resolver: Resolver | undefined,
): Promise<FetchOutcome> {
  let currentUrl = initialUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const gate = await validateHop(currentUrl, siteUrl, resolver)
    if (!gate.ok) return { kind: 'refused', url: currentUrl, reason: gate.reason }

    const res = await pageFetch(gate.url)
    if (!REDIRECT_STATUSES.has(res.status)) {
      return { kind: 'ok', url: gate.url.toString(), status: res.status, headers: res.headers, body: res.body }
    }
    if (hop === MAX_REDIRECTS) return { kind: 'refused', url: currentUrl, reason: 'too_many_redirects' }

    const location = res.headers['location'] ?? res.headers['Location']
    const normalized = location ? normalizeUrl(location, gate.url.toString()) : null
    if (!normalized) return { kind: 'refused', url: currentUrl, reason: 'too_many_redirects' }
    currentUrl = normalized
  }
  /* c8 ignore next */
  return { kind: 'refused', url: currentUrl, reason: 'too_many_redirects' }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Crawls a site starting from `startUrl`: robots.txt first, then sitemap-seeded URLs (same-site
 * only), then the start URL's own discovered links, breadth-first, up to `maxPages` ingested pages
 * — see the module-level rule list in the task report for the full contract. */
export async function crawlSite(opts: CrawlOptions): Promise<CrawlSummary> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS
  const firstBatch = opts.firstBatch ?? DEFAULT_FIRST_BATCH
  const resolver = opts.resolver

  // Rule 11: an already-aborted signal returns immediately, before any network activity at all —
  // not even the start URL's own validation.
  if (opts.signal.aborted) return { fetched: 0, ingested: 0, skipped: 0, refused: [] }

  // Rule 1: the start URL must be a validated, publicly-resolvable https host or the crawl fails outright.
  let siteUrl: URL
  try {
    siteUrl = validateOutboundUrl(opts.startUrl)
    await resolvePublic(siteUrl.hostname, { resolver })
  } catch (err) {
    throw new CrawlError('crawl_failed', err instanceof Error ? err.message : String(err))
  }

  const lastRequestAtByHost = new Map<string, number>()
  /** Rule 10 (politeness half): serializes requests to the SAME host by `delayMs`; requests to
   * different hosts are never held up by this. Rule 10's concurrency half lives in the wave loop
   * below, which never has more than `concurrency` of these in flight at once. */
  const pageFetch = async (url: URL): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const host = url.hostname
    const last = lastRequestAtByHost.get(host)
    if (last !== undefined) {
      const wait = delayMs - (Date.now() - last)
      if (wait > 0) await sleep(wait)
    }
    lastRequestAtByHost.set(host, Date.now())
    return opts.fetch(url.toString(), { timeoutMs: TIMEOUT_MS, maxBodyBytes: MAX_BODY_BYTES, headers: FETCH_HEADERS })
  }

  const frontier = new Frontier({ maxSeen: opts.maxPages * FRONTIER_CAP_MULTIPLIER })
  let fetchedCount = 0
  let ingestedCount = 0
  let skippedCount = 0
  const refused: { url: string; reason: string }[] = []
  const seenHashes = new Set<string>()
  let buffer: CrawledPage[] = []
  let firstBatchDone = false

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const pages = buffer
    buffer = []
    await opts.onBatch(pages)
  }
  // Rule 8: the first `firstBatch` (20) ingested pages flush immediately; every flush after that
  // carries up to the fixed 20, not `firstBatch` again. Whatever's left flushes once at the end
  // (the final `await flush()` after the loop below).
  const maybeFlush = async (): Promise<void> => {
    const threshold = firstBatchDone ? SUBSEQUENT_BATCH_SIZE : firstBatch
    if (buffer.length >= threshold) {
      firstBatchDone = true
      await flush()
    }
  }
  const reportProgress = async (): Promise<void> => {
    if (opts.onProgress) {
      await opts.onProgress({ fetched: fetchedCount, ingested: ingestedCount, skipped: skippedCount, frontier: frontier.size })
    }
  }

  // Rule 2: GET /robots.txt first; a 4xx/5xx, a non-text response, or a transport failure all mean
  // "no rules" — every URL is allowed and there are no robots-declared sitemaps.
  let robots: { isAllowed(url: string): boolean; sitemaps: string[] } = { isAllowed: () => true, sitemaps: [] }
  try {
    const robotsUrl = new URL('/robots.txt', siteUrl)
    const res = await pageFetch(robotsUrl)
    const contentType = (res.headers['content-type'] ?? res.headers['Content-Type'] ?? '').toLowerCase()
    if (res.status >= 200 && res.status < 300 && (contentType === '' || contentType.startsWith('text/'))) {
      robots = parseRobots(res.body, robotsUrl.toString())
    }
  } catch {
    // Transport failure: fall back to the permissive default above.
  }

  // Rule 3: sitemap-first. Robots' own `Sitemap:` lines win; otherwise fall back to `/sitemap.xml`
  // at the site root. A `<sitemapindex>` child sitemap is followed too, breadth-first, bounded by
  // MAX_SITEMAP_FETCHES. Every discovered page URL is normalized and queued as a 'sitemap' seed —
  // same-site filtering happens later, at the single per-URL gate every frontier entry passes
  // through (`validateHop`, inside `fetchResolved`), not here.
  const sitemapUrlsToFetch = robots.sitemaps.length > 0 ? [...robots.sitemaps] : [new URL('/sitemap.xml', siteUrl).toString()]
  const fetchedSitemaps = new Set<string>()
  const sitemapSeeds: string[] = []
  while (sitemapUrlsToFetch.length > 0 && fetchedSitemaps.size < MAX_SITEMAP_FETCHES) {
    const nextSitemapUrl = sitemapUrlsToFetch.shift()!
    const normalizedSitemapUrl = normalizeUrl(nextSitemapUrl, siteUrl.toString())
    if (!normalizedSitemapUrl || fetchedSitemaps.has(normalizedSitemapUrl)) continue
    fetchedSitemaps.add(normalizedSitemapUrl)
    try {
      const gate = await validateHop(normalizedSitemapUrl, siteUrl, resolver)
      if (!gate.ok) continue
      const res = await pageFetch(gate.url)
      if (res.status < 200 || res.status >= 300) continue
      const parsed = parseSitemap(res.body)
      for (const u of parsed.urls) {
        const n = normalizeUrl(u, gate.url.toString())
        if (n) sitemapSeeds.push(n)
      }
      sitemapUrlsToFetch.push(...parsed.sitemaps)
    } catch {
      // One bad sitemap fetch doesn't fail the crawl — just contributes no urls.
    }
  }
  frontier.add(sitemapSeeds, 'sitemap')

  // The start URL is queued exactly like any other discovered link — placed in the LINK queue, so
  // every sitemap-seeded URL is dequeued before it (rule 3's "before the start URL's links").
  const normalizedStart = normalizeUrl(opts.startUrl)
  if (normalizedStart) frontier.add([normalizedStart], 'link')

  const addDiscoveredLinks = (hrefs: string[], baseUrl: string): void => {
    const normalized: string[] = []
    for (const href of hrefs) {
      const n = normalizeUrl(href, baseUrl)
      if (n) normalized.push(n)
    }
    frontier.add(normalized, 'link')
  }

  const processUrl = async (url: string): Promise<void> => {
    try {
      // Rule 2 (disallow half): never fetched, just counted.
      if (!robots.isAllowed(url)) {
        skippedCount++
        return
      }

      const result = await fetchResolved(pageFetch, url, siteUrl, resolver)
      if (result.kind === 'refused') {
        refused.push({ url: result.url, reason: result.reason })
        return
      }
      fetchedCount++

      const { url: finalUrl, status, headers: resHeaders, body } = result
      const contentType = (resHeaders['content-type'] ?? resHeaders['Content-Type'] ?? '').toLowerCase()
      // Rule 5: only a 2xx text/html* body within the size bound is parsed.
      if (status < 200 || status >= 300) { skippedCount++; return }
      if (!contentType.startsWith('text/html')) { skippedCount++; return }
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) { skippedCount++; return }

      const parsed = parseHtml(body)

      // Rule 6 (noindex half): skipped, but its links are still worth discovering.
      if (parsed.noindex) {
        skippedCount++
        addDiscoveredLinks(parsed.links, finalUrl)
        return
      }

      // Rule 6 (canonical half): a canonical pointing elsewhere queues THAT url and skips this one.
      const normalizedSelf = normalizeUrl(finalUrl)
      const normalizedCanonical = parsed.canonical ? normalizeUrl(parsed.canonical, finalUrl) : null
      if (normalizedCanonical && normalizedSelf && normalizedCanonical !== normalizedSelf) {
        frontier.add([normalizedCanonical], 'link')
        skippedCount++
        addDiscoveredLinks(parsed.links, finalUrl)
        return
      }

      addDiscoveredLinks(parsed.links, finalUrl)

      // A page with no extractable text (e.g. a nav-only shell) has nothing worth ingesting —
      // its links were already queued above, so the crawl still flows through it.
      if (parsed.blocks.length === 0) { skippedCount++; return }

      // Rule 7: a page whose content was already ingested this crawl (same blocks, any URL) is a duplicate.
      const contentHash = createHash('sha256').update(parsed.blocks.map((b) => b.text).join('\n')).digest('hex')
      if (seenHashes.has(contentHash)) { skippedCount++; return }
      seenHashes.add(contentHash)

      ingestedCount++
      buffer.push({ url: finalUrl, title: parsed.title, blocks: parsed.blocks, contentHash })
      await maybeFlush()
    } catch {
      // A single page's failure (a malformed response, a transport error not shaped as
      // PinnedFetchError, ...) must not take the whole crawl down with it.
      skippedCount++
    } finally {
      await reportProgress()
    }
  }

  // Rule 10 (concurrency half) + rule 9 (maxPages counts INGESTED pages): each wave pulls at most
  // `concurrency` URLs, capped further by how many more pages could possibly be ingested, so a
  // wave can never push `ingestedCount` past `maxPages` even when every member of the wave lands.
  while (!opts.signal.aborted && ingestedCount < opts.maxPages) {
    const remaining = opts.maxPages - ingestedCount
    const waveSize = Math.min(concurrency, remaining)
    const batch: string[] = []
    for (let i = 0; i < waveSize; i++) {
      const next = frontier.next()
      if (next === null) break
      batch.push(next)
    }
    if (batch.length === 0) break
    await Promise.all(batch.map((url) => processUrl(url)))
  }

  await flush()

  return { fetched: fetchedCount, ingested: ingestedCount, skipped: skippedCount, refused }
}
