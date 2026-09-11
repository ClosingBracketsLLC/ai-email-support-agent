/** The crawl's URL queue: dedupes on the (already-normalized) URL string and serves sitemap-seeded
 * URLs, in the order they were added, before any discovered-link URL — breadth-first within each
 * source. `maxSeen` (the engine passes `maxPages × 10`, rule 9) is the only cap this class owns:
 * once `seen.size` reaches it, `add` silently stops admitting NEW urls (a url already seen stays
 * deduped as normal); every other check (same-site, private-address, robots) is the caller's job. */
export class Frontier {
  private readonly sitemapQueue: string[] = []
  private readonly linkQueue: string[] = []
  private readonly maxSeen: number
  /** Every URL ever added, sitemap or link — the crawl's dedup set and its `maxPages × 10` cap gauge. */
  readonly seen = new Set<string>()

  constructor(opts: { maxSeen?: number } = {}) {
    this.maxSeen = opts.maxSeen ?? Infinity
  }

  add(urls: string[], source: 'sitemap' | 'link'): void {
    const queue = source === 'sitemap' ? this.sitemapQueue : this.linkQueue
    for (const url of urls) {
      if (this.seen.has(url)) continue
      // `continue`, not `return` (review finding 5): an over-cap entry is skipped, not a reason to
      // abandon the rest of THIS array — a caller that adds several urls in one call (or relies on
      // add() never bailing out early) must not have entries after the cap silently vanish for a
      // reason unrelated to them individually.
      if (this.seen.size >= this.maxSeen) continue
      this.seen.add(url)
      queue.push(url)
    }
  }

  next(): string | null {
    if (this.sitemapQueue.length > 0) return this.sitemapQueue.shift()!
    if (this.linkQueue.length > 0) return this.linkQueue.shift()!
    return null
  }

  /** URLs still queued (not yet handed out by `next`). */
  get size(): number {
    return this.sitemapQueue.length + this.linkQueue.length
  }
}
