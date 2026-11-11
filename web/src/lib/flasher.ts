/**
 * Browser-side flashing of an ESP32-C5 over Web Serial.
 *
 * Wraps esptool-js 0.7.0, which the bench proved on an ESP32-C5 on 2026-09-27
 * (8 MB detected, no BOOT press needed, 1.29 MB written and verified in ~10 s).
 * Two things the bench found are handled here, not left to the library:
 *
 *  1. **Writes are chunked to 64 bytes.** Large single writes to the C5's USB-JTAG
 *     CDC stalled the stub upload for 30 s; 64-byte writes took it to 0.4 s.
 *  2. **We reset into the app ourselves.** esptool-js's `hard_reset` left the chip
 *     in download mode — a verified flash that never boots. DTR is released first,
 *     then EN (RTS) is pulsed.
 *
 * WebSerial is Chrome/Edge only and needs a secure context (HTTPS or localhost).
 */

import SparkMD5 from "spark-md5";

// esptool-js is imported lazily: it touches browser globals at module load.
type EsptoolModule = typeof import("esptool-js");

export const ESPRESSIF_USB_VID = 0x303a;

/** Minimal slice of the WebSerial API we use (the DOM lib types lack it). */
export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

export function webSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator && window.isSecureContext;
}

export async function requestBoardPort(): Promise<SerialPortLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serial = (navigator as any).serial;
  return serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
}

/**
 * The real port with its writable side replaced by one that forwards in 64-byte
 * slices. Everything else passes through untouched.
 */
function chunkedPort(port: SerialPortLike): SerialPortLike {
  let chunked: WritableStream<Uint8Array> | null = null;
  return {
    get readable() { return port.readable; },
    get writable() {
      if (!port.writable) return null;
      if (!chunked) {
        const inner = port.writable;
        chunked = new WritableStream<Uint8Array>({
          async write(data) {
            const w = inner.getWriter();
            try {
              for (let i = 0; i < data.length; i += 64) await w.write(data.subarray(i, i + 64));
            } finally { w.releaseLock(); }
          },
        });
      }
      return chunked;
    },
    open: async (o) => { chunked = null; await port.open(o); },
    close: async () => { chunked = null; await port.close(); },
    setSignals: (s) => port.setSignals(s),
    getInfo: () => port.getInfo(),
  };
}

export interface BoardSession {
  chip: string;
  mac: string;               // "02:00:00:C5:00:01"
  write(regions: FlashRegion[], onProgress: (pct: number) => void): Promise<void>;
  resetToApp(): Promise<void>;
  close(): Promise<void>;
}

export interface FlashRegion { name: string; address: number; data: Uint8Array }

export async function connectBoard(port: SerialPortLike, log: (line: string) => void): Promise<BoardSession> {
  const esptool: EsptoolModule = await import("esptool-js");
  const wrapped = chunkedPort(port);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transport = new esptool.Transport(wrapped as any, false);
  const loader = new esptool.ESPLoader({
    transport, baudrate: 921600,
    terminal: { clean() {}, writeLine: (s: string) => log(s), write: () => {} },
  });
  const chip = await loader.main("default_reset");
  const mac = (await loader.chip.readMac(loader)).toUpperCase();
  return {
    chip, mac,
    async write(regions, onProgress) {
      const total = regions.reduce((n, r) => n + r.data.length, 0);
      const done = new Array(regions.length).fill(0);
      await loader.writeFlash({
        fileArray: regions.map((r) => ({ data: r.data, address: r.address })),
        flashMode: "keep", flashFreq: "keep", flashSize: "keep",
        eraseAll: false, compress: true,
        // esptool-js verifies each region on the chip against this and throws on mismatch.
        calculateMD5Hash: (image: Uint8Array) =>
          SparkMD5.ArrayBuffer.hash(image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer),
        reportProgress: (i: number, written: number, size: number) => {
          done[i] = (written / size) * regions[i].data.length;
          onProgress(Math.min(100, Math.round((done.reduce((a, b) => a + b, 0) / total) * 100)));
        },
      });
    },
    async resetToApp() {
      await port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise((r) => setTimeout(r, 100));
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    },
    async close() {
      try { await transport.disconnect(); } catch { /* already closed */ }
    },
  };
}

/** Does the connected chip match the firmware's? esptool-js reports e.g.
 *  "ESP32-C3 (QFN32) (revision v0.4)"; the manifest says "esp32c3"/"esp32c5".
 *  esptool-js writes whatever it is given: without this, firmware for one chip can go onto another
 *  and leave it unbootable. */
export function chipMatches(connected: string, manifestChip: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(connected).startsWith(norm(manifestChip));
}

/** Fetch a bundle file and check it against the manifest before it goes near a chip. */
export async function fetchVerified(url: string, sha256: string, headers: HeadersInit): Promise<Uint8Array> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Could not download ${url.split("/").pop()} (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== sha256) throw new Error(`${url.split("/").pop()} failed its checksum — not flashing it`);
  return buf;
}

