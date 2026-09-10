# Deriving the aesa mark

The mark is Fraunces 144pt SemiBold's `æ` with its central column narrowed from 187 to 153 font
units (a seamless x-warp; nothing redrawn). `derive_mark.py` reproduces it from the font file in
this directory and prints the path, which must equal the appendix of
`docs/superpowers/specs/2026-09-10-aesa-brand-design.md` byte for byte.

- `Fraunces144pt-SemiBold.ttf` — from https://github.com/undercasetype/Fraunces (`fonts/ttf/`),
  redistributed here under its licence, `OFL.txt` (SIL Open Font License 1.1). It is a design
  source only: no font file ships in any app or page — the mark and wordmark are SVG outlines.
- `derive_mark.py` — Python 3.12 with `fonttools` and `skia-pathops` (`uv venv .venv &&
  uv pip install --python .venv/bin/python fonttools skia-pathops`, then
  `.venv/bin/python derive_mark.py`). Not part of the CI gate; run it only to re-derive.
- `mark-derived.svg` — the script's output, kept so the derivation is visible without running it.
  The committed brand source of truth is `brand/mark.svg` (created by the brand implementation plan).
