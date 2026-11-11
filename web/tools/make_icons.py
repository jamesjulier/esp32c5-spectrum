#!/usr/bin/env python3
"""Render the app's PNG icons from public/icon.svg, the one source of the logo.

    python3 tools/make_icons.py [path-to-chrome]

Uses headless Chrome (or Chromium) to draw the SVG, so the PNGs match it exactly:
  icon-192.png, icon-512.png   the rounded tile, transparent corners
  icon-maskable-512.png        full-bleed graphite, the tile's contents inside the
                               safe zone, for launchers that cut their own shape
"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "..", "public")
CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "chromium", "chromium-browser",
]
chrome = sys.argv[1] if len(sys.argv) > 1 else next(
    (c for c in CANDIDATES if os.path.exists(c) or shutil.which(c)), None)
if not chrome:
    sys.exit("Chrome or Chromium is needed: pass its path as the first argument")

svg = open(os.path.join(PUB, "icon.svg")).read()

def render(name, size, maskable=False):
    # Maskable: graphite to every edge, the mark scaled to 76% so a circle crop keeps it whole.
    inner = (f'<div style="width:{size}px;height:{size}px;background:#0f1216;display:grid;place-items:center">'
             f'<div style="width:{size*0.76}px;height:{size*0.76}px">{svg}</div></div>') if maskable \
        else f'<div style="width:{size}px;height:{size}px">{svg}</div>'
    page = f'<!doctype html><style>html,body{{margin:0;background:transparent}}svg{{width:100%;height:100%;display:block}}</style>{inner}'
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "icon.html")
        open(src, "w").write(page)
        out = os.path.abspath(os.path.join(PUB, name))
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--default-background-color=00000000", f"--window-size={size},{size}",
                        f"--screenshot={out}", f"file://{src}"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(name)

render("icon-192.png", 192)
render("icon-512.png", 512)
render("icon-maskable-512.png", 512, maskable=True)
