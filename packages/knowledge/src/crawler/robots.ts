import robotsParserImport from 'robots-parser'

/** `robots-parser`'s own `index.d.ts` ships a malformed declaration (a bare, brace-less `declare
 * module 'robots-parser';` ambient statement sitting next to the real `export default function` —
 * https://github.com/samclarke/robots-parser, unfixed as of 3.0.1), so TypeScript resolves the
 * default import as the whole module namespace instead of the callable it actually is. The
 * runtime value is correct (Node's CJS/ESM interop binds `default` to `module.exports`, which
 * `index.js` sets to the parser function directly) — only the static type is wrong, so this
 * re-types the import rather than routing around it. */
interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined
  getSitemaps(): string[]
}
const robotsParser = robotsParserImport as unknown as (url: string, robotstxt: string) => Robot

/** The crawler's own user-agent token, matched against robots.txt `User-agent:` groups. Shares
 * the product name with the HTTP `User-Agent` header the engine sends (`aesa-crawler/1.0
 * (+https://aesa.app)`) — robots-parser only needs the short token, not the full UA string. */
export const CRAWLER_USER_AGENT = 'aesa-crawler'

/** Parse a robots.txt body. `base` is the URL robots.txt was fetched from (robots-parser resolves
 * relative `Allow`/`Disallow` paths and `Sitemap:` lines against it). `isAllowed` defaults to
 * ALLOWED for a URL the rules don't mention (robots-parser returns `undefined` there) — robots.txt
 * is an opt-out mechanism, not an allowlist. */
export function parseRobots(text: string, base: string): { isAllowed(url: string): boolean; sitemaps: string[] } {
  const robots = robotsParser(base, text)
  return {
    isAllowed: (url: string) => robots.isAllowed(url, CRAWLER_USER_AGENT) !== false,
    sitemaps: robots.getSitemaps(),
  }
}
