"""Derive the aesa wordmark from Fraunces 144pt SemiBold.

`aesa`, lowercase, shaped by HarfBuzz (so any GPOS kerning the font carries is honoured — it carries
none for these pairs; the advances equal hmtx), letter-spaced -0.5% of the em (-10 units at 2000/em),
each glyph's outline translated to its pen position and the four unioned. Nothing is redrawn. See
docs/superpowers/specs/2026-09-10-aesa-brand-design.md §2.2.

Usage (one-off; the committed brand/wordmark.svg is the source of truth):
    uv venv .venv && uv pip install --python .venv/bin/python fonttools skia-pathops uharfbuzz
    .venv/bin/python derive_wordmark.py     # writes wordmark-derived.svg beside this file AND ../../wordmark.svg

Prints the glyph names, the bounding box and the path length so a reviewer can diff the record.
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import pathops
import uharfbuzz as hb

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, 'Fraunces144pt-SemiBold.ttf')
TEXT = 'aesa'
TRACKING = -10          # -0.5% of the 2000-unit em, applied between glyphs
H = 1000                # the y-down box height the SVG path is expressed in (same as the mark)
INK = '#0F1B33'

font = TTFont(FONT)
gs = font.getGlyphSet()
names = font.getGlyphOrder()

face = hb.Face(hb.Blob.from_file_path(FONT))
hb_font = hb.Font(face)
buf = hb.Buffer()
buf.add_str(TEXT)
buf.guess_segment_properties()
hb.shape(hb_font, buf)

glyphs = []
x = 0.0
for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
    p = pathops.Path()
    gs[names[info.codepoint]].draw(TransformPen(p.getPen(), (1, 0, 0, 1, x + pos.x_offset, pos.y_offset)))
    glyphs.append(p)
    x += pos.x_advance + TRACKING

wordmark = pathops.Path()
pathops.union(glyphs, wordmark.getPen())

bounds = BoundsPen(gs)
wordmark.draw(bounds)
x0, y0, x1, y1 = bounds.bounds
svg_pen = SVGPathPen(gs)
wordmark.draw(TransformPen(svg_pen, (1, 0, 0, -1, 0, H)))   # font units are y-up; SVG is y-down
path = svg_pen.getCommands()

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {H - y1:.0f} {x1 - x0:.0f} {y1 - y0:.0f}">'
       f'<path fill="{INK}" d="{path}"/></svg>\n')
open(os.path.join(HERE, 'wordmark-derived.svg'), 'w').write(svg)
open(os.path.join(HERE, '..', '..', 'wordmark.svg'), 'w').write(svg)
print(f'glyphs: {[names[i.codepoint] for i in buf.glyph_infos]}')
print(f'bbox (font units, y up): {x0:.0f} {y0:.0f} {x1:.0f} {y1:.0f}')
print(f'path chars: {len(path)}')
