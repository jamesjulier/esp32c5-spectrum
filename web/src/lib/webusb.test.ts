import { describe, expect, it } from "vitest";
import { WebUsbPort, type UsbDeviceLike } from "./webusb";
import { SerialSource } from "./spectrum/serial";

/**
 * A pretend ESP32-C5 over WebUSB: the USB Serial/JTAG's CDC-ACM layout (interface 0
 * communications, interface 1 data with bulk endpoints 2 in / 2 out, interface 2 JTAG),
 * answering like this repository's firmware.
 */
function fakeBoard() {
  const control: { request: number; value: number; index: number; data?: Uint8Array }[] = [];
  const claimed = new Set<number>();
  const inbox: Uint8Array[] = [];
  let waiting: ((d: Uint8Array) => void) | null = null;
  let unplugged = false;
  const say = (t: string) => {
    const d = new TextEncoder().encode(t + "\n");
    if (waiting) { const w = waiting; waiting = null; w(d); } else inbox.push(d);
  };
  const device: UsbDeviceLike & { unplug(): void } = {
    opened: false,
    configuration: null,
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() {
      this.configuration = { interfaces: [
        { interfaceNumber: 0, alternate: { interfaceClass: 0x02, endpoints: [{ endpointNumber: 1, direction: "in", type: "interrupt", packetSize: 64 }] } },
        { interfaceNumber: 1, alternate: { interfaceClass: 0x0a, endpoints: [
          { endpointNumber: 2, direction: "in", type: "bulk", packetSize: 64 },
          { endpointNumber: 2, direction: "out", type: "bulk", packetSize: 64 }] } },
        { interfaceNumber: 2, alternate: { interfaceClass: 0xff, endpoints: [] } },
      ] };
    },
    async claimInterface(n) { claimed.add(n); },
    async releaseInterface(n) { claimed.delete(n); },
    async controlTransferOut(setup, data) {
      control.push({ request: setup.request, value: setup.value, index: setup.index,
        data: data ? new Uint8Array(data as ArrayBuffer) : undefined });
      return {};
    },
    async transferIn(ep) {
      expect(ep).toBe(2);
      if (unplugged) throw new Error("device gone");
      const d = inbox.shift() ?? await new Promise<Uint8Array>((r) => { waiting = r; });
      if (unplugged) throw new Error("device gone");
      return { status: "ok", data: new DataView(d.buffer, d.byteOffset, d.byteLength) };
    },
    async transferOut(ep, data) {
      expect(ep).toBe(2);
      expect(claimed.has(1)).toBe(true);
      for (const l of new TextDecoder().decode(data as Uint8Array).split("\n").filter(Boolean)) {
        if (l.startsWith("SYNC")) say(l);
        else if (l === "INFO") say("C5SDR 6 burst 16380");
        else if (l === "ID?") say("ID 02:00:00:C5:00:01 Waveshare ESP32-C5-LCD-1.47");
        else say("OK");
      }
      return {};
    },
    unplug() { unplugged = true; if (waiting) { const w = waiting; waiting = null; w(new Uint8Array()); } },
  };
  return { device, control, claimed };
}

describe("WebUSB (Chrome on Android)", () => {
  it("claims the CDC interfaces and sets 8N1 with DTR and RTS off", async () => {
    const { device, control, claimed } = fakeBoard();
    const port = new WebUsbPort(device);
    await port.open({ baudRate: 2000000 });
    expect([...claimed].sort()).toEqual([0, 1]);          // not the JTAG interface
    const lineCoding = control.find((c) => c.request === 0x20)!;
    expect(lineCoding.index).toBe(0);
    expect([...lineCoding.data!]).toEqual([0x80, 0x84, 0x1e, 0x00, 0, 0, 8]);   // 2 000 000, 1 stop, no parity, 8 bits
    expect(control.find((c) => c.request === 0x22)!.value).toBe(0);
    await port.setSignals({ requestToSend: true });
    expect(control.at(-1)).toMatchObject({ request: 0x22, value: 2 });
    await port.setSignals({ dataTerminalReady: true });
    expect(control.at(-1)).toMatchObject({ request: 0x22, value: 3 });  // RTS kept
  });

  it("carries the analyser's own connection: sync, INFO and ID?", async () => {
    const { device } = fakeBoard();
    const s = new SerialSource(new WebUsbPort(device));
    expect(await s.open()).toBe("C5SDR 6 burst 16380");
    expect(s.board).toBe("Waveshare ESP32-C5-LCD-1.47");
    expect(s.mac).toBe("02:00:00:C5:00:01");
    await s.close();
    expect(device.opened).toBe(false);
  });

  it("refuses a device with no serial port", async () => {
    const { device } = fakeBoard();
    device.selectConfiguration = async function () { this.configuration = { interfaces: [] }; };
    await expect(new WebUsbPort(device).open({ baudRate: 2000000 })).rejects.toThrow(/no USB serial port/);
  });

  it("an unplugged board ends the stream with an error the analyser can show", async () => {
    const { device } = fakeBoard();
    const port = new WebUsbPort(device);
    await port.open({ baudRate: 2000000 });
    const reader = port.readable!.getReader();
    const pending = reader.read();
    device.unplug();
    await expect(pending).rejects.toThrow(/device gone/);
  });
});

describe("which connection a browser uses", () => {
  const as = (ua: string, serial: boolean, usb: boolean) => {
    const nav: Record<string, unknown> = { userAgent: ua };
    if (serial) nav.serial = {};
    if (usb) nav.usb = {};
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
    Object.defineProperty(globalThis, "window", { value: { isSecureContext: true }, configurable: true });
  };
  const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Mobile Safari/537.36";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Safari/537.36";

  it("Chrome on Android, which has Web Serial too, uses WebUSB and cannot flash", async () => {
    const { analyserSupported, flashSupported, isAndroid } = await import("./webusb");
    as(ANDROID, true, true);
    expect(isAndroid()).toBe(true);
    expect(flashSupported()).toBe(false);
    expect(analyserSupported()).toBe(true);
  });
  it("Chrome on a computer uses Web Serial and can flash", async () => {
    const { analyserSupported, flashSupported } = await import("./webusb");
    as(MAC, true, true);
    expect(flashSupported()).toBe(true);
    expect(analyserSupported()).toBe(true);
  });
  it("Safari has neither", async () => {
    const { analyserSupported } = await import("./webusb");
    as("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15", false, false);
    expect(analyserSupported()).toBe(false);
  });
});
