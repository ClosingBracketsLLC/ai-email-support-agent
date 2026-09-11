import { Parser } from 'htmlparser2'

/** The sitemap protocol's own per-file cap (https://www.sitemaps.org/protocol.html): a `<urlset>`
 * — or a `<sitemapindex>` — past this many `<loc>` entries is truncated rather than trusted whole.
 * The index side is capped for the same reason as the url side: a hostile 50,000-entry
 * `<sitemapindex>` would otherwise build a 50,000-string array in memory, of which the engine
 * fetches at most `MAX_SITEMAP_FETCHES` (5) anyway. */
const MAX_SITEMAP_URLS = 5_000

/** Parse a sitemap XML document: a `<urlset>` yields page `<loc>`s in `urls`, a `<sitemapindex>`
 * yields child-sitemap `<loc>`s in `sitemaps`. Tolerant of whichever one is present (or, for a
 * malformed document, neither) — htmlparser2 in `xmlMode` never throws on bad markup. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const urls: string[] = []
  const sitemaps: string[] = []
  // Which entry kind is currently open: `<url>...</url>` or `<sitemap>...</sitemap>`. Only a
  // `<loc>` seen while one of these is open is collected — a `<loc>` elsewhere in the document
  // (there is no such element in a valid sitemap, but the parser stays tolerant) is ignored.
  let context: 'url' | 'sitemap' | null = null
  let inLoc = false
  let locText = ''

  const parser = new Parser(
    {
      onopentag(name) {
        if (name === 'url' || name === 'sitemap') context = name
        else if (name === 'loc') { inLoc = true; locText = '' }
      },
      ontext(data) {
        if (inLoc) locText += data
      },
      onclosetag(name) {
        if (name === 'loc') {
          inLoc = false
          const loc = locText.trim()
          if (loc.length > 0) {
            if (context === 'url') { if (urls.length < MAX_SITEMAP_URLS) urls.push(loc) }
            else if (context === 'sitemap') { if (sitemaps.length < MAX_SITEMAP_URLS) sitemaps.push(loc) }
          }
        } else if (name === 'url' || name === 'sitemap') {
          context = null
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  )
  parser.end(xml)

  return { urls, sitemaps }
}
