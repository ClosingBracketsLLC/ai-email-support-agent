# aesa brand system — design

**Status:** approved in brainstorming on 2026-09-10 (Robert). **Scope:** the identity, tokens and asset pipeline for the product and its future landing page. **Out of scope:** the landing page itself, animation, illustration, HTML email templates.

## 1. Purpose

`aesa` (AI Email Support Agent, pronounced "AY-sah") is now the product name, lowercase everywhere. This spec fixes the brand so the app, the api's review pages, the platform email and the coming public landing page draw from one set of files and tokens. Personality: **calm operator** — quiet, precise, trustworthy, with the one gesture of personality carried by a serif letterform. Standalone: ClosingBrackets appears only in legal footers and store listings.

## 2. Identity

### 2.1 The mark

The mark is the **æ** ligature of Fraunces 144pt SemiBold (upright), with its central column narrowed so the two halves flow together. It is derived, not drawn:

- Source: `Fraunces144pt-SemiBold.ttf` from the Fraunces project (https://github.com/undercasetype/Fraunces, SIL Open Font License 1.1), glyph U+00E6, 2000 units per em, x-height 878.
- Transform (font units, y up): a piecewise-linear x-warp — `x < 584` unchanged; `584 ≤ x ≤ 771` compressed linearly so the column shrinks from 187 to 153 units; `x > 771` shifted left by 34. Every on-curve and control point is mapped, so there is no seam; no curve is redrawn.
- Result: bounding box x 42–1319, y −20–898 (font units). The final outline is the union of the warped contours (three contours: the outline and two counters).

Colourways: **azure** on light, **ink** on light, **paper** on dark, **lifted blue** on dark. Clear space around the mark equals the height of the `a`'s bowl. Minimum sizes: 16 px for the bare mark, 24 px inside a lockup. The mark is always a filled outline (never a stroke) and never rotated, outlined, shadowed or recoloured outside the four colourways.

### 2.2 The wordmark and lockups

- Wordmark: `aesa` in Fraunces SemiBold at the 144-point optical size, lowercase always, tracking −0.5%, delivered as SVG outlines (no font dependency at any surface).
- Horizontal lockup: the mark sits on the wordmark's baseline, its height equal to the wordmark's x-height plus ascender; gap = one stem width. Stacked lockup: the mark centred above the wordmark, gap = half the mark's height.
- `æsa` (the flourish, the ligature inside the name) is marketing-only, never in the app chrome, email or legal text.

### 2.3 App icon, favicon, splash

- App icon treatment: **lifted blue on ink** — the mark in lifted blue centred on the night background; the mark's height is 56% of the tile; iOS masks the corners, Android's adaptive icon uses a transparent-foreground layer over the night background colour.
- Favicon: the bare mark in azure on transparent (SVG, plus 16/32/48 PNG and an ICO). Apple touch icon 180 px uses the app-icon treatment.
- Splash: night background, the mark in lifted blue at 20% of the short edge. Notification icon: the mark in white on transparent (Android tints it).
- Social card (Open Graph) 1200×630: night background, the horizontal lockup in lifted blue and paper.

## 3. Colour tokens

Light theme (text-on-background contrast, WCAG): azure on paper 5.17, ink on paper 17.1, slate on paper 5.4.

| token | value | use |
|---|---|---|
| `primary` | `#2563EB` | actions, links, the mark |
| `primaryTint` | `#E8EEFF` | chip and selection backgrounds |
| `primaryOn` | `#FFFFFF` | text on primary |
| `ink` | `#0F1B33` | text |
| `slate` | `#5B6B85` | muted text |
| `line` | `rgba(15,27,51,0.14)` | borders |
| `mist` | `#F3F6FB` | secondary surface |
| `paper` | `#FFFFFF` | surface |
| `success` / `successTint` / `successText` | `#0E9F6E` / `#D5F3E8` / `#0A7A55` | sent; chip text is the darker shade (4.54 on the tint) |
| `successOn` | `#FFFFFF` on `#0A7A55` | solid success buttons use the darker green |
| `warning` / `warningTint` / `warningText` | `#F59E0B` / `#FFF0D3` / `#92400E` | on hold (6.3 on the tint); solid warning uses ink text (7.98) |
| `danger` / `dangerTint` / `dangerText` | `#E11D48` / `#FFE1E8` / `#BE123C` | blocked (5.14 on the tint); white on danger 4.7 |

Dark theme: `night #0B1220` (background), `nightSurface #16213A`, `paperOnNight #EEF2F7` (text, 16.7), `slateOnNight #AAB4C6`, `lifted #93B4FF` (primary, 9.1), `liftedTint rgba(147,180,255,0.12)`; states keep their base hues with lifted text shades `#34D399` / `#FBBF24` / `#FB7185` on `rgba(<base>,0.12)` tints. Every documented pair is pinned by a test.

## 4. Typography

- **Display:** Fraunces, weights 500 and 600, optical size 144 for headlines ≥ 28 px and 36 for 18–27 px; letter-spacing −1% at display sizes. Used for screen titles, the go-live and empty-state headlines, the landing hero.
- **UI:** Plus Jakarta Sans 400/500/600 for everything else (body 15/22, small 13/18, label 12/16 uppercase +6% tracking).
- **Mono:** the draft body keeps the platform monospace (Menlo / Roboto Mono) so whitespace is exact.
- Loading: the app bundles both faces through `@expo-google-fonts/fraunces` and `@expo-google-fonts/plus-jakarta-sans` (no runtime network request); the api's review pages and the platform emails use the SVG wordmark and a system font stack — a one-click page must not wait on a font, and email clients do not load web fonts.

## 5. Icons

A 24-unit grid, 2-unit stroke, round caps and joins, one colour (`ink`, `slate`, or a state colour). Base set: Lucide (ISC). Eight product icons drawn to the same rules: inbox, reply, approve (circled check), hold (circled pause), send, agent, activity, settings. Delivered as SVG components in the app; no new icon-font dependency.

## 6. Where it lives

```
brand/
  README.md              # rules in brief + how to rebuild
  brand.md               # the guide: identity, clear space, colour, type, icons, do/don't, licences, derivation
  tokens.json            # the colour/type/radius tokens, the single source
  mark.svg               # azure; mark-ink.svg, mark-paper.svg, mark-lifted.svg
  wordmark.svg           # outlines
  lockup-horizontal.svg  lockup-stacked.svg
  og-image.svg           # 1200×630 source
  icons/*.svg            # the eight product icons
  scripts/build.ts       # renders every raster from the SVGs (tsx)
  scripts/derive/        # the Python derivation of the mark (fontTools + skia-pathops), kept for reproducibility; not part of the gate
```

- `pnpm brand:build` (root script) rasterises with `@resvg/resvg-js` (a root devDependency; pure Rust-in-WASM, no system libraries) into `apps/app/assets/` (`icon.png` 1024, `adaptive-icon.png` 1024 foreground, `splash-icon.png`, `notification-icon.png` 96, `favicon.png` 48) and `apps/api/public/` (`favicon.svg`, `favicon-16.png`, `favicon-32.png`, `favicon.ico`, `apple-touch-icon.png` 180, `og.png` 1200×630). Generated files are committed (the app's build and the api's static route read them); the script is idempotent and a test asserts the outputs match the sources.
- Tokens as code: `packages/contracts/src/brand.ts` exports `BRAND` (plain TypeScript constants generated from `tokens.json` by the build script; zod-free, no Node imports) — the app's theme (`useColors`, light and dark) and the api's review-page CSS read from it. The app-icon background colour in `app.json` equals `BRAND.dark.night`.
- The app: the header lockup (mark + wordmark SVG), the fonts loaded at the gate with a splash hold, the state chips and buttons on the tokens, the icons component. The api: the review pages' CSS variables from the tokens, the SVG wordmark in the page header, the favicons and the social card served from `public/`. Platform email: text stays text; the signature line "Sent by aesa on behalf of …" is unchanged.

## 7. Testing

`brand/test/`: every SVG parses and the mark's path bounding box equals the derivation's; the build outputs exist at the documented dimensions (PNG headers read, ICO directory parsed); every documented text/background pair meets WCAG AA (≥ 4.5, or ≥ 3.0 where noted for large text) with the numbers pinned; `tokens.json` and `packages/contracts/src/brand.ts` agree. App: the theme snapshot uses only token values; `app.json` references the generated files. The CI gate stays `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check`; `pnpm brand:build` is run by hand when a source changes and its outputs are diffed in review.

## 8. Rights and licences

- Fraunces (mark, wordmark source) and Plus Jakarta Sans: SIL Open Font License 1.1 — free for commercial use and modification; the typefaces themselves stay non-exclusive and any modified *font file* would have to be renamed and stay OFL (none is shipped — only outlines).
- Lucide icons: ISC.
- The mark and wordmark artwork, the lockups and the token system are ClosingBrackets LLC's work; trademark registration of the mark is Robert's call and an attorney's review.
- `brand/brand.md` records the derivation parameters and licences so the provenance is auditable.

## Appendix A — the mark's outline

The derived path (SVG path data, y-down, in a 1000-unit box: `y_svg = 1000 − y_font`; use `viewBox="2 62 1357 998"` for the tight bounding box or pad 40 units per side for the centred box):

```
M1319.0 483.0Q1319.0 373.0 1273.0 287.0Q1227.0 201.0 1142.5 151.5Q1058.0 102.0 941.0 102.0Q861.0 102.0 790.0 131.5Q722.272705078125 161.0 681.3636474609375 211.0Q633.0908813476562 102.0 461.0 102.0Q340.0 102.0 258.0 135.0Q176.0 168.0 134.0 219.0Q92.0 270.0 92.0 322.0Q92.0 369.0 117.5 393.0Q143.0 417.0 182.0 417.0Q237.0 417.0 272.5 382.5Q308.0 348.0 308.0 299.0V218.0Q308.0 178.0 338.5 147.0Q369.0 116.0 432.0 116.0Q548.0 116.0 548.0 264.0V586.0Q522.0 576.0 491.0 570.0Q460.0 564.0 418.0 564.0Q222.0 564.0 132.0 630.5Q42.0 697.0 42.0 806.0Q42.0 899.0 116.0 958.5Q190.0 1018.0 308.0 1018.0Q402.0 1018.0 484.5 977.5Q567.0 937.0 617.5454711914062 852.0Q661.727294921875 931.0 733.3181762695312 975.5Q820.0 1020.0 930.0 1020.0Q1036.0 1020.0 1120.5 975.0Q1205.0 930.0 1256.5 852.5Q1308.0 775.0 1314.0 676.0Q1314.0 667.0 1307.0 667.0Q1303.0 667.0 1302.0 674.0Q1293.0 772.0 1222.0 829.5Q1151.0 887.0 1048.0 887.0Q912.0 887.0 826.5 792.5Q741.0 698.0 736.1818237304688 502.0H1297.0Q1319.0 502.0 1319.0 483.0ZM735.3636474609375 479.0Q735.3636474609375 118.0 919.0 118.0Q991.0 118.0 1036.0 203.0Q1081.0 288.0 1081.0 466.0Q1081.0 485.0 1065.0 485.0H735.3636474609375ZM280.0 771.0Q280.0 680.0 320.0 630.0Q360.0 580.0 436.0 580.0Q495.0 580.0 548.0 599.0Q553.0 738.0 611.0 840.0Q576.0 897.0 527.0 923.5Q478.0 950.0 429.0 950.0Q363.0 950.0 321.5 904.5Q280.0 859.0 280.0 771.0Z
```

Derivation script and parameters: `brand/scripts/derive/` (Python 3.12, `fonttools` 4.65, `skia-pathops`; `uv venv` + `uv pip install fonttools skia-pathops`), input `Fraunces144pt-SemiBold.ttf` at the Fraunces repository's `fonts/ttf/` path, warp `LO=584, HI=771, DELTA=34`.
