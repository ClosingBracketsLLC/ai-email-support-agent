/**
 * The one-click review pages' styles, built ONCE from the brand tokens. A system font stack on purpose:
 * a page opened from an email must not wait on a web font (spec §4), and the wordmark is an SVG outline,
 * so the brand's typeface still appears without one. Light by default, dark under prefers-color-scheme.
 */
import { BRAND } from '@aesa/contracts'

const L = BRAND.light
const D = BRAND.dark

const vars = (v: Record<string, string>) => Object.entries(v).map(([k, val]) => `--${k}:${val}`).join(';')

export const REVIEW_CSS = [
  `:root{${vars({ primary: L.primary, 'primary-on': L.primaryOn, ink: L.ink, slate: L.slate, line: L.line, mist: L.mist, paper: L.paper, 'warning-tint': L.warningTint, 'warning-text': L.warningText })};color-scheme:light dark}`,
  `@media(prefers-color-scheme:dark){:root{${vars({ primary: D.lifted, 'primary-on': D.liftedOn, ink: D.paperOnNight, slate: D.slateOnNight, line: D.lineOnNight, mist: D.nightSurface, paper: D.night, 'warning-tint': D.warningTint, 'warning-text': D.warningText })}}}`,
  'body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'main{max-width:600px;margin:0 auto;padding:24px 20px}',
  'header{display:flex;align-items:center;padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:20px}',
  'header svg{height:20px;width:auto;color:var(--ink)}',
  'h1{font-size:24px;line-height:1.2;margin:0 0 8px}',
  'p{margin:0 0 12px}.meta{color:var(--slate)}',
  'pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,Menlo,"Roboto Mono",monospace;background:var(--mist);border:1px solid var(--line);border-radius:10px;padding:16px}',
  '.warn{background:var(--warning-tint);color:var(--warning-text);border-radius:10px;padding:12px 16px;margin:0 0 12px}.warn p{margin:0}.warn ul{margin:4px 0 0;padding-left:20px}',
  'form{margin:12px 0}',
  'button{font:inherit;font-weight:600;min-height:48px;padding:0 24px;border-radius:10px;border:1px solid var(--primary);background:var(--primary);color:var(--primary-on);cursor:pointer}',
  'button.secondary{background:transparent;color:var(--primary)}',
  'a{color:var(--primary)}',
].join('')

/** The wordmark as an inline SVG outline — the only way a mail-client browser shows Fraunces without loading it. */
export const WORDMARK_SVG = `<svg viewBox="${BRAND.paths.wordmark.viewBox}" role="img" aria-label="aesa"><path fill="currentColor" d="${BRAND.paths.wordmark.d}"/></svg>`
