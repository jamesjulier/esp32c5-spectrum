/**
 * The analyser's state and maths, with no DOM.
 *
 * Same plan as the board (firmware/components/eng_spectrum_ui/eng_spectrum_ui.c): each band
 * is swept in 32 MHz slices, each slice is centred, the receiver's own spike bridged,
 * folded into DATA_W columns and measured against that slice's own noise floor.
 *
 * As a bench spectrum analyser does (James, 2026-10-20):
 *   Detector  Average = true power averaged (in linear power, not dB) over the captures
 *             in each slot; Peak = the strongest moment.
 *   Rows      each waterfall row covers a fixed time and combines every sweep in it.
 *   Trace     in Average, the live trace is averaged across sweeps too ("video
 *             averaging"). Lines over it, each on or off: Peak hold and the long
 *             Average (James, 2026-10-20: "be able to put a couple on at a time").
 * Measured before choosing this: channel 6 on the bench showed energy in 80–100 % of
 * sweeps at every listen time from 5 to 400 ms, so waterfall stripes were the level
 * changing between sweeps, not the channel going quiet. The C5 captures snapshots with
 * gaps: Average is the average of what was caught.

 */
import { N, type Detector, type SpectrumSource } from "./serial";

export interface Band { name: string; start: number; end: number; ch: [number, number, number, number]; base: number }

/** [first channel, last channel, step, label every]. */
export const BANDS: Band[] = [
  { name: "2.4 GHz",          start: 2402, end: 2482, ch: [1, 13, 1, 5],    base: 2407 },
  { name: "5 GHz ch 36–64",   start: 5170, end: 5330, ch: [36, 64, 4, 8],   base: 5000 },
  { name: "5 GHz ch 100–144", start: 5490, end: 5730, ch: [100, 144, 4, 8], base: 5000 },
  { name: "5 GHz ch 149–165", start: 5735, end: 5855, ch: [149, 165, 4, 8], base: 5000 },
];

export const MHZ_PER_BIN = 80 / N, SEG = 32, DC_MASK = 6;
export const RANGE_DB = 48, PAD_DB = 4, GREEN_DB = 36, FLOOR_CODE = 80, WF_ROWS = 120;
/** Data resolution, independent of the screen: 1000 points across a band. */
export const DATA_W = 1000;
export const MAX_SWEEPS = 3000, LEV = RANGE_DB + PAD_DB, BUSY_DB = 6;
/** Waterfall blocks, MHz (0 = every data point). Each takes the strongest reading inside it. */
export const BLOCKS = [0, 0.5, 1, 2] as const;
export const BLOCK_ROWS = 60;
export const ROWS = [0.25, 0.5, 1] as const;

export interface Lines { peak: boolean; avg: boolean }
export type Block = (typeof BLOCKS)[number];
export type RowSec = (typeof ROWS)[number];

export const toLin = (code: number) => Math.pow(10, code / 20);
export const toCode = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : 0);
/** dB above the noise floor, from a folded code. */
export const dbOf = (code: number) => (code - FLOOR_CODE) / 2;

export interface ChannelStat { ch: number; f: number; pct: number | null }
export interface Readout { mhz: number; channel: number; now: number; peak: number | null; avg: number | null }

/**
 * One slice of a band into `cols`. codes: N power codes in natural FFT order, bin 0 at
 * `centre`. Exported for the tests.
 */
export function foldSegment(band: Band, k: number, centre: number, codes: Uint8Array, cols: Uint8Array, segFloor: number[]) {
  const width = cols.length, sh = new Uint8Array(N);
  for (let i = 0; i < N; i++) sh[i] = codes[(i + N / 2) % N];
  const c = N / 2, lo = sh[c - DC_MASK - 1], hi = sh[c + DC_MASK + 1];
  for (let i = c - DC_MASK; i <= c + DC_MASK; i++) sh[i] = (lo + hi) >> 1;
  const mhzPerCol = (band.end - band.start) / width, touched: number[] = [];
  for (let x = 0; x < width; x++) {
    const off = band.start + (x + 0.5) * mhzPerCol - centre;
    if (off < -SEG / 2 || off >= SEG / 2) continue;
    const b0 = c + Math.floor((off - mhzPerCol / 2) / MHZ_PER_BIN);
    const b1 = Math.max(b0, c + Math.floor((off + mhzPerCol / 2) / MHZ_PER_BIN));
    let m = 0;
    for (let b = b0; b <= b1; b++) if (b >= 0 && b < N && sh[b] > m) m = sh[b];
    cols[x] = m; touched.push(x);
  }
  if (!touched.length) return;
  const sorted = touched.map((x) => cols[x]).sort((a, b) => a - b);
  const now = sorted[Math.floor(sorted.length * 0.15)];
  segFloor[k] = segFloor[k] == null ? now : segFloor[k] * 0.85 + now * 0.15;
  for (const x of touched) cols[x] = Math.max(0, cols[x] - Math.round(segFloor[k]) + FLOOR_CODE);
}

/**
 * Busy share per Wi-Fi channel: of every sample (each sweep × each column within ±10 MHz
 * of the centre), the share more than BUSY_DB above the noise. Sampled, not continuous.
 */
export function channelStats(band: Band, hist: Uint8Array[]): ChannelStat[] {
  const [first, last, step] = band.ch, out: ChannelStat[] = [];
  if (!hist.length) return out;
  const w = hist[0].length;
  for (let ch = first; ch <= last; ch += step) {
    const f = band.base + 5 * ch;
    const x0 = Math.max(0, Math.floor((f - 10 - band.start) / (band.end - band.start) * w));
    const x1 = Math.min(w - 1, Math.ceil((f + 10 - band.start) / (band.end - band.start) * w));
    let busy = 0, all = 0;
    for (const row of hist) for (let x = x0; x <= x1; x++) { all++; if (dbOf(row[x]) >= BUSY_DB) busy++; }
    out.push({ ch, f, pct: all ? busy * 100 / all : null });
  }
  return out;
}

/**
 * The channels the overlay outlines, as the board and Chanalyzer draw them: the three that do
 * not overlap on 2.4 GHz (1, 6, 11), every channel on 5 GHz.
 */
export function overlayChannels(band: Band): number[] {
  const [first, last, step] = band.ch;
  if (band.start < 3000) return [1, 6, 11].filter((c) => c >= first && c <= last);
  const out: number[] = [];
  for (let ch = first; ch <= last; ch += step) out.push(ch);
  return out;
}

/** Zoom width: 40 MHz, a 20 MHz channel and half of each neighbour (as the board does). */
export const ZOOM_MHZ = 40;

/** The nearest Wi-Fi channel to `mhz` in a band. */
export function nearestChannel(band: Band, mhz: number): number {
  const [first, last, step] = band.ch;
  let best = first;
  for (let ch = first; ch <= last; ch += step)
    if (Math.abs(band.base + 5 * ch - mhz) < Math.abs(band.base + 5 * best - mhz)) best = ch;
  return best;
}

export class Analyser {
  bandIndex = 0;
  lines: Lines = { peak: true, avg: false };
  detector: Detector = "avg";
  rowSec: RowSec = 0.5;
  block: Block = 0;
  paused = false;
  source: SpectrumSource | null = null;
  /** Wi-Fi channel outlines over the trace (board: tap the header). */
  overlay = false;
  /** Zoomed to this channel's 40 MHz, or null for the whole band (board: tap the channel strip). */
  zoomChannel: number | null = null;

  // Per band, since it was chosen. `generation` is bumped by anything that throws the
  // data away; a sweep checks it after every capture and quietly starts again.
  cols: Uint8Array | null = null;
  peak: Uint8Array | null = null;
  shown: Uint8Array | null = null;
  fall: Uint8Array[] = [];
  hist: Uint8Array[] = [];
  dens: Uint32Array | null = null;
  started = Date.now();
  private segFloor: number[] = [];
  private avgLin: Float64Array | null = null;
  private bin: { t0: number; sum: Float64Array; max: Uint8Array; n: number } | null = null;
  private longSum: Float64Array | null = null;
  private longN = 0;
  private generation = 0;
  private running = false;
  private listeners = new Set<() => void>();

  /** Called after every sweep and every setting change. */
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { for (const fn of this.listeners) fn(); }

  get band(): Band { return BANDS[this.bandIndex]; }

  reset() {
    this.generation++;
    this.cols = null; this.peak = null; this.shown = null; this.fall = []; this.segFloor = [];
    this.hist = []; this.dens = null; this.started = Date.now();
    this.avgLin = null; this.bin = null; this.longSum = null; this.longN = 0;
    this.changed();
  }
  setBand(i: number) { this.bandIndex = i; this.zoomChannel = null; this.reset(); }
  setOverlay(on: boolean) { this.overlay = on; this.changed(); }
  /** Zoom to a channel of this band, or out with null. A channel not in the band zooms out. */
  setZoom(ch: number | null) {
    const [first, last, step] = this.band.ch;
    this.zoomChannel = ch != null && ch >= first && ch <= last && (ch - first) % step === 0 ? ch : null;
    this.changed();
  }
  /** What is on screen, in MHz: the whole band, or the zoomed 40 MHz kept inside the band. */
  viewMHz(): [number, number] {
    const b = this.band;
    if (this.zoomChannel == null) return [b.start, b.end];
    const f = b.base + 5 * this.zoomChannel, half = ZOOM_MHZ / 2;
    const lo = Math.max(b.start, Math.min(b.end - ZOOM_MHZ, f - half));
    return [lo, Math.min(b.end, lo + ZOOM_MHZ)];
  }
  /** The view as fractions of the band (0–1), for the drawing. */
  viewSpan(): [number, number] {
    const b = this.band, [lo, hi] = this.viewMHz(), w = b.end - b.start;
    return [(lo - b.start) / w, (hi - b.start) / w];
  }
  /** A detector change changes what every figure means, so it starts afresh. */
  setDetector(d: Detector) { this.detector = d; this.reset(); }
  setRows(s: RowSec) { this.rowSec = s; this.fall = []; this.bin = null; this.changed(); }
  setBlock(b: Block) { this.block = b; this.changed(); }
  setLines(l: Lines) { this.lines = l; this.changed(); }
  setPaused(p: boolean) { this.paused = p; this.changed(); }
  setSource(s: SpectrumSource | null) { this.source = s; this.reset(); }

  /** Peak hold: the highest level seen at each frequency, as codes. */
  peakValues(): Uint8Array | null { return this.peak; }
  /** Average: the power mean of every sweep since the band was chosen, as codes. */
  avgValues(): Uint8Array | null {
    if (!this.longSum || !this.longN) return null;
    const n = this.longN;
    return Uint8Array.from(this.longSum, (p) => toCode(p / n));
  }

  channelStats(): ChannelStat[] { return channelStats(this.band, this.hist); }

  /** "Average · 0.5 s rows · 226 sweeps over 55 s". */
  summary(): string {
    const n = this.hist.length, s = Math.round((Date.now() - this.started) / 1000);
    const t = s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
    const how = `${this.detector === "avg" ? "Average" : "Peak"} · ${this.rowSec} s rows`;
    return n ? `${how} · ${n} sweep${n === 1 ? "" : "s"} over ${t}` : `${how} · no sweeps yet`;
  }

  /** What the readout shows at `x` (0–1 across what is on screen, zoomed or not), or null before any data. */
  readoutAt(xView: number): Readout | null {
    const cols = this.shown || this.cols;
    if (!cols) return null;
    const [f0, f1] = this.viewSpan(), x = f0 + Math.max(0, Math.min(1, xView)) * (f1 - f0);
    const i = Math.min(cols.length - 1, Math.floor(x * cols.length));
    const mhz = this.band.start + x * (this.band.end - this.band.start);
    const pk = this.peakValues(), av = this.avgValues();
    return {
      mhz, channel: nearestChannel(this.band, mhz),
      now: Math.max(0, dbOf(cols[i])),
      peak: pk ? Math.max(0, dbOf(pk[i])) : null,
      avg: av ? Math.max(0, dbOf(av[i])) : null,
    };
  }

  /** Sweeps until stopped. Errors go to `onError`, and the source is dropped. */
  async run(onError: (e: unknown) => void, alive: () => boolean) {
    if (this.running) return;
    this.running = true;
    try {
      while (alive()) {
        if (this.paused || !this.source) { await new Promise((r) => setTimeout(r, 200)); continue; }
        try { await this.sweep(); }
        catch (e) {
          const s = this.source;
          this.source = null;
          try { await s?.close?.(); } catch { /* already gone */ }
          onError(e);
        }
      }
    } finally { this.running = false; }
  }

  private async sweep() {
    const band = this.band, w = DATA_W, gen = this.generation, source = this.source!;
    if (!this.cols || this.cols.length !== w) {
      this.cols = new Uint8Array(w); this.peak = null; this.fall = []; this.segFloor = []; this.avgLin = null; this.bin = null;
    }
    const segs = Math.ceil((band.end - band.start) / SEG);
    for (let k = 0; k < segs; k++) {
      const centre = band.start + SEG / 2 + k * SEG;
      const codes = await source.capture(centre, this.detector);
      if (gen !== this.generation || !this.cols) return;   // reset mid-sweep: start again
      foldSegment(band, k, centre, codes, this.cols, this.segFloor);
    }
    const cols = this.cols;
    if (!this.peak) this.peak = new Uint8Array(cols); else for (let x = 0; x < w; x++) this.peak[x] = Math.max(this.peak[x], cols[x]);
    if (!this.longSum) this.longSum = new Float64Array(w);
    for (let x = 0; x < w; x++) this.longSum[x] += toLin(cols[x]);
    this.longN++;

    // Density and Channels: every raw sweep.
    this.hist.push(new Uint8Array(cols)); if (this.hist.length > MAX_SWEEPS) this.hist.shift();
    if (!this.dens || this.dens.length !== w * LEV) this.dens = new Uint32Array(w * LEV);
    for (let x = 0; x < w; x++) this.dens[x * LEV + Math.max(0, Math.min(LEV - 1, Math.floor(dbOf(cols[x]) + PAD_DB)))]++;

    // Trace: in Average, a running power average across sweeps (about 4).
    if (!this.avgLin) this.avgLin = Float64Array.from(cols, toLin);
    else for (let x = 0; x < w; x++) this.avgLin[x] = this.avgLin[x] * 0.75 + toLin(cols[x]) * 0.25;
    this.shown = this.detector === "avg" ? Uint8Array.from(this.avgLin, toCode) : cols;

    // Waterfall: one row per rowSec, combining every sweep in it.
    const now = performance.now();
    if (!this.bin) this.bin = { t0: now, sum: new Float64Array(w), max: new Uint8Array(w), n: 0 };
    const bin = this.bin;
    for (let x = 0; x < w; x++) { bin.sum[x] += toLin(cols[x]); if (cols[x] > bin.max[x]) bin.max[x] = cols[x]; }
    bin.n++;
    if (now - bin.t0 >= this.rowSec * 1000) {
      const row = this.detector === "avg" ? Uint8Array.from(bin.sum, (p) => toCode(p / bin.n)) : bin.max;
      this.fall.unshift(row); if (this.fall.length > WF_ROWS) this.fall.pop();
      this.bin = null;
    }
    this.changed();
  }
}
