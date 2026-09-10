# The aesa brand guide

The normative source is `docs/superpowers/specs/2026-09-10-aesa-brand-design.md`; this file
carries the same content plus every number the brand-system plan fixed when it turned the spec's
prose into files. `brand/README.md` is the short version — rules and the rebuild command.

## 1. Identity

`aesa` — AI Email Support Agent, pronounced "AY-sah" — is the product name, lowercase everywhere:
in app chrome, copy, `aria-label`s, `<title>`s, platform email, the review pages. Personality:
**calm operator** — quiet, precise, trustworthy — carried by one gesture of character: a serif
letterform (Fraunces) sitting inside an otherwise plain sans-serif interface. ClosingBrackets LLC
is the company behind it but does not appear in the product itself; it shows up only in legal
footers and store listings.

## 2. The mark

The mark is the **æ** ligature of Fraunces 144pt SemiBold (upright), U+00E6, derived rather than
drawn: a piecewise-linear x-warp narrows the glyph's central column from 187 to 153 font units so
its two halves read as one shape, with every on-curve and off-curve point mapped (nothing
redrawn) —

- `x < 584` unchanged
- `584 ≤ x ≤ 771` compressed linearly (the warp's `LO`/`HI`)
- `x > 771` shifted left by 34 units (the warp's `DELTA`)

— and the three warped contours (the outline and two counters) are unioned into one outline.
Source bounding box, font units (2000/em, y-up): x 42–1319, y −20–898. `brand/mark.svg` stores
that same box in the y-down 1000-unit space the SVG lives in (baseline at y = 1000): viewBox
`42 102 1277 918`, ink bounds `{minX: 42, minY: 102, maxX: 1319, maxY: 1020}` — a TIGHT box, no
padding (§8's `brand/test/sources.test.ts` pins both). `brand/scripts/derive/mark-derived.svg` is
the derivation's own record of the same path, and `sources.test.ts` asserts `mark.svg`'s path
data equals it byte for byte.

Colourways (four only):

| name | hex | use |
|---|---|---|
| azure | `#2563EB` | the bare mark on light backgrounds, favicons |
| ink | `#0F1B33` | the mark on light backgrounds where azure is already in use nearby |
| paper | `#FFFFFF` | the mark on dark/coloured backgrounds |
| lifted (blue) | `#93B4FF` | the mark on night (`#0B1220`) — app icon, splash, OG card |

Clear space around the mark equals the height of the `a`'s bowl. Minimum sizes: 16 px for the bare
mark, 24 px inside a lockup (the app's `Mark`/`Lockup` components in
`apps/app/src/components/brand.tsx` default to exactly those heights). Do/don't: the mark is
always a filled outline — never a stroke — and never rotated, outlined, shadowed or recoloured
outside the four colourways above.

## 3. Wordmark and lockups

The wordmark is `aesa`, lowercase always, set in Fraunces SemiBold at its 144-point optical size
and shaped by HarfBuzz (so any GPOS kerning the font carries is honoured — it carries none for
these four letters; the advances equal `hmtx`), letter-spaced −0.5% of the em (−10 units at
2000/em), delivered as unioned SVG outlines — no font dependency at any surface that draws it.
`brand/wordmark.svg`'s tight ink box: viewBox `42 100 3383 920`, ink bounds
`{minX: 42, minY: 100, maxX: 3425, maxY: 1020}` (`sources.test.ts`).

**Horizontal lockup** (`brand/lockup-horizontal.svg`, `compose.ts`'s `lockupHorizontal`): the mark
sits on the wordmark's baseline; its top meets the wordmark's ascender line — x-height (878) plus
the ascender's rise above it (606) = 1484 font units, the top of Fraunces' `d`/`l`/`h`/`b` — which
fixes the mark's scale at `1484 / (1000 − 102) = 1484/898 ≈ 1.6526`. The gap between the mark and
the wordmark is one stem width: 240 font units, the `a`'s stem at mid x-height (the `l` measures
239 at every height, close enough to treat as the same constant). Built viewBox:
`0 -484 5733.3207 1517.0512`.

**Stacked lockup** (`brand/lockup-stacked.svg`, `lockupStacked`): the mark at the SAME size as in
the horizontal lockup, centred above the wordmark; the gap between them is half the mark's height
(the wordmark's top sits at `1.5 ×` the mark's height). Built viewBox:
`0 0 3383 3195.5768`.

Both lockups are generated from `mark.svg` + `wordmark.svg` + `tokens.json` by
`brand/scripts/build.ts`, and the app draws its `Lockup` component (`components/brand.tsx`) from
the SAME transforms — `BRAND.paths.lockupHorizontal.{markTransform,wordmarkTransform}`, produced
by the identical `compose.ts` call — so the SVG file and the app's rendering can never drift
apart.

`æsa` (the ligature flourish inside the name — the mark literally replacing the wordmark's `æ`) is
marketing-only. It never appears in app chrome, platform email or legal text.

## 4. App icon, favicon, splash, notification, social card

Every raster `pnpm brand:build` writes, its size, and the ratio (`tokens.json`'s `mark.raster`)
that places the mark inside it:

| file | size | ratio | notes |
|---|---|---|---|
| `apps/app/assets/icon.png` | 1024×1024 | `appIconHeight` 56% of tile height | lifted blue mark on night (`#0B1220`) — iOS masks the corners itself |
| `apps/app/assets/adaptive-icon.png` | 1024×1024 | `adaptiveIconHeight` 35% of tile height | lifted blue mark, transparent background; `app.json`'s `android.adaptiveIcon.backgroundColor` supplies night separately |
| `apps/app/assets/splash-icon.png` | 1024×736 | — | the bare lifted-blue mark at its own tight aspect ratio; placed by `app.json`'s `expo-splash-screen` plugin at `imageWidth: 108` |
| `apps/app/assets/notification-icon.png` | 96×96 | `notificationWidth` 84% of tile width | white mark, transparent (Android tints it; `app.json`'s `expo-notifications` plugin sets the accent colour `#2563EB` separately) |
| `apps/app/assets/favicon.png` | 48×48 | `faviconWidth` 92% of tile width | azure mark, transparent — the Expo web favicon |
| `apps/api/public/favicon.svg` | viewBox `0 0 64 64` | `faviconWidth` 92% | azure mark on transparent — a browser tab, not text, so no contrast pair applies |
| `apps/api/public/favicon-16.png` / `favicon-32.png` | 16×16 / 32×32 | `faviconWidth` 92% | same tile, rasterised |
| `apps/api/public/favicon.ico` | — | — | packs the 16/32/48 px PNGs into one ICO container (`scripts/ico.ts`) |
| `apps/api/public/apple-touch-icon.png` | 180×180 | `appIconHeight` 56% | the app-icon treatment (lifted blue on night), not the adaptive ratio — iOS only rounds corners, so 56% still lies inside them |
| `apps/api/public/og.png` | 1200×630 | `ogLockupWidth` 640 px | night background; the horizontal lockup, lifted (mark) + `paperOnNight` (wordmark), centred at 640 px wide |

**Why the adaptive icon differs.** Android masks adaptive icons to a 66/108 safe circle (626 px of
a 1024 tile). At the spec's 56% the mark is 798 px wide and clips on round masks, so the Android
foreground layer alone uses 35% — small enough that the whole mark's bounding box sits inside the
safe circle. The iOS icon and the Apple touch icon keep 56%, since iOS only rounds corners rather
than masking to a circle.

**Why the splash width is `108`, not "20% of the short edge."** `expo-splash-screen` sizes its
image by width in dp, the same for every device, so the ratio is fixed against a reference
390-pt phone: 20% of 390 = 78 pt tall → 78 × (1277/918) = 108 pt wide (the mark's own aspect
ratio, `MARK_ASPECT` in `compose.ts`).

## 5. Colour

Every pair below is pinned by `brand/test/contrast.test.ts`, which recomputes the ratio and fails
if it moves. The floor is 4.5 (AA body text) unless marked "large text only" (3.0).

**Light** (`tokens.json`'s `light`):

| token | value | use | key contrast pairs |
|---|---|---|---|
| `primary` | `#2563EB` | actions, links, the mark | on `paper` 5.17; on `mist` 4.77; `primaryOn` on `primary` 5.17 |
| `primaryTint` | `#E8EEFF` | chip/selection backgrounds | `ink` on it 14.78; `slate` on it 4.66; `primary` on it 4.46 — **large text only** |
| `primaryOn` | `#FFFFFF` | text on `primary` | see above |
| `ink` | `#0F1B33` | text | on `paper` 17.14; on `mist` 15.83; on `primaryTint` 14.78 |
| `slate` | `#5B6B85` | muted text | on `paper` 5.4; on `mist` 4.99; on `primaryTint` 4.66 |
| `line` | `rgba(15,27,51,0.14)` | borders | — |
| `mist` | `#F3F6FB` | secondary surface | — |
| `paper` | `#FFFFFF` | surface | — |
| `success` / `successTint` / `successText` / `successSolid` / `successOn` | `#0E9F6E` / `#D5F3E8` / `#0A7A55` / `#0A7A55` / `#FFFFFF` | sent | `successText` on `successTint` 4.54; on `paper` 5.35; `successOn` on `successSolid` 5.35 |
| `warning` / `warningTint` / `warningText` / `warningOn` | `#F59E0B` / `#FFF0D3` / `#92400E` / `#0F1B33` (ink) | on hold | `warningText` on `warningTint` 6.3; on `paper` 7.09; `warningOn` on `warning` 7.98 |
| `danger` / `dangerTint` / `dangerText` / `dangerOn` | `#E11D48` / `#FFE1E8` / `#BE123C` / `#FFFFFF` | blocked | `dangerText` on `dangerTint` 5.14; on `paper` 6.29; `dangerOn` on `danger` 4.7 |

**`successSolid` note.** A solid success button (white text on the base green `success`) is only
3.39 — below AA — which is why every solid success surface uses the darker `successSolid`
(`#0A7A55`, 5.35) instead; `success`/`successTint`/`successText` stay the base hue for chips and
banners, which never put white text directly on `success`.

**`primary` on `primaryTint` — large text only.** 4.46 is below the 4.5 AA body floor; it clears
only the 3.0 large-text floor, and only at ≥ 18.66 px bold — nothing in the app renders text that
large in that combination today. Chips and selected cards on `primaryTint` use `ink` text (14.78)
instead; `brand/test/contrast.test.ts` still pins the 4.46 pair (as large-text) so the number
stays visible rather than silently unused.

**Dark** (`tokens.json`'s `dark`; tints are rgba composited over `night` for the contrast math):

| token | value | use | key contrast pairs |
|---|---|---|---|
| `night` | `#0B1220` | background | — |
| `nightSurface` | `#16213A` | secondary surface | `paperOnNight` on it 14.23; `slateOnNight` on it 7.66 |
| `paperOnNight` | `#EEF2F7` | text | on `night` 16.65 |
| `slateOnNight` | `#AAB4C6` | muted text | on `night` 8.96 |
| `lineOnNight` | `rgba(238,242,247,0.14)` | borders | added token (below) |
| `lifted` | `#93B4FF` | primary (dark) | on `night` 9.11; on `nightSurface` 7.78 |
| `liftedTint` | `rgba(147,180,255,0.12)` | chip/selection backgrounds | `paperOnNight` on it 13.59; `lifted` on it 7.43 |
| `liftedOn` | `#0B1220` | text on a lifted-blue button | added token (below); 9.11 |
| `success` / `successTint` / `successText` / `successSolid` / `successOn` | `#0E9F6E` / `rgba(14,159,110,.12)` / `#34D399` / `#0A7A55` / `#FFFFFF` | sent | `successText` on `successTint` 8.49; on `night` 9.74; `successOn` on `successSolid` 5.35 |
| `warning` / `warningTint` / `warningText` / `warningOn` | `#F59E0B` / `rgba(245,158,11,.12)` / `#FBBF24` / `#0F1B33` | on hold | `warningText` on `warningTint` 9.36; on `night` 11.22 |
| `danger` / `dangerTint` / `dangerText` / `dangerOn` | `#E11D48` / `rgba(225,29,72,.12)` / `#FB7185` / `#FFFFFF` | blocked | `dangerText` on `dangerTint` 6.51; on `night` 6.96; `dangerOn` on `danger` 4.7 |

**Two dark tokens the spec's prose omits, added in the plan (both pinned in `contrast.test.ts`):**
`lineOnNight` (borders on night — the same recipe as light's `line`: the theme's text colour at
14% opacity, mirrored) and `liftedOn` (`#0B1220`, i.e. `night` itself — text on a lifted-blue
button, 9.11).

## 6. Type

- **Display** — Fraunces, weights 500 and 600, optical size 144 for headlines. Used for screen
  titles (`title`, 28/34), go-live and empty-state headlines.
- **UI** — Plus Jakarta Sans 400/500/600 for everything else.
- **Mono** — the draft body keeps the platform monospace (`Menlo` on iOS, `monospace` elsewhere)
  so whitespace in a customer's email is exact.
- **Scale** (`tokens.json`'s `type.scale`, consumed by `theme.ts`'s `typeScale`): `title` 28/34,
  Fraunces 600, −1% letter-spacing; `heading` 20/26, UI 600; `body` 15/22, UI 400; `bodyStrong`
  15/22, UI 600 (replaces `fontWeight: 'bold'` on body text); `small` 13/18, UI 400 (the theme's
  `caption`); `label` 12/16, UI 600, uppercase, +6% letter-spacing.

**One family per weight, and why.** `theme.ts`'s `font` names five registered faces —
`Fraunces_600SemiBold`, `Fraunces_500Medium`, `PlusJakartaSans_400Regular`,
`PlusJakartaSans_500Medium`, `PlusJakartaSans_600SemiBold` — bundled via
`@expo-google-fonts/fraunces` 0.4.1 and `@expo-google-fonts/plus-jakarta-sans` 0.4.2 and loaded at
the splash hold (`src/lib/fonts.ts`'s `useBrandFonts`, awaited in `src/app/_layout.tsx`). No style
in the app sets `fontWeight`: with a single static face registered per weight, Android would
synthetically embolden a wrong-weight face and iOS ignores `fontWeight` on a specific static face
entirely — naming the correct face (`font.uiStrong` instead of `fontWeight: '600'`) is the only
way to get the right weight on both platforms. `brand/test/app-typography.test.ts` and
`apps/app/src/theme.test.ts` enforce both this and the no-literal-colour rule (§5).

**The optical-size deviation.** The spec calls for Fraunces optical size 36 at 18–27 px; the
Google Fonts statics `@expo-google-fonts/fraunces` ships are cut at the axis default (opsz 144)
only. Nothing in the app sets display type in that 18–27 px range today — `title` is 28 px
(opsz 144 is correct there) and `heading` stays in the UI face — so the gap is unused rather than
wrong. The landing page, its own plan, can load the variable Fraunces font on web and use opsz 36
for its mid-size headings.

**The review pages' stack.** `apps/api/src/brand/css.ts` sets
`system-ui,-apple-system,"Segoe UI",Roboto,sans-serif` — a one-click link opened from an email
client must not wait on a web font, and most mail-client browsers never load one anyway. The
wordmark still appears in the page header as an inline SVG outline (`WORDMARK_SVG`), so the
brand's serif gesture survives without shipping a font file.

## 7. Icons

A 24-unit grid, 2-unit stroke, round caps and joins, `fill="none"`, one colour supplied by the
caller (`ink`, `slate`, or a state colour) — never baked into the SVG. Base set: Lucide 1.44.0
(ISC), with every non-`<path>` primitive (`circle`, `rect`, `polyline`, `line`) rewritten as an
equivalent `<path>` so `brand/test/sources.test.ts` can assert every icon file is `<path>`-only.

| name | Lucide source | note |
|---|---|---|
| `inbox` | `inbox` | |
| `reply` | `reply` | |
| `approve` | `circle-check` | the circle drawn as two arcs |
| `hold` | `circle-pause` | |
| `send` | `send` | |
| `agent` | `bot` | the rounded rect drawn as a path |
| `activity` | `activity` | |
| `settings` | `settings` | the r=3 centre circle drawn as two arcs |

The eight files under `brand/icons/` compile into `BRAND.icons` (a name → path-list map) by
`pnpm brand:build`; `apps/app/src/components/icon.tsx`'s `<Icon name size color>` draws one
`<Path>` per entry with the stroke rules on the root `<Svg>`. Nothing else in the app imports an
icon font — `@expo/vector-icons` stays a `package.json` dependency only because `expo-router`
itself depends on it; `brand/test/app-typography.test.ts` fails if any app source file imports it
directly.

## 8. Where things live

```
brand/
  README.md                                      rules in brief + how to rebuild
  brand.md                                        this file
  tokens.json                                     SOURCE — colour, type, radius, spacing, mark-raster, icon-grid
  mark.svg                                        SOURCE — the mark, azure, tight ink box (§2)
  wordmark.svg                                    SOURCE — aesa outlines, tight ink box (§3)
  icons/*.svg                                     SOURCE — the eight product icons (§7)
  mark-ink.svg  mark-paper.svg  mark-lifted.svg   GENERATED — the other three colourways
  lockup-horizontal.svg  lockup-stacked.svg       GENERATED (§3)
  og-image.svg                                    GENERATED — 1200×630 (§4)
  scripts/
    svg.ts                                        allPathData / pathData / viewBox / hullBounds — the SVG regex helpers, imported by build.ts AND test/
    compose.ts                                    pure geometry: markSvg, placeMark, lockupHorizontal, lockupStacked, tile, ogImage
    ico.ts                                        packs/reads the ICO container
    build.ts                                       `pnpm brand:build`'s entry point — reads the four sources, writes the 18 OUTPUT_PATHS
    derive/                                        the Python derivation — not part of the CI gate; see its own README (§9)
  test/                                             sources, compose, build, tokens, contrast, app-typography

apps/app/assets/
  icon.png  adaptive-icon.png  splash-icon.png  notification-icon.png  favicon.png    GENERATED (§4)

apps/api/public/
  favicon.svg  favicon-16.png  favicon-32.png  favicon.ico  apple-touch-icon.png  og.png    GENERATED (§4)

packages/contracts/src/brand.ts                    GENERATED — BRAND: tokens + paths.{mark,wordmark,lockupHorizontal} + icons
```

The consumers (source files, not generated, but built against `BRAND`):

- **App:** `apps/app/src/theme.ts` (`palettes`, `font`, `typeScale`, `radius`, `spacing`), `src/lib/fonts.ts`
  (`useBrandFonts`), `src/components/brand.tsx` (`Mark`, `Wordmark`, `Lockup`), `src/components/icon.tsx`
  (`Icon`, `ICON_NAMES`), `src/components/chip.tsx` (`Chip`), `app.json` (icon/adaptive-icon/splash/
  notification/favicon paths, the night background colour, the accent colour — every value there is a
  `BRAND`/`tokens.json` value copied in, not re-derived).
- **Api:** `apps/api/src/brand/assets.ts` (serves the six `apps/api/public/` files from a fixed
  allowlist, with an ETag and a day of caching), `src/brand/css.ts` (`REVIEW_CSS`, `WORDMARK_SVG`),
  `src/review/pages.ts` (the review pages' favicon links and wordmark header).
- Platform email (`packages/platform-mail`) stays plain text — the signature line "Sent by aesa on
  behalf of …" is unchanged; nothing there references the brand assets.

## 9. Derivation and licences

**Reproducing the mark and wordmark.** One Python 3.12 environment covers both scripts:

    cd brand/scripts/derive
    uv venv .venv && uv pip install --python .venv/bin/python fonttools skia-pathops uharfbuzz
    .venv/bin/python derive_mark.py       # writes mark-derived.svg beside this file
    .venv/bin/python derive_wordmark.py   # writes wordmark-derived.svg AND ../../wordmark.svg directly

- `derive_mark.py` — `fontTools` 4.65.0 reads `Fraunces144pt-SemiBold.ttf`'s `æ` (U+00E6) glyph;
  a `BasePen` subclass forwards every drawing command with its x-coordinate passed through the
  piecewise warp (`LO=584, HI=771, DELTA=34`, §2); `skia-pathops` unions the three resulting
  contours; the result is printed as SVG path data (y-down, 1000-unit box) for a reviewer to diff
  against the spec's Appendix A, byte for byte.
- `derive_wordmark.py` — the same font, shaped by `uharfbuzz` for `aesa` (so any GPOS kerning the
  font carries is honoured), each glyph's outline translated to its shaped pen position with
  −10-unit tracking applied between glyphs, the four outlines unioned by `skia-pathops`, and
  written directly to `brand/wordmark.svg` (not just its own derivation record) since the wordmark
  needs no manual warp step the mark does.
- Neither script runs in the CI gate — they are one-off re-derivation tools. `brand/scripts/derive/README.md`
  is the full reference (exact commands, what each script prints, why `.venv/` is git-ignored).
  `mark-derived.svg` / `wordmark-derived.svg` are kept committed so the derivation is visible
  without running Python at all.

**Licences.**

- Fraunces (the mark and wordmark's source, and the bundled display face) and Plus Jakarta Sans
  (the bundled UI face): SIL Open Font License 1.1 — free for commercial use and modification. The
  typefaces themselves stay non-exclusive; the OFL's reserved-name clause (a modified *font file*
  must be renamed) does not apply here because no font file ships modified — the mark and wordmark
  are SVG path outlines, and the bundled app fonts are the unmodified Google Fonts statics.
- Lucide icons: ISC.
- The mark and wordmark artwork, the two lockups and the token system (`tokens.json`, the colour
  and type scale) are ClosingBrackets LLC's own work. Trademark registration of the mark is
  Robert's call and an attorney's review — nothing here constitutes one.
