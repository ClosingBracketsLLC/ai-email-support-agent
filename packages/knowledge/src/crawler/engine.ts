import type { KnowledgeFailureReason } from '@aesa/contracts'
import { PinnedFetchError, pinnedFetch, resolvePublic, validateOutboundUrl, type Resolver } from '@aesa/crypto'
import { contentHashOf } from '../ingest.ts'
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

/** The sitemap discovery bounds (review finding 2, replacing an earlier ad hoc 20-files-no-total
 * cap): at most 5 sitemap FILES are fetched — index and leaf combined, breadth-first through any
 * nested `<sitemapindex>` — and at most 5,000 page URLs are seeded IN TOTAL across every file
 * fetched, not 5,000 per file (`parseSitemap`'s own per-file cap in `sitemap.ts` stays underneath
 * this as a defensive floor). */
const MAX_SITEMAP_FETCHES = 5
const MAX_SITEMAP_SEED_URLS = 5_000

/** The exact User-Agent every request carries (rule 12) — also usable by robots.txt reporting/runbooks. */
export const CRAWL_USER_AGENT = 'aesa-crawler/1.0 (+https://aesa.app)'
const FETCH_HEADERS: Record<string, string> = { 'user-agent': CRAWL_USER_AGENT, accept: 'text/html' }
/** robots.txt is `text/plain`, not html: asking for `text/html` invites a content-negotiating
 * server to hand back an HTML error page (which the caller then refuses for its content-type, so
 * the site crawls with NO rules at all). */
const ROBOTS_FETCH_HEADERS: Record<string, string> = { 'user-agent': CRAWL_USER_AGENT, accept: 'text/plain, */*' }
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class CrawlError extends Error {
  code: KnowledgeFailureReason
  /**
   * WHOSE failure this was. `engine` is the crawl itself (a refused start URL, a site that gave
   * nothing) and is terminal for the source — re-walking it would fail identically. `consumer` is
   * the caller's own `onBatch` throwing: the site was fine and the pages are real, so the caller
   * should retry rather than tell the owner their site failed. The two used to be indistinguishable,
   * which turned one dropped database connection into a permanently failed knowledge source.
   */
  readonly origin: 'engine' | 'consumer'

  constructor(code: KnowledgeFailureReason, message?: string, opts?: { origin?: 'engine' | 'consumer'; cause?: unknown }) {
    super(message ?? code, opts?.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'CrawlError'
    this.code = code
    this.origin = opts?.origin ?? 'engine'
  }
}

/** Marks an `onBatch` failure as it unwinds out of `processUrl` — distinguishes "the caller's own
 * persistence failed, abort the whole crawl" from "this one page failed, skip it and move on"
 * (review finding 4): both used to surface as a thrown error inside the very same `try`, so the
 * first kind was being silently swallowed as if it were the second. */
class BatchFlushError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('onBatch failed')
    this.name = 'BatchFlushError'
    this.cause = cause
  }
}

export type CrawlFetch = (
  url: string,
  init: { timeoutMs: number; maxBodyBytes: number; headers: Record<string, string>; signal?: AbortSignal },
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

/** Every reason a hop, a sitemap URL, or a redirect target can be refused — shared by
 * `CrawlSummary` and the internal gates (`validateHop`, `fetchResolved`) so the two can never
 * silently drift into different vocabularies (review finding 8). */
export type RefusalReason = 'private_address' | 'off_site' | 'too_many_redirects' | 'invalid_url' | 'invalid_location'

export interface CrawlSummary {
  fetched: number
  ingested: number
  skipped: number
  refused: { url: string; reason: RefusalReason }[]
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
 * that ends the ONE fetch attempt, not the whole crawl.
 *
 * `init.signal` (review finding 6) is NOT forwarded to `pinnedFetch` here: `@aesa/crypto`'s
 * `pinnedFetch`/`PinnedFetchInit` has no `signal` option — it builds its own internal
 * `AbortSignal.timeout(...)` and has no way to accept an external one layered on top. Cancellation
 * through this adapter is therefore between-fetch only, via `crawlSite`'s own signal checks; an
 * in-flight `pinnedFetch` call always runs to completion (or hits its own `timeoutMs`). */
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

type HopRefusal = 'off_site' | 'private_address' | 'invalid_url'

/** Runs `validateOutboundUrl` (https only, port 443, no userinfo, no IP-literal host — review
 * finding 3) BEFORE the resolved-address check, which itself runs BEFORE the same-site check: a
 * malformed/non-https/nonstandard-port hop is `invalid_url` regardless of where it points; a link
 * to a private or blocked address is `private_address` even when its hostname also happens to
 * differ from the site (the common case — `api.internal`, an SSRF bait host, is never "this
 * site"); `off_site` is reserved for a hostname that passes both those checks but still isn't the
 * site being crawled. Exported for direct testing of the `invalid_url` arm, which — since
 * `normalizeUrl` now also rejects a non-https scheme before a URL would ever reach this function
 * through the crawl's normal discovery path — is otherwise only reachable end-to-end via the
 * nonstandard-port case (`normalizeUrl` does not check ports at all). */
export async function validateHop(rawUrl: string, siteUrl: URL, resolver: Resolver | undefined): Promise<{ ok: true; url: URL } | { ok: false; reason: HopRefusal }> {
  let url: URL
  try {
    url = validateOutboundUrl(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  try {
    await resolvePublic(url.hostname, { resolver })
  } catch {
    return { ok: false, reason: 'private_address' }
  }
  if (!sameSite(url, siteUrl)) return { ok: false, reason: 'off_site' }
  return { ok: true, url }
}

/** The SYNTACTIC half of `validateHop`'s same-site check, for a URL `normalizeUrl` already
 * accepted (so `new URL` cannot throw; the catch is belt and braces). Used at DISCOVERY — where a
 * page or a sitemap, not the crawl, chose the hostname — so an off-site link costs neither a
 * frontier slot nor a DNS lookup (final review A4). `validateHop` keeps its DNS-classifying order
 * for the hops it still gates: the start URL and every redirect target. */
function isSameSiteUrl(normalized: string, siteUrl: URL): boolean {
  try {
    return sameSite(new URL(normalized), siteUrl)
  } catch {
    /* c8 ignore next */
    return false
  }
}

type FetchOutcome =
  | { kind: 'ok'; url: string; status: number; headers: Record<string, string>; body: string }
  | { kind: 'refused'; url: string; reason: RefusalReason }
  | { kind: 'disallowed'; url: string }

/** Fetches `initialUrl`, following at most `MAX_REDIRECTS` redirects (rule 4): each hop's target
 * is normalized, same-site-checked and re-resolved through `resolvePublic` BEFORE it is fetched —
 * `pageFetch` never sees a redirect target the caller hasn't re-validated. `isAllowed` (robots) is
 * re-checked on EVERY hop, not just the first (review finding 9) — a same-site redirect into a
 * disallowed path must never be fetched either — and checked BEFORE `validateHop` (review re-check
 * minor finding): a disallowed URL costs no DNS resolution (`validateHop`'s `resolvePublic` call). */
async function fetchResolved(
  pageFetch: (url: URL) => Promise<{ status: number; headers: Record<string, string>; body: string }>,
  initialUrl: string,
  siteUrl: URL,
  resolver: Resolver | undefined,
  isAllowed: (url: string) => boolean,
): Promise<FetchOutcome> {
  let currentUrl = initialUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowed(currentUrl)) return { kind: 'disallowed', url: currentUrl }

    const gate = await validateHop(currentUrl, siteUrl, resolver)
    if (!gate.ok) return { kind: 'refused', url: currentUrl, reason: gate.reason }

    const res = await pageFetch(gate.url)
    if (!REDIRECT_STATUSES.has(res.status)) {
      return { kind: 'ok', url: gate.url.toString(), status: res.status, headers: res.headers, body: res.body }
    }
    if (hop === MAX_REDIRECTS) return { kind: 'refused', url: currentUrl, reason: 'too_many_redirects' }

    // A missing or unparsable Location is its own reason (review finding 8) — never one more hop
    // toward the redirect-chain limit, so it must not be reported as too_many_redirects.
    const location = res.headers['location'] ?? res.headers['Location']
    if (!location) return { kind: 'refused', url: currentUrl, reason: 'invalid_location' }
    const normalized = normalizeUrl(location, gate.url.toString())
    if (!normalized) return { kind: 'refused', url: currentUrl, reason: 'invalid_location' }
    currentUrl = normalized
  }
  /* c8 ignore next */
  return { kind: 'refused', url: currentUrl, reason: 'too_many_redirects' }
}

/** Fetches robots-declared (or the `/sitemap.xml`-fallback) sitemap files, breadth-first through
 * any nested `<sitemapindex>`, bounded by `MAX_SITEMAP_FETCHES` files AND `MAX_SITEMAP_SEED_URLS`
 * page URLs in TOTAL across every file (review finding 2 — the total cap can bind well before any
 * single file's own 5,000-URL cap would). Checks `signal` before each file fetch (review finding
 * 6) and stops early — returning whatever was collected so far — once aborted. A sitemap file
 * itself refused by `validateHop` (off-site, private, or an invalid URL) contributes no seeds and
 * is silently skipped, same as a non-2xx or unparsable one; none of that is reported anywhere
 * (`collectSitemapSeeds` returns seeds and off-site seeds, never a file-level refusal) — reporting IS done for pages and redirect
 * hops dequeued from the frontier (`crawlSite`'s `refused`), which sitemap-file-level problems are
 * deliberately not conflated with. Exported so this can be tested directly: proving either cap by
 * running a full crawl through thousands of dummy seeded pages would be far too slow.
 *
 * A seeded page URL for ANOTHER site is dropped here, syntactically (final review A4), and comes
 * back in `offSite` for the caller to report: it never takes a frontier slot and never costs a DNS
 * lookup on a host the sitemap chose. The sitemap FILES themselves still go through `validateHop`
 * — there are at most five of them, so the classifying order costs nothing there. */
export async function collectSitemapSeeds(
  initialSitemapUrls: string[],
  siteUrl: URL,
  pageFetch: (url: URL) => Promise<{ status: number; headers: Record<string, string>; body: string }>,
  resolver: Resolver | undefined,
  signal: AbortSignal,
): Promise<{ seeds: string[]; offSite: string[] }> {
  const toFetch = [...initialSitemapUrls]
  const fetchedSitemaps = new Set<string>()
  const seeds: string[] = []
  const offSite: string[] = []
  while (toFetch.length > 0 && fetchedSitemaps.size < MAX_SITEMAP_FETCHES && seeds.length < MAX_SITEMAP_SEED_URLS) {
    if (signal.aborted) break
    const nextSitemapUrl = toFetch.shift()!
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
        if (seeds.length >= MAX_SITEMAP_SEED_URLS) break
        const n = normalizeUrl(u, gate.url.toString())
        if (!n) continue
        if (isSameSiteUrl(n, siteUrl)) seeds.push(n)
        else offSite.push(n)
      }
      toFetch.push(...parsed.sitemaps)
    } catch {
      // One bad sitemap fetch doesn't fail the crawl — just contributes no urls.
    }
  }
  return { seeds, offSite }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Crawls a site starting from `startUrl`: robots.txt first, then sitemap-seeded URLs (same-site
 * only), then the start URL's own discovered links, breadth-first, up to `maxPages` ingested pages
 * — see the module-level rule list in the task report for the full contract. */
export async function crawlSite(opts: CrawlOptions): Promise<CrawlSummary> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS
  // Clamped to ≥ 1: a caller-supplied 0 (or a negative) would make `currentThreshold()` 0, and
  // `maybeFlush` would then flush an EMPTY buffer on every page — `flushSome` returns early on an
  // empty buffer, so nothing would ever be delivered until the final drain.
  const firstBatch = Math.max(1, Math.floor(opts.firstBatch ?? DEFAULT_FIRST_BATCH))
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
   * different hosts are never held up by this. The slot is claimed SYNCHRONOUSLY — `last` is read,
   * the wake time computed, and the map written back all before any `await` (review finding 1):
   * the old code read `last`, awaited a sleep, and only then wrote the map, so two workers racing
   * for the same host in one concurrent wave could both read the same stale `last` and fire
   * together. Rule 10's concurrency half lives in the wave loop below, which never has more than
   * `concurrency` of these in flight at once. */
  const pageFetch = async (url: URL, headers: Record<string, string> = FETCH_HEADERS): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const host = url.hostname
    const now = Date.now()
    const last = lastRequestAtByHost.get(host)
    const wake = last !== undefined ? Math.max(now, last + delayMs) : now
    lastRequestAtByHost.set(host, wake)
    const wait = wake - now
    if (wait > 0) await sleep(wait)
    return opts.fetch(url.toString(), { timeoutMs: TIMEOUT_MS, maxBodyBytes: MAX_BODY_BYTES, headers, signal: opts.signal })
  }

  const frontier = new Frontier({ maxSeen: opts.maxPages * FRONTIER_CAP_MULTIPLIER })
  let fetchedCount = 0
  let ingestedCount = 0
  let skippedCount = 0
  const refused: { url: string; reason: RefusalReason }[] = []
  /** Off-site URLs seen at discovery, deduped and bounded by the very cap the frontier used to
   * impose on them (`maxPages × FRONTIER_CAP_MULTIPLIER` distinct URLs): they no longer pass
   * through the frontier, so the summary needs its own ceiling or one page of outbound links per
   * crawled page could grow `refused` without limit. */
  const offSiteSeen = new Set<string>()
  const recordOffSite = (url: string): void => {
    if (offSiteSeen.size >= opts.maxPages * FRONTIER_CAP_MULTIPLIER || offSiteSeen.has(url)) return
    offSiteSeen.add(url)
    refused.push({ url, reason: 'off_site' })
  }
  const seenHashes = new Set<string>()
  let buffer: CrawledPage[] = []
  let firstBatchDone = false
  // Guards against two overlapping `onBatch` calls (review finding 4's regression — see
  // `flushSome` below): while one flush is in flight, `maybeFlush` calls from OTHER concurrent
  // workers are no-ops; `buffer` just keeps growing until the in-flight flush finishes.
  let flushing = false
  // A5: latched the moment one `onBatch` call fails. Nothing after that may call `onBatch` again
  // (a sibling worker mid-wave would otherwise deliver a batch the caller has already failed on)
  // and nothing may call `onProgress` again: `crawlSite` is about to reject, and the engine's
  // contract is that nothing fires after it settles.
  let failed = false

  const currentThreshold = (): number => (firstBatchDone ? SUBSEQUENT_BATCH_SIZE : firstBatch)

  // Rule 8 + review finding 4 (and finding 4's OWN regression, fixed here): `onBatch` must fully
  // succeed before its pages are considered delivered, and a concurrent worker's `buffer.push()`
  // during the `await` must neither land inside the in-flight batch nor be discarded by it.
  //
  // The first attempt at finding 4's fix aliased the live array — `const pages = buffer` — so a
  // push during `await onBatch(pages)` mutated `pages` too (`buffer` and `pages` were the SAME
  // array), and the trailing `buffer = []` then discarded whatever had landed in it: a page
  // counted `ingested` could vanish, or — since `buffer.length` kept climbing past the threshold on
  // that SAME still-aliased array — a second `maybeFlush()` racing in from another worker would see
  // the threshold crossed again and flush (a version of) the SAME array a second time, redelivering it.
  //
  // Fixed here with a SYNCHRONOUS swap: `buffer.splice(0, cap)` takes the batch out and shortens
  // `buffer` to whatever's left in the SAME synchronous tick, with no `await` in between — a
  // concurrent push can only ever land in what's left of `buffer`, never in `pages`. `flushing`
  // stops two flushes from running at once (the second-worker-races-in scenario above): while one
  // is in flight, `buffer` just keeps growing behind it, and `cap` (always `≤ SUBSEQUENT_BATCH_SIZE`
  // after the very first flush) ensures a pile-up that happens anyway delivers as several ≤cap
  // batches afterward, never one oversized one. On failure the pages are spliced back onto the
  // FRONT of `buffer` (ahead of whatever queued up during the attempt) before re-throwing as
  // `BatchFlushError` — nothing is lost either way.
  const flushSome = async (cap: number): Promise<void> => {
    if (buffer.length === 0 || flushing || failed) return
    const pages = buffer.splice(0, cap)
    flushing = true
    try {
      await opts.onBatch(pages)
    } catch (err) {
      failed = true
      buffer = pages.concat(buffer)
      throw new BatchFlushError(err)
    } finally {
      flushing = false
    }
  }
  // Rule 8: the first `firstBatch` (20) ingested pages flush immediately; every flush after that
  // carries up to the fixed 20, not `firstBatch` again. Whatever's left flushes once at the end
  // (the final drain loop after the main loop below, which — unlike a single `flush()` call — keeps
  // going as long as `buffer` has anything left, in case a pile-up during a slow flush left more
  // than one `cap`'s worth behind).
  const maybeFlush = async (): Promise<void> => {
    const threshold = currentThreshold()
    if (buffer.length >= threshold) {
      firstBatchDone = true
      await flushSome(threshold)
    }
  }
  const reportProgress = async (): Promise<void> => {
    if (failed) return
    if (opts.onProgress) {
      await opts.onProgress({ fetched: fetchedCount, ingested: ingestedCount, skipped: skippedCount, frontier: frontier.size })
    }
  }

  // Review finding 6: checked before the robots fetch too, not just between crawl waves — an
  // abort that lands during discovery must stop discovery, not just the page-fetching loop after it.
  if (opts.signal.aborted) return { fetched: fetchedCount, ingested: ingestedCount, skipped: skippedCount, refused }

  // Rule 2: GET /robots.txt first; a 4xx/5xx, a non-text response, or a transport failure all mean
  // "no rules" — every URL is allowed and there are no robots-declared sitemaps.
  let robots: { isAllowed(url: string): boolean; sitemaps: string[] } = { isAllowed: () => true, sitemaps: [] }
  try {
    const robotsUrl = new URL('/robots.txt', siteUrl)
    const res = await pageFetch(robotsUrl, ROBOTS_FETCH_HEADERS)
    const contentType = (res.headers['content-type'] ?? res.headers['Content-Type'] ?? '').toLowerCase()
    if (res.status >= 200 && res.status < 300 && (contentType === '' || contentType.startsWith('text/'))) {
      robots = parseRobots(res.body, robotsUrl.toString())
    }
  } catch {
    // Transport failure: fall back to the permissive default above.
  }

  if (opts.signal.aborted) return { fetched: fetchedCount, ingested: ingestedCount, skipped: skippedCount, refused }

  // Rule 3: sitemap-first. Robots' own `Sitemap:` lines win; otherwise fall back to `/sitemap.xml`
  // at the site root.
  const sitemapUrlsToFetch = robots.sitemaps.length > 0 ? [...robots.sitemaps] : [new URL('/sitemap.xml', siteUrl).toString()]
  const { seeds: sitemapSeeds, offSite: offSiteSeeds } = await collectSitemapSeeds(sitemapUrlsToFetch, siteUrl, pageFetch, resolver, opts.signal)

  // The start URL is queued FIRST (review finding 5): a large sitemap can otherwise fill the
  // frontier's `maxSeen` cap entirely before the start URL ever gets a slot, silently dropping the
  // one URL the crawl absolutely must visit. It still goes into the LINK queue, though, so every
  // sitemap-seeded URL is still dequeued before it regardless of `add()` order — `Frontier.next()`
  // always drains the sitemap queue first (rule 3's "sitemap seeds before the start URL's links").
  const normalizedStart = normalizeUrl(opts.startUrl)
  if (normalizedStart) frontier.add([normalizedStart], 'link')

  frontier.add(sitemapSeeds, 'sitemap')
  for (const url of offSiteSeeds) recordOffSite(url)

  /** Queues the same-site links a page declared, and records the rest as `off_site` WITHOUT
   * enqueuing or resolving them (final review A4). Before this, every outbound link on a page took
   * a frontier slot (capped at `maxPages × 10`) and cost a `resolvePublic` DNS lookup on a
   * page-chosen hostname before `validateHop` refused it — so a site with hundreds of outbound
   * links starved same-site discovery on a small plan and turned the crawler into a DNS amplifier
   * for whatever hostnames the page felt like listing. */
  const addDiscoveredLinks = (hrefs: string[], baseUrl: string): void => {
    const normalized: string[] = []
    for (const href of hrefs) {
      const n = normalizeUrl(href, baseUrl)
      if (!n) continue
      if (isSameSiteUrl(n, siteUrl)) normalized.push(n)
      else recordOffSite(n)
    }
    frontier.add(normalized, 'link')
  }

  const processUrl = async (url: string): Promise<void> => {
    try {
      const result = await fetchResolved(pageFetch, url, siteUrl, resolver, robots.isAllowed)
      // Rule 2 (disallow half): never fetched, just counted — checked on every hop inside
      // fetchResolved now (review finding 9), including this URL itself (hop 0).
      if (result.kind === 'disallowed') { skippedCount++; return }
      if (result.kind === 'refused') { refused.push({ url: result.url, reason: result.reason }); return }
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
      const contentHash = contentHashOf(parsed.blocks)
      if (seenHashes.has(contentHash)) { skippedCount++; return }
      seenHashes.add(contentHash)

      ingestedCount++
      buffer.push({ url: finalUrl, title: parsed.title, blocks: parsed.blocks, contentHash })
      await maybeFlush()
    } catch (err) {
      // A persistence failure (BatchFlushError, from maybeFlush() above) must abort the whole
      // crawl (review finding 4) — it is NOT "this one page failed", and must not be swallowed
      // like every other page-level failure (a malformed response, a transport error, ...) below.
      if (err instanceof BatchFlushError) throw err
      skippedCount++
    } finally {
      await reportProgress()
    }
  }

  try {
    // Rule 10 (concurrency half) + rule 9 (maxPages counts INGESTED pages): each wave pulls at
    // most `concurrency` URLs, capped further by how many more pages could possibly be ingested,
    // so a wave can never push `ingestedCount` past `maxPages` even when every member of the wave lands.
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
      // `allSettled`, not `all`: `all` rejects the moment the FIRST worker's flush fails while its
      // siblings are still in flight, so the wave's own pages kept landing after `crawlSite` had
      // already settled. Settling the wave first (the `failed` latch above keeps any sibling from
      // calling `onBatch` or `onProgress` in the meantime) and only then re-throwing gives the
      // engine's "nothing fires after settlement" contract real teeth (final review A5).
      const settled = await Promise.allSettled(batch.map((url) => processUrl(url)))
      // Nothing but a BatchFlushError ever escapes `processUrl` — every page-level failure is
      // swallowed there — so the first rejection is the flush failure to report.
      const firstRejection = settled.find((r) => r.status === 'rejected')
      if (firstRejection) throw firstRejection.reason
    }
    // Drains everything left, in ≤cap-sized pieces — a single call isn't enough if a pile-up during
    // a slow mid-crawl flush left more than one `cap`'s worth of pages behind.
    while (buffer.length > 0 && !failed) {
      const cap = currentThreshold()
      firstBatchDone = true
      await flushSome(cap)
    }
  } catch (err) {
    if (err instanceof BatchFlushError) {
      // The message deliberately carries NO detail from `err.cause`: a consumer failure is a driver
      // or database message, which must never reach an owner-facing `failure_detail`. The cause
      // rides along on `cause` for the caller's own logging.
      throw new CrawlError('crawl_failed', 'batch persistence failed', { origin: 'consumer', cause: err.cause })
    }
    throw err
  }

  return { fetched: fetchedCount, ingested: ingestedCount, skipped: skippedCount, refused }
}
