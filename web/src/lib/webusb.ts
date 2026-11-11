/**
 * The board's USB serial port over WebUSB, for Chrome on Android, which has WebUSB
 * but no Web Serial. It behaves like a Web Serial port (SerialPortLike), so the
 * analyser cannot tell the difference. Flashing still needs Web Serial.
 *
 * The ESP32-C5's USB Serial/JTAG is a CDC-ACM device: a communications interface
 * (class 0x02) that takes the control requests, and a data interface (class 0x0A)
 * with one bulk endpoint each way. Desktop operating systems bind their own driver
 * to it, so WebUSB cannot claim it there; Android leaves it free.
 */
import { ESPRESSIF_USB_VID, requestBoardPort, webSerialSupported, type SerialPortLike } from "./flasher";

// The slice of WebUSB used here (TypeScript's DOM types do not include it).
export interface UsbEndpoint { endpointNumber: number; direction: "in" | "out"; type: string; packetSize: number }
export interface UsbInterface {
  interfaceNumber: number;
  alternate: { interfaceClass: number; endpoints: UsbEndpoint[] };
}
export interface UsbDeviceLike {
  opened: boolean;
  configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  controlTransferOut(setup: { requestType: "class"; recipient: "interface"; request: number; value: number; index: number }, data?: BufferSource): Promise<unknown>;
  transferIn(ep: number, length: number): Promise<{ status: string; data?: DataView }>;
  transferOut(ep: number, data: BufferSource): Promise<unknown>;
}

const CDC_COMM = 0x02, CDC_DATA = 0x0a;
const SET_LINE_CODING = 0x20, SET_CONTROL_LINE_STATE = 0x22;

export class WebUsbPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private comm = 0;
  private data = 0;
  private epIn = 0;
  private epOut = 0;
  private signals = { dataTerminalReady: false, requestToSend: false };
  private closed = false;

  constructor(private device: UsbDeviceLike) {}

  async open(o: { baudRate: number }) {
    const d = this.device;
    if (!d.opened) await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    const ifaces = d.configuration?.interfaces ?? [];
    const comm = ifaces.find((i) => i.alternate.interfaceClass === CDC_COMM);
    const data = ifaces.find((i) => i.alternate.interfaceClass === CDC_DATA);
    const bulk = (dir: "in" | "out") => data?.alternate.endpoints.find((e) => e.direction === dir && e.type === "bulk");
    const epIn = bulk("in"), epOut = bulk("out");
    if (!comm || !data || !epIn || !epOut) throw new Error("This board has no USB serial port the browser can use.");
    this.comm = comm.interfaceNumber; this.data = data.interfaceNumber;
    this.epIn = epIn.endpointNumber; this.epOut = epOut.endpointNumber;
    await d.claimInterface(this.comm);
    await d.claimInterface(this.data);

    // Line coding: baud (little-endian), 1 stop bit, no parity, 8 data bits. The
    // USB Serial/JTAG ignores the rate, but some hosts expect it to be set.
    const lc = new DataView(new ArrayBuffer(7));
    lc.setUint32(0, o.baudRate, true); lc.setUint8(4, 0); lc.setUint8(5, 0); lc.setUint8(6, 8);
    await this.control(SET_LINE_CODING, 0, lc.buffer);
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });

    this.closed = false;
    const size = Math.max(64, epIn.packetSize) * 64;     // many packets per read
    this.readable = new ReadableStream<Uint8Array>({
      pull: async (ctl) => {
        if (this.closed) { ctl.close(); return; }
        try {
          const r = await d.transferIn(this.epIn, size);
          if (r.status === "stall") return;
          if (r.data && r.data.byteLength) ctl.enqueue(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength).slice());
        } catch (e) {
          if (this.closed) ctl.close(); else ctl.error(e);   // unplugged: the reader sees the stream end
        }
      },
      cancel: () => { this.closed = true; },
    }, { highWaterMark: 0 });
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => { await d.transferOut(this.epOut, chunk.slice()); },
    });
  }

  async setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }) {
    this.signals = {
      dataTerminalReady: s.dataTerminalReady ?? this.signals.dataTerminalReady,
      requestToSend: s.requestToSend ?? this.signals.requestToSend,
    };
    await this.control(SET_CONTROL_LINE_STATE, (this.signals.dataTerminalReady ? 1 : 0) | (this.signals.requestToSend ? 2 : 0));
  }

  async close() {
    this.closed = true;
    for (const n of [this.data, this.comm]) { try { await this.device.releaseInterface(n); } catch { /* already gone */ } }
    try { await this.device.close(); } catch { /* already gone */ }
    this.readable = null; this.writable = null;
  }

  getInfo() { return {}; }

  private control(request: number, value: number, data?: ArrayBuffer) {
    return this.device.controlTransferOut({ requestType: "class", recipient: "interface", request, value, index: this.comm }, data);
  }
}

// ─── Which connection this browser uses ──────────────────────────────────────

export function webUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator && window.isSecureContext;
}

/**
 * Chrome on Android has Web Serial too, but there it only reaches Bluetooth serial
 * devices: its port picker shows "No compatible devices found" for a USB board
 * (seen on a phone, 2026-11-11). So on Android a USB board is always WebUSB.
 */
export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/** Flashing needs Web Serial to reach a USB board: a computer, not Android. */
export function flashSupported(): boolean {
  return webSerialSupported() && !isAndroid();
}

/** The analyser runs on Web Serial (computers) or WebUSB (Chrome on Android). */
export function analyserSupported(): boolean {
  return flashSupported() || webUsbSupported();
}

/** The browser's board picker: Web Serial on a computer, otherwise WebUSB. */
export async function requestAnalyserPort(): Promise<SerialPortLike> {
  if (flashSupported()) return requestBoardPort();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usb = (navigator as any).usb;
  return new WebUsbPort(await usb.requestDevice({ filters: [{ vendorId: ESPRESSIF_USB_VID }] }));
}
