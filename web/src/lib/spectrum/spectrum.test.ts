import { describe, expect, it } from "vitest";
import { N, SerialSource, indexOfMagic, notAnswering, parseId, type SpectrumSource } from "./serial";
import { palette, parseRamp } from "./draw";
import { Analyser, BANDS, DATA_W, FLOOR_CODE, channelStats, dbOf, foldSegment, nearestChannel, toCode, toLin } from "./analyser";

describe("a board that does not answer", () => {
  it("names a board in its other app, which needs switching, not a replug", () => {
    expect(notAnswering(["I (2061) main_task: Returned from app_main()", "I (3113) eng.ui: stack free 10956 bytes"]))
      .toMatch(/^The board is running its other app\. Switch it to the spectrum analyser/);
  });
  it("otherwise quotes what it sent, or says nothing came", () => {
    expect(notAnswering(["garbage"])).toBe('The board is not answering (it sent: "garbage"). Unplug it, plug it back in and try again.');
    expect(notAnswering([])).toMatch(/nothing was received/);
  });
});

describe("ID? reply", () => {
  it("reads the MAC and board name", () => {
    expect(parseId("ID 02:00:00:C5:00:01 Waveshare ESP32-C5-LCD-1.47")).toEqual({ mac: "02:00:00:C5:00:01", board: "Waveshare ESP32-C5-LCD-1.47" });
  });
  it("ignores anything else (stock ESP-SDR)", () => {
    expect(parseId("ERR unknown")).toBeNull();
    expect(parseId(null)).toBeNull();
    expect(parseId("ID 02:00:00:C5:FF:0E")).toBeNull();
  });
});

describe("frame finding", () => {
  it("finds SPC1 anywhere in the buffer", () => {
    const b = new TextEncoder().encode("xxSPECEND\nSPC1....");
    expect(indexOfMagic(b)).toBe(10);
    expect(indexOfMagic(new TextEncoder().encode("SPC"))).toBe(-1);
  });
});

/** A pretend port that answers like a board: ours (with ID?), stock (refuses ID?), or silent. */
function fakePort(kind: "ours" | "stock" | "silent") {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const say = (t: string) => ctl.enqueue(enc.encode(t + "\n"));
  return {
    readable: new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }),
    writable: new WritableStream<Uint8Array>({ write(chunk) {
      for (const l of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
        if (l.startsWith("SYNC")) say(l);
        else if (l === "INFO") say("C5SDR 6 burst 16380");
        else if (l === "ID?") { if (kind === "ours") say("ID 02:00:00:C5:00:01 Waveshare ESP32-C5-LCD-1.47"); else if (kind === "stock") say("ERR unknown"); }
        else say("OK");
      }
    } }),
    open: async () => {}, close: async () => {}, setSignals: async () => {}, getInfo: () => ({}),
  };
}

describe("connecting", () => {
  it("names one of our boards", async () => {
    const s = new SerialSource(fakePort("ours"));
    expect(await s.open()).toBe("C5SDR 6 burst 16380");
    expect(s.board).toBe("Waveshare ESP32-C5-LCD-1.47");
    expect(s.mac).toBe("02:00:00:C5:00:01");
  });
  it.each(["stock", "silent"] as const)("falls back to the family name for a %s board", async (kind) => {
    const s = new SerialSource(fakePort(kind));
    await s.open();
    expect(s.family).toBe("C5SDR");
    expect(s.board).toBeNull();
  });
});

describe("the maths", () => {
  const band = BANDS[0];

  it("folds a slice against its own noise floor", () => {
    const codes = new Uint8Array(N).fill(100), cols = new Uint8Array(DATA_W), floor: number[] = [];
    foldSegment(band, 0, band.start + 16, codes, cols, floor);
    // A flat slice sits exactly on the floor: 0 dB.
    const touched = [...cols].filter((c) => c > 0);
    expect(touched.length).toBeGreaterThan(300);
    expect(new Set(touched)).toEqual(new Set([FLOOR_CODE]));
  });

  it("names the nearest channel", () => {
    expect(nearestChannel(band, 2437)).toBe(6);
    expect(nearestChannel(band, 2439)).toBe(6);
    expect(nearestChannel(band, 2441)).toBe(7);
  });

  it("counts a channel as busy only above 6 dB", () => {
    const quiet = new Uint8Array(DATA_W).fill(FLOOR_CODE);
    const busy = new Uint8Array(DATA_W).fill(FLOOR_CODE + 2 * 10);     // +10 dB everywhere
    const stats = channelStats(band, [quiet, busy]);
    expect(stats).toHaveLength(13);
    expect(stats.every((s) => Math.abs((s.pct ?? 0) - 50) < 1e-9)).toBe(true);
    expect(channelStats(band, [])).toEqual([]);
  });

  it("averages power, not decibels", () => {
    // +0 and +20 code: the power mean is ~14 code, the dB mean would be 10.
    expect(Math.round(toCode((toLin(0) + toLin(20)) / 2))).toBe(15);
    expect(dbOf(FLOOR_CODE + 24)).toBe(12);
  });
});

describe("a sweep", () => {
  it("fills the trace, peak hold, the Average line and the figures", async () => {
    const a = new Analyser();
    const source: SpectrumSource = { capture: async () => Uint8Array.from({ length: N }, (_, i) => (i % 64 === 0 ? 160 : 100)) };
    a.setSource(source);
    let sweeps = 0;
    a.subscribe(() => { if (a.hist.length > sweeps) sweeps = a.hist.length; });
    const done = a.run(() => {}, () => sweeps < 3);
    await done;
    expect(a.hist.length).toBeGreaterThanOrEqual(3);
    expect(a.cols).not.toBeNull();
    expect(a.avgValues()).toHaveLength(DATA_W);
    expect(a.peakValues()).toHaveLength(DATA_W);
    // Peak hold is never below the Average line.
    const pk = a.peakValues()!, av = a.avgValues()!;
    expect(pk.every((v, i) => v >= av[i])).toBe(true);
    a.setLines({ peak: true, avg: true });
    const both = a.readoutAt(0.5)!;
    expect(both.peak).not.toBeNull();
    expect(both.avg).not.toBeNull();
    expect(a.summary()).toMatch(/^Average · 0\.5 s rows · \d+ sweeps over \d+ s$/);
    const r = a.readoutAt(0.5)!;
    expect(r.channel).toBe(nearestChannel(BANDS[0], r.mhz));
  });
});

describe("theme colours", () => {
  // The heat and density colours before they became theme tokens (2026-10-20).
  const oldHeat = (db: number) => {
    const v = Math.max(0, Math.min(255, db * 255 / 36));
    if (v < 16) return [0, 0, 0];
    if (v < 96) return [0, (v - 16) * 2, 80 + (v - 16)];
    if (v < 176) return [(v - 96) * 3, 200, 160 - (v - 96) * 2];
    return [255, 200 - (v - 176) * 2, 0];
  };
  const oldDens = (p: number) => {
    if (p <= 0) return [0, 0, 0];
    const t = Math.min(1, Math.log10(1 + p * 99) / 2);
    const st = [[0, 0, 0, 90], [0.25, 0, 140, 255], [0.5, 0, 220, 90], [0.75, 255, 230, 0], [1, 255, 40, 0]];
    for (let i = 1; i < st.length; i++) if (t <= st[i][0]) {
      const [a, r0, g0, b0] = st[i - 1], [b, r1, g1, b1] = st[i], f = (t - a) / (b - a);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
    return [255, 40, 0];
  };
  const close = (a: number[], b: number[], tol: number) => a.every((x, i) => Math.abs(x - b[i]) <= tol);

  it("the default ramps are today's colours", () => {
    const p = palette(null);
    for (let db = -2; db <= 40; db += 0.25) expect(close(p.heat(db), oldHeat(db), 4), `heat ${db} dB`).toBe(true);
    for (const x of [0, 0.001, 0.01, 0.05, 0.1, 0.3, 0.6, 1]) expect(close(p.dens(x), oldDens(x), 4), `density ${x}`).toBe(true);
  });

  it("reads a ramp from a token", () => {
    expect(parseRamp("0 #000000, 1 #FFFFFF")).toEqual([[0, [0, 0, 0]], [1, [255, 255, 255]]]);
    expect(parseRamp("nonsense").length).toBeGreaterThan(2);           // falls back, never empty
  });
});

describe("zoom and overlay (the board's touch features, 2026-10-23)", () => {
  it("outlines 1, 6 and 11 on 2.4 GHz and every channel on 5 GHz", async () => {
    const { BANDS, overlayChannels } = await import("./analyser");
    expect(overlayChannels(BANDS[0])).toEqual([1, 6, 11]);
    expect(overlayChannels(BANDS[1])).toEqual([36, 40, 44, 48, 52, 56, 60, 64]);
  });
  it("zooms 40 MHz around a channel, kept inside the band, and out again", async () => {
    const { Analyser } = await import("./analyser");
    const a = new Analyser();
    expect(a.viewMHz()).toEqual([2402, 2482]);
    a.setZoom(6);
    expect(a.viewMHz()).toEqual([2417, 2457]);           // 2437 ± 20
    a.setZoom(1);
    expect(a.viewMHz()).toEqual([2402, 2442]);           // held inside the band
    const [f0, f1] = a.viewSpan();
    expect(f0).toBe(0); expect(f1).toBeCloseTo(0.5);
    a.setZoom(7.5); expect(a.zoomChannel).toBeNull();     // not a channel: out
    a.setZoom(6); a.setBand(1); expect(a.zoomChannel).toBeNull(); // a new band starts whole
  });
  it("reads out the frequency under the pointer, zoomed or not", async () => {
    const { Analyser } = await import("./analyser");
    const a = new Analyser();
    a.cols = new Uint8Array(1000).fill(100);
    expect(a.readoutAt(0.5)!.mhz).toBeCloseTo(2442);
    a.setZoom(6);
    expect(a.readoutAt(0.5)!.mhz).toBeCloseTo(2437);
    expect(a.readoutAt(0.5)!.channel).toBe(6);
  });
});
