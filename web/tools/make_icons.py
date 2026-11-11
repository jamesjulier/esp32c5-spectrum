#!/usr/bin/env python3
"""Draw the app icons (public/icon-*.png): a spectrum trace on a dark tile,
filled red at the floor to green at the top, as the board draws it."""
import math, os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "public")
BG = (11, 16, 24)

def hue(t):  # 0 red .. 1 green, as the trace fill
    h = max(0.0, min(1.0, t)) * 120
    return (255, int(h / 60 * 255), 0) if h < 60 else (int((120 - h) / 60 * 255), 255, 0)

def level(x):  # 0..1 across the tile -> 0..1 height: three channel humps and a spike
    def hump(c, w, h): return h * math.exp(-((x - c) / w) ** 2 * 2)
    return max(0.08 + 0.02 * math.sin(x * 90), hump(0.2, 0.09, 0.55), hump(0.5, 0.1, 0.85), hump(0.8, 0.09, 0.45), hump(0.66, 0.01, 0.62))

def tile(size, pad):
    s = 4 * size  # draw large, then shrink, for smooth edges
    im = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(im)
    x0, x1, y0, y1 = pad * s, s - pad * s, s - pad * s, pad * s + 0.08 * s
    for i in range(int(x0), int(x1)):
        top = y0 - level((i - x0) / (x1 - x0)) * (y0 - y1)
        for y in range(int(top), int(y0), 4):
            d.line([(i, y), (i, min(y + 4, y0))], fill=hue((y0 - y) / (y0 - y1) * 1.15))
    grid = (40, 52, 70)
    for k in range(1, 4):
        y = y0 - k * (y0 - y1) / 4
        d.line([(x0, y), (x1, y)], fill=grid, width=max(1, s // 256))
    return im.resize((size, size), Image.LANCZOS)

def rounded(im, r):
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], r, fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0)); out.paste(im, (0, 0), m)
    return out

for n in (192, 512):
    rounded(tile(n, 0.16), n // 5).save(os.path.join(OUT, f"icon-{n}.png"))
tile(512, 0.24).save(os.path.join(OUT, "icon-maskable-512.png"))  # full bleed, safe zone inside
print("icons written")
