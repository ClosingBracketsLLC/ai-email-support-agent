# @aesa/brand

The brand system as a workspace package: sources, a build script, and the tests that keep the
outputs honest. For the guide — identity, colour, type, icons, do/don't, derivation — see
`brand.md`.

## What this is

Four files are the sources of truth: `tokens.json` (colour, type, radius, spacing, icon-grid and
mark-raster numbers), `mark.svg` (the æ mark, azure, tight ink box), `wordmark.svg` (`aesa` as
outlines, tight ink box), and `icons/*.svg` (the eight product icons). Everything else under
`brand/` — the colourway marks (`mark-ink.svg`, `mark-paper.svg`, `mark-lifted.svg`), the two
lockups, `og-image.svg` — plus everything under `apps/app/assets/`, everything under
`apps/api/public/`, and `packages/contracts/src/brand.ts` is GENERATED from those four files by
`scripts/build.ts`. Never hand-edit a generated file; edit the source and rebuild.

## Rebuild

    pnpm brand:build

then commit the outputs it writes (18 files: see `scripts/build.ts`'s `OUTPUT_PATHS`).
`brand/test/build.test.ts` runs the same build into memory and fails if any committed byte
differs from what the sources produce — that test, not a checklist, is the whole workflow: change
a source, run the build, commit, and the test tells you if you forgot a file. The byte-for-byte
comparison is over PNGs rendered by `@resvg/resvg-js`'s native (N-API) build, which is
platform-specific: rebuild on linux-x64 (CI's platform) or expect CI to report a pixel-level diff
after a rebuild on another architecture.

## Rules in brief

- `aesa` is always lowercase, everywhere in product surfaces (chrome, copy, `aria-label`,
  `<title>`).
- The mark is a filled outline — never a stroke, never rotated, outlined, shadowed or recoloured
  outside its four colourways (azure, ink, paper, lifted blue). Minimum size: 16 px bare, 24 px
  inside a lockup. Clear space around it equals the height of the `a`'s bowl.
- `æsa` (the ligature flourish inside the name) is marketing-only — never in app chrome, email or
  legal text.
- `apps/app` never sets `fontWeight` (one registered family per weight — `theme.ts`'s `font`) and
  never writes a literal colour outside `theme.ts` (whose palettes are token-only).
- Icons are `<path>`-only SVGs on a 24-unit grid, 2-unit stroke, round caps and joins — never a
  glyph from an icon font.

## Re-derive

The mark and wordmark are derived from a Fraunces TTF, not drawn by hand. To reproduce or re-derive
them, see `scripts/derive/README.md`.

## Licences

- Fraunces: SIL Open Font License 1.1.
- Plus Jakarta Sans: SIL Open Font License 1.1.
- The eight product icons: Lucide 1.44.0 shapes with non-`<path>` primitives rewritten as paths,
  ISC (a Feather-derived MIT notice covers a subset) — full text at `brand/icons/LICENSE`.
- The mark and wordmark artwork, the lockups and the token system are ClosingBrackets LLC's work.
