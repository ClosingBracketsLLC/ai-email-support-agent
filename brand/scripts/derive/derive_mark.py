"""Derive the aesa mark from Fraunces' æ.

The mark is the U+00E6 glyph of Fraunces 144pt SemiBold (SIL OFL 1.1, see OFL.txt) with its central
column narrowed so the two halves flow together. Nothing is redrawn: a piecewise-linear x-warp is
applied to every on-curve and control point —

    x < LO          : unchanged
    LO <= x <= HI   : compressed linearly (the column shrinks from HI-LO to HI-LO-DELTA)
    x > HI          : shifted left by DELTA

— and the warped contours are unioned. See docs/superpowers/specs/2026-09-10-aesa-brand-design.md §2.1.

Usage (one-off; the committed brand/mark.svg is the source of truth):
    uv venv .venv && uv pip install --python .venv/bin/python fonttools skia-pathops
    .venv/bin/python derive_mark.py            # writes mark-path.txt + mark-derived.svg beside this file

Prints the bounding box and the SVG path data so a reviewer can diff it against the spec's appendix.
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import pathops

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, 'Fraunces144pt-SemiBold.ttf')
LO, HI, DELTA = 584.0, 771.0, 34.0      # font units (2000/em); the column 187 -> 153
H = 1000                                 # the y-down box height the SVG path is expressed in

font = TTFont(FONT)
gs = font.getGlyphSet()
ae = gs[font.getBestCmap()[0xE6]]


def warp_x(x: float) -> float:
    if x < LO:
        return x
    if x <= HI:
        return LO + (x - LO) * (1 - DELTA / (HI - LO))
    return x - DELTA


class WarpPen(BasePen):
    """Forwards a glyph's drawing commands with every point x-warped."""

    def __init__(self, out):
        super().__init__(gs)
        self.out = out

    def _w(self, p):
        return (warp_x(p[0]), p[1])

    def _moveTo(self, p): self.out.moveTo(self._w(p))
    def _lineTo(self, p): self.out.lineTo(self._w(p))
    def _curveToOne(self, p1, p2, p3): self.out.curveTo(self._w(p1), self._w(p2), self._w(p3))
    def _qCurveToOne(self, p1, p2): self.out.qCurveTo(self._w(p1), self._w(p2))
    def _closePath(self): self.out.closePath()
    def _endPath(self): self.out.endPath()


warped = pathops.Path()
ae.draw(WarpPen(warped.getPen()))
mark = pathops.Path()
pathops.union([warped], mark.getPen())           # normalise winding, merge overlaps

bounds = BoundsPen(gs); mark.draw(bounds)
x0, y0, x1, y1 = bounds.bounds
svg_pen = SVGPathPen(gs)
mark.draw(TransformPen(svg_pen, (1, 0, 0, -1, 0, H)))   # font units are y-up; SVG is y-down
path = svg_pen.getCommands()

open(os.path.join(HERE, 'mark-path.txt'), 'w').write(path)
PAD = 40
open(os.path.join(HERE, 'mark-derived.svg'), 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0 - PAD} {H - y1 - PAD} {x1 - x0 + 2 * PAD} {y1 - y0 + 2 * PAD}">'
    f'<path d="{path}" fill="#2563EB"/></svg>\n')
print(f'bbox (font units, y up): {x0:.0f} {y0:.0f} {x1:.0f} {y1:.0f}')
print(f'path chars: {len(path)}')
