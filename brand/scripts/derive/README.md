# Deriving the aesa mark and wordmark

The mark is Fraunces 144pt SemiBold's `æ` with its central column narrowed from 187 to 153 font
units (a seamless x-warp; nothing redrawn). `derive_mark.py` reproduces it from the font file in
this directory and prints the path, which must equal the appendix of
`docs/superpowers/specs/2026-09-10-aesa-brand-design.md` byte for byte.

The wordmark is `aesa`, lowercase, shaped by HarfBuzz (so any GPOS kerning the font carries is
honoured), letter-spaced −0.5% of the em (−10 units at 2000/em), each glyph's outline translated to
its shaped pen position and the four unioned. `derive_wordmark.py` reproduces it the same way.

- `Fraunces144pt-SemiBold.ttf` — from https://github.com/undercasetype/Fraunces (`fonts/ttf/`),
  redistributed here under its licence, `OFL.txt` (SIL Open Font License 1.1). It is a design
  source only: no font file ships in any app or page — the mark and wordmark are SVG outlines.
- `derive_mark.py` — Python 3.12 with `fonttools` and `skia-pathops`, then
  `.venv/bin/python derive_mark.py`. Not part of the CI gate; run it only to re-derive.
- `derive_wordmark.py` — the same Python 3.12 environment plus `uharfbuzz` for the shaping step,
  then `.venv/bin/python derive_wordmark.py`. Also not part of the CI gate. The single `uv` line
  below now installs all three packages so one venv covers both scripts:
  `uv venv .venv && uv pip install --python .venv/bin/python fonttools skia-pathops uharfbuzz`.
  `.venv/` is git-ignored.
- `mark-derived.svg` / `wordmark-derived.svg` — each script's output, kept so the derivation is
  visible without running it. The committed brand sources of truth are `brand/mark.svg` and
  `brand/wordmark.svg` (created by the brand implementation plan).

The eight icons in `brand/icons/` are Lucide 1.44.0 (ISC) shapes with primitives rewritten as
`<path>`s; not derived here.
