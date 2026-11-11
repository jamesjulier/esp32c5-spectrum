/**
 * Drawing. Plain canvas, because it redraws ~5 times a second
 * at full resolution.
 *
 * Every colour is a CSS custom property (--spec-*, in styles.css), read at draw time; the
 * plot surface is --plot-bg. The defaults are James's
 * (2026-10-19/20): trace fill red at the floor to green at +36 dB, waterfall dark blue →
 * cyan → yellow → red, grey and violet ink.
 */
import {
  Analyser, BANDS, BLOCK_ROWS, BUSY_DB, GREEN_DB, LEV, PAD_DB, RANGE_DB, WF_ROWS,
  dbOf, nearestChannel, overlayChannels, toCode, toLin,
} from "./analyser";

/** A colour ramp: "position colour" stops, 0 to 1, hex colours (the --spec-* tokens). */
type Stop = [number, [number, number, number]];

/** Today's colours, used when a theme sets none (and in tests). Same values as styles.css. */
const DEFAULTS: Record<string, string> = {
  fill: "0 #FF0000, 0.1667 #FF5500, 0.3333 #FFAA00, 0.5 #FFFF00, 0.6667 #AAFF00, 0.8333 #55FF00, 1 #00FF00",
  heat: "0 #000000, 0.0588 #000000, 0.0627 #000050, 0.3725 #009E9F, 0.3765 #00C8A0, 0.6863 #EDC802, 0.6902 #FFC800, 1 #FF2A00",
  dens: "0 #00005A, 0.25 #008CFF, 0.5 #00DC5A, 0.75 #FFE600, 1 #FF2800",
  edge: "rgba(255, 255, 200, 0.55)", peak: "#9CA3AF", avg: "#C4B5FD", grid: "#1F2937", label: "#9CA3AF",
  chip: "rgba(3, 7, 18, 0.7)", tick: "#3B82F6", cursor: "rgba(255, 255, 255, 0.6)", "bar-text": "#F9FAFB",
  "busy-ok": "#10B981", "busy-warn": "#FBBF24", "busy-bad": "#EF4444",
  // Channel overlay outlines, in turn (Chanalyzer colours each channel's mask).
  overlay: "#60A5FA #F472B6 #34D399 #FBBF24 #A78BFA #F87171",
};

function hex(c: string): [number, number, number] {
  const h = c.trim().replace("#", "");
  const f = h.length === 3 ? h.split("").map((x) => x + x).join("") : h.slice(0, 6);
  const n = parseInt(f, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function parseRamp(text: string): Stop[] {
  const stops = text.split(",").map((part) => part.trim().split(/\s+/)).filter((x) => x.length === 2)
    .map(([pos, col]) => [Number(pos), hex(col)] as Stop).filter(([pos]) => Number.isFinite(pos));
  return stops.length >= 2 ? stops.sort((a, b) => a[0] - b[0]) : parseRamp(DEFAULTS.fill);
}
/** 256 entries of r, g, b along a ramp. */
function lut(stops: Stop[]): Uint8Array {
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < stops.length - 1 && t > stops[k][0]) k++;
    const [a, c0] = stops[k - 1], [b, c1] = stops[k], f = b > a ? Math.max(0, Math.min(1, (t - a) / (b - a))) : 1;
    for (let j = 0; j < 3; j++) out[i * 3 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
  }
  return out;
}

export interface Palette {
  fill: Stop[];
  heat(db: number): [number, number, number];
  dens(p: number): [number, number, number];
  edge: string; peak: string; avg: string; grid: string; label: string; chip: string;
  tick: string; cursor: string; barText: string; busyOk: string; busyWarn: string; busyBad: string;
  overlay: string[];
}

let cached: { key: string; p: Palette } | null = null;
/** The theme's spectrum colours, read from CSS at draw time. */
export function palette(el?: Element | null): Palette {
  const css = el && typeof getComputedStyle !== "undefined" ? getComputedStyle(el) : null;
  const v = (k: string) => (css?.getPropertyValue(`--spec-${k}`).trim() || DEFAULTS[k]);
  const keys = Object.keys(DEFAULTS), key = keys.map(v).join("|");
  if (cached?.key === key) return cached.p;
  const heatLut = lut(parseRamp(v("heat"))), densLut = lut(parseRamp(v("dens")));
  const at = (t: Uint8Array, i: number): [number, number, number] => [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];
  const p: Palette = {
    fill: parseRamp(v("fill")),
    heat: (db) => at(heatLut, Math.floor(Math.max(0, Math.min(255, db * 255 / GREEN_DB)))),
    // Density: how often a level is reached, on a log scale so 1 % of sweeps still shows.
    dens: (pr) => (pr <= 0 ? [0, 0, 0] : at(densLut, Math.round(Math.min(1, Math.log10(1 + pr * 99) / 2) * 255))),
    edge: v("edge"), peak: v("peak"), avg: v("avg"), grid: v("grid"), label: v("label"), chip: v("chip"),
    tick: v("tick"), cursor: v("cursor"), barText: v("bar-text"),
    busyOk: v("busy-ok"), busyWarn: v("busy-warn"), busyBad: v("busy-bad"),
    overlay: v("overlay").split(/[\s,]+/).filter(Boolean),
  };
  cached = { key, p };
  return p;
}

export const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(",")})`;
/** CSS gradient for the colour-scale legend under the chart, in the theme's colours. */
export function scaleGradient(kind: "level" | "density", el?: Element | null): string {
  const p = palette(el ?? (typeof document !== "undefined" ? document.documentElement : null));
  const stops = kind === "level"
    ? [0, 6, 12, 18, 24, 30, 36].map((db) => rgb(p.heat(db)))
    : [0.01, 0.03, 0.1, 0.2, 0.4, 0.7, 1].map((x) => rgb(p.dens(x)));
  return `linear-gradient(90deg, ${stops.join(",")})`;
}

interface Ctx { g: CanvasRenderingContext2D; w: number; h: number; d: number; font: string; p: Palette }

function begin(cv: HTMLCanvasElement): Ctx {
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext("2d")!;
  const css = getComputedStyle(cv);
  g.fillStyle = css.getPropertyValue("--plot-bg").trim() || "black";
  g.fillRect(0, 0, w, h);
  return { g, w, h, d, font: css.fontFamily || "sans-serif", p: palette(cv) };
}

const yOf = (db: number, h: number) => h - 1 - Math.max(0, Math.min(1, (db + PAD_DB) / (RANGE_DB + PAD_DB))) * (h - 1);

function dashed(c: Ctx, y: number) {
  const { g, w, d } = c;
  g.strokeStyle = c.p.grid; g.setLineDash([2 * d, 4 * d]); g.lineWidth = d;
  g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.setLineDash([]);
}
/** A dB label on a small chip, drawn last so a tall signal never hides the scale. */
function chipLabel(c: Ctx, text: string, y: number) {
  const { g, d } = c;
  g.font = `${12 * d}px ${c.font}`; g.textBaseline = "bottom"; g.textAlign = "left";
  g.fillStyle = c.p.chip; g.fillRect(2 * d, y - 16 * d, g.measureText(text).width + 8 * d, 14 * d);
  g.fillStyle = c.p.label; g.fillText(text, 6 * d, y - 4 * d);
}
function cursor(c: Ctx, x: number | null) {
  if (x == null) return;
  const { g, w, h, d } = c, px = Math.round(x * w) + 0.5;
  g.strokeStyle = c.p.cursor; g.lineWidth = d;
  g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
}
/** The data under screen column `x` of `w`, within the view [f0, f1] (fractions of the band). */
const at = (arr: Uint8Array, x: number, w: number, f0 = 0, f1 = 1) =>
  arr[Math.min(arr.length - 1, Math.floor((f0 + (x / w) * (f1 - f0)) * arr.length))];

/**
 * Wi-Fi channel outlines over the trace, as the board and Chanalyzer draw them: each
 * channel's 20 MHz as a coloured tent with its number at the top.
 */
function overlay(c: Ctx, a: Analyser) {
  const { g, w, h, d } = c, band = a.band, [lo, hi] = a.viewMHz(), X = (f: number) => ((f - lo) / (hi - lo)) * w;
  const top = yOf(GREEN_DB, h), floor = yOf(0, h);
  overlayChannels(band).forEach((ch, i) => {
    const f = band.base + 5 * ch;
    if (f + 11 < lo || f - 11 > hi) return;
    const col = c.p.overlay[i % c.p.overlay.length] || c.p.tick;
    g.beginPath();
    g.moveTo(X(f - 11), floor); g.lineTo(X(f - 9), top); g.lineTo(X(f + 9), top); g.lineTo(X(f + 11), floor);
    g.strokeStyle = col; g.lineWidth = 1.5 * d; g.stroke();
    g.font = `600 ${12 * d}px ${c.font}`; g.fillStyle = col; g.textAlign = "center"; g.textBaseline = "bottom";
    g.fillText(String(ch), X(f), top - 3 * d);
  });
}

export function drawTrace(cv: HTMLCanvasElement, a: Analyser, cursorX: number | null) {
  const c = begin(cv), { g, w, h, d } = c, [f0, f1] = a.viewSpan();
  for (let db = 0; db <= RANGE_DB; db += 12) dashed(c, Math.round(yOf(db, h)) + 0.5);
  const labels = () => { for (let db = 12; db <= RANGE_DB - 12; db += 12) chipLabel(c, `+${db} dB`, Math.round(yOf(db, h))); };
  const src = a.shown || a.cols;
  if (!src) { labels(); return; }
  const grad = g.createLinearGradient(0, yOf(0, h), 0, yOf(GREEN_DB, h));
  for (const [pos, col] of c.p.fill) grad.addColorStop(Math.max(0, Math.min(1, pos)), rgb(col));
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x < w; x++) g.lineTo(x, yOf(dbOf(at(src, x, w, f0, f1)), h));
  g.lineTo(w, h); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath();
  for (let x = 0; x < w; x++) { const y = yOf(dbOf(at(src, x, w, f0, f1)), h); if (x) g.lineTo(x, y); else g.moveTo(x, y); }
  g.strokeStyle = c.p.edge; g.lineWidth = 1.2 * d; g.stroke();
  // The lines that are on: Average under Peak hold, which is always at or above it.
  const lines: [Uint8Array | null, string][] = [
    [a.lines.avg ? a.avgValues() : null, c.p.avg],
    [a.lines.peak ? a.peakValues() : null, c.p.peak],
  ];
  for (const [line, colour] of lines) {
    if (!line) continue;
    g.beginPath();
    for (let x = 0; x < w; x++) { const y = yOf(dbOf(at(line, x, w, f0, f1)), h); if (x) g.lineTo(x, y); else g.moveTo(x, y); }
    g.strokeStyle = colour; g.lineWidth = 1.6 * d; g.stroke();
  }
  if (a.overlay) overlay(c, a);
  labels();
  cursor(c, cursorX);
}

const scratch: { fine?: HTMLCanvasElement; block?: HTMLCanvasElement; dens?: HTMLCanvasElement } = {};
function offscreen(key: keyof typeof scratch, w: number, h: number) {
  const off = scratch[key] || (scratch[key] = document.createElement("canvas"));
  off.width = w; off.height = h;
  const og = off.getContext("2d")!;
  return { off, og, img: og.createImageData(w, h) };
}

/**
 * Waterfall, newest at the top. Rows fill downwards as they arrive: an empty part is
 * time not yet measured (data-display rule 3), never padded.
 */
export function drawFall(cv: HTMLCanvasElement, a: Analyser, cursorX: number | null) {
  const c = begin(cv), { g, w, h } = c, [f0, f1] = a.viewSpan();
  const fall = a.fall;
  if (!a.block) {
    // Drawn at the data's own size and scaled up crisp (per screen pixel it took 32 ms).
    const rows = fall.length;
    if (rows) {
      const cw = fall[0].length, { off, og, img } = offscreen("fine", cw, rows);
      for (let r = 0; r < rows; r++) {
        const row = fall[r];
        for (let x = 0; x < cw; x++) {
          const [R, G, B] = c.p.heat(dbOf(row[x])), p = (r * cw + x) * 4;
          img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
        }
      }
      og.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(off, f0 * cw, 0, (f1 - f0) * cw, rows, 0, 0, w, h * rows / WF_ROWS);
    }
  } else {
    const band = a.band, nx = Math.max(1, Math.round((band.end - band.start) / a.block));
    const rows = Math.min(fall.length, BLOCK_ROWS);
    if (rows) {
      // One pixel per block, scaled up with smoothing: the blend between blocks.
      const { off, og, img } = offscreen("block", nx, rows);
      for (let r = 0; r < rows; r++) {
        const row = fall[r], per = row.length / nx;
        for (let k = 0; k < nx; k++) {
          let m = 0, sum = 0, n = 0;
          for (let i = Math.floor(k * per), e = Math.floor((k + 1) * per); i < e; i++) {
            if (row[i] > m) m = row[i];
            sum += toLin(row[i]); n++;
          }
          if (a.detector === "avg" && n) m = toCode(sum / n);
          const [R, G, B] = c.p.heat(dbOf(m)), p = (r * nx + k) * 4;
          img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
        }
      }
      og.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
      g.drawImage(off, f0 * nx, 0, (f1 - f0) * nx, rows, 0, 0, w, h * rows / BLOCK_ROWS);
    }
  }
  // Say what the empty part is while history fills, so it does not read as a fault.
  const cap = a.block ? BLOCK_ROWS : WF_ROWS, filled = Math.min(fall.length, cap);
  if (filled < cap) {
    const d = c.d, y = h * filled / cap;
    if (h - y > 30 * d) {
      g.font = `${12 * d}px ${c.font}`; g.fillStyle = c.p.label; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(`History fills over ${Math.round(cap * a.rowSec)} s`, w / 2, y + (h - y) / 2);
    }
  }
  cursor(c, cursorX);
}

/**
 * Wi-Fi channel ticks and numbers under the chart, across `view` (MHz; the whole band if
 * none). Zoomed in, every channel in view is numbered.
 */
export function drawMarks(cv: HTMLCanvasElement, bandIndex: number, view?: [number, number]) {
  const c = begin(cv), { g, w, d } = c, band = BANDS[bandIndex];
  const [lo, hi] = view ?? [band.start, band.end], zoomed = hi - lo < band.end - band.start;
  const [first, last, step, every] = band.ch;
  g.font = `${12 * d}px ${c.font}`; g.textAlign = "center"; g.textBaseline = "top";
  for (let ch = first, i = 0; ch <= last; ch += step, i++) {
    const x = ((band.base + 5 * ch) - lo) / (hi - lo) * w;
    if (x < 0 || x > w) continue;
    g.fillStyle = c.p.tick; g.fillRect(Math.round(x), 0, d, 5 * d);
    // A number half off the edge reads as another number ("1" of "10"): leave it out.
    const fits = x >= 8 * d && x <= w - 8 * d;
    if (fits && (zoomed || i % Math.max(1, every / step) === 0)) { g.fillStyle = c.p.label; g.fillText(String(ch), x, 8 * d); }
  }
}

/** The channel nearest screen fraction `x` across the view (for zoom by clicking a number). */
export function channelAt(a: Analyser, x: number): number {
  const [lo, hi] = a.viewMHz();
  return nearestChannel(a.band, lo + x * (hi - lo));
}

export function drawDensity(cv: HTMLCanvasElement, a: Analyser, cursorX: number | null) {
  const c = begin(cv), { g, w, h } = c, [f0, f1] = a.viewSpan();
  const n = a.hist.length, dens = a.dens, cw = dens ? dens.length / LEV : 0;
  if (dens && n) {
    const { off, og, img } = offscreen("dens", cw, LEV);
    for (let bin = 0; bin < LEV; bin++) {
      const y = LEV - 1 - bin;
      for (let x = 0; x < cw; x++) {
        const [R, G, B] = c.p.dens(dens[x * LEV + bin] / n), p = (y * cw + x) * 4;
        img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
      }
    }
    og.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(off, f0 * cw, 0, (f1 - f0) * cw, LEV, 0, 0, w, h);
  }
  for (let db = 12; db <= RANGE_DB - 12; db += 12) {
    const y = Math.round(h - (db + PAD_DB) / LEV * h);
    dashed(c, y + 0.5);
    chipLabel(c, `+${db} dB`, y);
  }
  cursor(c, cursorX);
}

export function drawChannels(cv: HTMLCanvasElement, a: Analyser) {
  const c = begin(cv), { g, w, h, d } = c;
  const stats = a.channelStats(), top = 34 * d, base = h - 34 * d, gap = 6 * d;
  for (const p of [25, 50, 75, 100]) {
    const y = Math.round(base - (base - top) * p / 100) + 0.5;
    dashed(c, y);
    g.font = `${12 * d}px ${c.font}`; g.fillStyle = c.p.label; g.textAlign = "left"; g.textBaseline = "bottom";
    g.fillText(`${p}%`, 4 * d, y - 2 * d);
  }
  if (!stats.length) return;
  const bw = (w - 40 * d) / stats.length;
  stats.forEach((s, i) => {
    const x = 40 * d + i * bw, bh = s.pct == null ? 0 : (base - top) * s.pct / 100;
    // The figure is printed on every bar: colour never carries meaning alone.
    g.fillStyle = s.pct == null ? c.p.grid : s.pct >= 50 ? c.p.busyBad : s.pct >= 20 ? c.p.busyWarn : c.p.busyOk;
    g.fillRect(x + gap / 2, base - bh, bw - gap, bh);
    g.textAlign = "center"; g.fillStyle = c.p.barText; g.textBaseline = "bottom";
    g.font = `600 ${13 * d}px ${c.font}`;
    g.fillText(s.pct == null ? "—" : `${Math.round(s.pct)}%`, x + bw / 2, base - bh - 4 * d);
    g.font = `${12 * d}px ${c.font}`; g.fillStyle = c.p.label; g.textBaseline = "top";
    g.fillText(String(s.ch), x + bw / 2, base + 8 * d);
  });
}

/** One picture of what is on screen, with the band, settings and time printed on it. */
export function savePicture(parts: HTMLCanvasElement[], title: string) {
  const shown = parts.filter((p) => p.width > 1 && p.offsetParent !== null);
  if (!shown.length) return;
  const w = shown[0].width, out = document.createElement("canvas");
  out.width = w; out.height = shown.reduce((s, p) => s + p.height, 0) + 40;
  const g = out.getContext("2d")!;
  g.fillStyle = getComputedStyle(shown[0]).getPropertyValue("--plot-bg").trim() || "black";
  g.fillRect(0, 0, w, out.height);
  g.fillStyle = palette(shown[0]).barText; g.font = `bold 22px ${getComputedStyle(shown[0]).fontFamily || "sans-serif"}`;
  g.fillText(title, 8, 28);
  let y = 40;
  for (const p of shown) { g.drawImage(p, 0, y); y += p.height; }
  const link = document.createElement("a");
  link.download = `spectrum-${Date.now()}.png`; link.href = out.toDataURL("image/png"); link.click();
}

export const BUSY_TEXT = `Share of samples more than ${BUSY_DB} dB above the noise floor: green under 20 %, amber to 50 %, red above. Sampled, so a guide for comparing channels.`;

