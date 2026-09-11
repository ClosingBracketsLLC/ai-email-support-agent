/**
 * Also `@aesa/knowledge/url` — a pure sub-path (imports only `node:net`) so the api can normalize a
 * crawl URL (`knowledge.startCrawl`) without pulling in the rest of the crawler. This file must
 * NEVER import `@aesa/llm`, `../parsers/`, `../chunker.ts`, `../embed/`, or `./engine.ts` — the same
 * discipline `../storage/index.ts`'s header documents, and for the same reason: the api process must
 * never resolve the Anthropic SDK, `pdfjs-dist`, `mammoth` or `undici` through this import.
 */
import { isIP } from 'node:net'

function isIpLiteralHost(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
}

/** Normalize a discovered URL for frontier dedup: resolves `raw` against `base` (if given), keeps
 * only https (the crawler never fetches plain http — review finding 3), strips the fragment and a
 * default port (already dropped by `URL` itself) and a trailing `index.html`, lowercases the host
 * (already lowercased by `URL`'s own host parsing — done again here to document the contract), and
 * sorts nothing (query order is never touched). Returns `null` for anything that isn't a plain
 * https URL with a hostname: `http:`, `mailto:`, `tel:`, `javascript:`, an IP-literal host, or
 * unparsable input. This is a cheap SYNTACTIC filter only — a nonstandard port or other
 * `validateOutboundUrl`-only concern still passes through here and is caught later, at fetch time,
 * by `validateHop` (`engine.ts`). */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL
  try {
    url = base ? new URL(raw, base) : new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null
  if (isIpLiteralHost(url.hostname)) return null

  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -'index.html'.length)

  return url.toString()
}

function stripWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname
}

/** Same site as far as the crawler is concerned: the same hostname once a leading `www.` is
 * stripped from each side (so `www.acme.example` and `acme.example` are one site, but
 * `shop.acme.example` is not). */
export function sameSite(a: URL, b: URL): boolean {
  return stripWww(a.hostname.toLowerCase()) === stripWww(b.hostname.toLowerCase())
}
