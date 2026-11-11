/**
 * Talking to an ESP32-C5 running ESP-SDR, over Web Serial.
 *
 * Commands are ESP-SDR's (ESP-SDR docs/protocol.md): SYNC, INFO, FREQ, SPEC, and our ID?
 * (firmware/patches in this repository). Spectra arrive as SPC1 frames
 * (ESP-SDR docs/spectrum.md): 28-byte header, N power codes (2 × dB), CRC32.
 *
 * UI-free: the page shows `onStatus` messages and errors however it likes.
 */
import type { SerialPortLike } from "../flasher";

/** FFT points per capture, as the patch builds it (MAX_FFT 1024). */
export const N = 1024;

export type Detector = "avg" | "peak";

/** Something that can return one spectrum (N codes, bin 0 at `centre` MHz). */
export interface SpectrumSource {
  capture(centre: number, det: Detector): Promise<Uint8Array>;
  close?(): Promise<void>;
}

/** A failure the source cannot recover from by re-syncing: the page must reconnect. */
export class FatalLinkError extends Error {
  fatal = true;
}

/** The first "SPC1" in a byte buffer, or -1. */
export function indexOfMagic(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 83 && b[i + 1] === 80 && b[i + 2] === 67 && b[i + 3] === 49) return i;
  return -1;
}

/**
 * What to tell the person when the board does not answer, from what it did send. A 2.8"
 * board running a companion app in its other slot (one that logs as "eng.ui", "eng.link"…)
 * is the right board in the wrong app, and unplugging it would not help (James, 2026-10-23).
 */
export function notAnswering(heard: string[]): string {
  if (heard.some((l) => /\beng\.[a-z]+:/.test(l))) {
    return "The board is running its other app. Switch it to the spectrum analyser, then connect again.";
  }
  const said = heard.length ? `it sent: "${heard.slice(-2).join(" / ").slice(0, 120)}"` : "nothing was received";
  return `The board is not answering (${said}). Unplug it, plug it back in and try again.`;
}

/** Our ID? reply: "ID 02:00:00:C5:00:01 Waveshare ESP32-C5-LCD-1.47". Null for anything else. */
export function parseId(line: string | null): { mac: string; board: string } | null {
  const m = line ? /^ID ([0-9A-F:]{17}) (.+)$/.exec(line) : null;
  return m ? { mac: m[1], board: m[2] } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SerialSource implements SpectrumSource {
  private buf = new Uint8Array(0);
  private heard: string[] = [];
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  family = "";
  board: string | null = null;
  mac: string | null = null;
  resyncs = 0;

  constructor(private port: SerialPortLike, private onStatus: (msg: string) => void = () => {}) {}

  /** Let go of the port, so a later Connect can open it again. */
  async close() {
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { this.reader?.releaseLock(); } catch { /* already gone */ }
    try { this.writer?.releaseLock(); } catch { /* already gone */ }
    try { await this.port.close(); } catch { /* already gone */ }
  }

  /** Open, get the board talking, and ask who it is. Returns ESP-SDR's INFO line. */
  async open(): Promise<string> {
    await this.port.open({ baudRate: 2000000 });
    // Do not assert DTR/RTS: on a USB Serial/JTAG port they can reset the chip.
    try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* not supported */ }
    if (!this.port.readable || !this.port.writable) throw new FatalLinkError("The port opened without a data stream. Unplug the board and try again.");
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    // Opening the port can toggle the board's reset lines. Plugged in directly, a C5
    // was left waiting in its bootloader and never answered (2026-10-20). So: retry
    // SYNC with a timeout, then give it the reset-into-program pulse esptool uses,
    // then retry once more.
    if (!(await this.sync(3000))) {
      this.onStatus("Restarting the board…");
      await this.resetIntoProgram();
      if (!(await this.sync(5000))) {
        throw new FatalLinkError(notAnswering(this.heard));
      }
    }
    const info = await this.cmd("INFO");
    this.family = info.split(" ")[0];
    // Every C5 has the same USB name in the port picker, so ask the board who it is.
    // Our builds answer ID?; stock ESP-SDR does not, so whatever it says is dropped
    // and SYNC puts the stream back in step.
    await this.send("ID?");
    const id = parseId(await this.line(1500));
    if (id) { this.mac = id.mac; this.board = id.board; }
    else if (!(await this.sync(3000))) throw new FatalLinkError("The board stopped answering. Unplug it, plug it back in and reconnect.");
    for (const c of ["BANDWIDTH 0", "DC 1", "GAIN HARDWARE"]) await this.cmd(c);
    return info;
  }

  private async send(t: string) { await this.writer!.write(new TextEncoder().encode(t + "\n")); }

  /** Resend SYNC every second until it is echoed or `ms` runs out. */
  private async sync(ms: number): Promise<boolean> {
    const nonce = String(Date.now() % 1e9), end = performance.now() + ms;
    while (performance.now() < end) {
      await this.send(`SYNC ${nonce}`);
      const until = Math.min(end, performance.now() + 1000);
      for (;;) {
        const l = await this.line(until - performance.now());
        if (l == null) break;                       // timed out: resend
        if (l === `SYNC ${nonce}`) return true;
      }
    }
    return false;
  }

  /** RTS pulses reset with DTR released, so the chip boots its program, not the bootloader. */
  private async resetIntoProgram() {
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(120);
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      await sleep(1500);
    } catch { /* not supported */ }
  }

  /** Waits for more bytes. With a timeout, false if none came in time (the read stays pending). */
  private async fill(timeoutMs?: number): Promise<boolean> {
    if (!this.pending) this.pending = this.reader!.read();
    let r: ReadableStreamReadResult<Uint8Array> | null;
    if (timeoutMs == null) r = await this.pending;
    else {
      r = await Promise.race([this.pending, sleep(Math.max(0, timeoutMs)).then(() => null)]);
      if (r === null) return false;
    }
    this.pending = null;
    if (r.done) throw new FatalLinkError("The board was disconnected.");
    const merged = new Uint8Array(this.buf.length + r.value.length);
    merged.set(this.buf); merged.set(r.value, this.buf.length);
    this.buf = merged;
    return true;
  }

  private async line(timeoutMs?: number): Promise<string | null> {
    const end = timeoutMs == null ? null : performance.now() + timeoutMs;
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const s = new TextDecoder().decode(this.buf.slice(0, i)).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        if (s) { this.heard.push(s); if (this.heard.length > 5) this.heard.shift(); }
        return s;
      }
      if (end == null) await this.fill();
      else if (!(await this.fill(end - performance.now()))) return null;
    }
  }

  private async cmd(c: string): Promise<string> {
    await this.send(c);
    const l = await this.line(5000);
    if (l == null) throw new FatalLinkError(`The board stopped answering (${c.split(" ")[0]}). Unplug it, plug it back in and reconnect.`);
    return l;
  }

  /**
   * One spectrum at `centre` MHz: the max (Peak) or mean (Average) of ~60 ms of
   * snapshots. Every step has a deadline; if the byte stream loses its place, re-sync
   * with the board and retry, rather than waiting for ever for a SPECEND already missed.
   */
  async capture(centre: number, det: Detector): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.captureOnce(centre, det); }
      catch (e) {
        if (e instanceof FatalLinkError) throw e;
        this.resyncs++;
        this.onStatus(`re-synced ${this.resyncs}×`);
        await this.resync();
      }
    }
    throw new FatalLinkError("Lost the board: three captures in a row failed. Reconnect.");
  }

  private async captureOnce(centre: number, det: Detector): Promise<Uint8Array> {
    const fail = (why: string): never => { throw new Error(why); };
    await this.send(`FREQ ${centre}`);
    const ok = await this.line(3000);
    if (ok == null || !ok.startsWith("OK")) fail(`FREQ ${centre}: ${ok}`);
    await this.send(`SPEC 60 1 1 ${det === "avg" ? 0 : 1} 0 ${N}`);    // 0 mean, 1 max
    const head = await this.line(3000);
    if (head == null || !head.startsWith("SPEC ")) fail(`SPEC reply: ${head}`);
    const out = new Uint8Array(N), sum = new Float64Array(N), deadline = performance.now() + 3000;
    let frames = 0;
    const need = async (n: number) => {
      while (this.buf.length < n)
        if (!(await this.fill(deadline - performance.now()))) fail("timed out mid-capture");
    };
    for (;;) {
      await need(4);
      const tag = new TextDecoder().decode(this.buf.slice(0, 4));
      if (tag === "SPC1") {
        await need(28 + N + 4);
        const codes = this.buf.subarray(28, 28 + N);
        for (let i = 0; i < N; i++) {
          if (codes[i] > out[i]) out[i] = codes[i];
          sum[i] += Math.pow(10, codes[i] / 20);
        }
        this.buf = this.buf.slice(28 + N + 4);
        frames++;
      } else {
        // Text: SPECEND ends the capture. Anything else that is not a frame is skipped
        // up to the next frame or line, never read as one.
        const nl = this.buf.indexOf(10), sp = indexOfMagic(this.buf);
        if (nl >= 0 && (sp < 0 || nl < sp)) {
          const l = await this.line(deadline - performance.now());
          if (l != null && l.startsWith("SPECEND")) break;
        } else if (sp > 0) this.buf = this.buf.slice(sp);
        else if (!(await this.fill(deadline - performance.now()))) fail("timed out waiting for SPECEND");
      }
    }
    if (!frames) fail("no spectra");
    // Peak: the max over frames. Average: the mean power over frames.
    if (det === "avg") for (let i = 0; i < N; i++) out[i] = Math.max(0, Math.min(255, Math.round(20 * Math.log10(sum[i] / frames))));
    return out;
  }

  /** Stop any stream, then SYNC until the board echoes, dropping whatever was in flight. */
  private async resync() {
    try { await this.send(""); } catch { /* any byte stops a SPEC stream */ }
    await sleep(200);
    this.buf = new Uint8Array(0);
    if (!(await this.sync(3000))) throw new FatalLinkError("The board stopped answering. Unplug it, plug it back in and reconnect.");
  }
}

/** A recording made over USB (sdr_record.py): { "<centre MHz>": [[N codes], …] }. */
export class ReplaySource implements SpectrumSource {
  private n: Record<string, number> = {};
  constructor(private data: Record<string, number[][]>) {}
  async capture(centre: number): Promise<Uint8Array> {
    const list = this.data[String(centre)];
    if (!list) return new Uint8Array(N);
    const i = (this.n[centre] = ((this.n[centre] ?? -1) + 1) % list.length);
    await sleep(40);
    return Uint8Array.from(list[i]);
  }
}
