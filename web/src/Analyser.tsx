/**
 * The analyser: live spectrum from an ESP32-C5 running ESP-SDR (or this repository's
 * firmware) over Web Serial. The engine is lib/spectrum (serial link, maths, canvas
 * drawing); this is the page around it.
 *
 * ?replay=<url> plays a recording instead of a board, for testing without hardware.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestBoardPort } from "./lib/flasher";
import { FatalLinkError, ReplaySource, SerialSource, type Detector } from "./lib/spectrum/serial";
import { Analyser as Engine, BANDS, BLOCKS, ROWS, type Block, type Lines, type Readout, type RowSec } from "./lib/spectrum/analyser";
import {
  BUSY_TEXT, channelAt, drawChannels, drawDensity, drawFall, drawMarks, drawTrace, savePicture, scaleGradient,
} from "./lib/spectrum/draw";
import { Callout, Field, Segmented, UsbIcon } from "./ui";
import { useInstall } from "./install";

type Mode = "live" | "density" | "channels";
type Chart = "trace" | "fall" | "dens" | "chan";
type Link =
  | { kind: "idle"; note?: string }
  | { kind: "connecting"; note?: string }
  | { kind: "connected"; board: string | null; mac: string | null; family: string; note?: string }
  | { kind: "replay" }
  | { kind: "error" };

const LINES: { key: keyof Lines; text: string; colour: string }[] = [
  { key: "peak", text: "Peak hold", colour: "var(--spec-peak)" },
  { key: "avg", text: "Average", colour: "var(--spec-avg)" },
];
const linesText = (l: Lines) => LINES.filter((x) => l[x.key]).map((x) => x.text).join(" + ");

export function Analyser({ onOpenFirmware }: { onOpenFirmware: () => void }) {
  const a = useRef<Engine>(null as unknown as Engine);
  if (!a.current) a.current = new Engine();
  const an = a.current;

  const [link, setLink] = useState<Link>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [canInstall, install] = useInstall();
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("live");
  const [focus, setFocus] = useState<Chart | null>(null);
  const [, setTick] = useState(0);                  // re-render on analyser changes
  const [readout, setReadout] = useState<Readout | null>(null);
  const help = useRef<HTMLDialogElement>(null);
  const cursor = useRef<number | null>(null);
  const canvases = useRef<Partial<Record<Chart | "marks", HTMLCanvasElement | null>>>({});
  const frame = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Draw what is on screen, at most once a frame.
  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const c = canvases.current, x = cursor.current, m = modeRef.current;
      if (m === "live") { if (c.trace) drawTrace(c.trace, an, x); if (c.fall) drawFall(c.fall, an, x); }
      if (m === "density" && c.dens) drawDensity(c.dens, an, x);
      if (m === "channels" && c.chan) drawChannels(c.chan, an);
      if (m !== "channels" && c.marks) drawMarks(c.marks, an.bandIndex, an.viewMHz());
      setReadout(x == null ? null : an.readoutAt(x));
      setTick((t) => t + 1);
    });
  }, [an]);

  // The sweep loop, for as long as the page is open.
  useEffect(() => {
    let alive = true;
    const off = an.subscribe(draw);
    an.run((e) => {
      setLink({ kind: "error" });
      setError(e instanceof Error ? e.message : String(e));
    }, () => alive);
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    draw();
    return () => {
      alive = false; off();
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame.current);
      const s = an.source; an.source = null;
      void s?.close?.();                            // let go of the port for the Firmware tab
    };
  }, [an, draw]);

  // Redraw when the view changes shape.
  useEffect(() => { draw(); }, [mode, focus, draw]);

  // ?replay=<url>, from this site only: a link must not be able to show another
  // site's made-up spectrum as if it were a measurement.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("replay");
    if (!param) return;
    const url = new URL(param, window.location.href);
    if (url.origin !== window.location.origin) {
      setLink({ kind: "error" });
      setError("Replay files must come from this site.");
      return;
    }
    fetch(url).then((r) => r.json()).then((d) => { an.setSource(new ReplaySource(d)); setLink({ kind: "replay" }); })
      .catch((e) => { setLink({ kind: "error" }); setError(`Replay failed: ${e instanceof Error ? e.message : e}`); });
  }, [an]);

  // Two easter eggs, typed anywhere on the page:
  //   the Konami code  green-phosphor oscilloscope colours (again to switch back)
  //   "microwave"      jump to where microwave ovens leak, about 2.45 GHz (channel 9)
  useEffect(() => {
    const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    let keys: string[] = [], typed = "";
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      keys = [...keys, k].slice(-KONAMI.length);
      if (keys.join() === KONAMI.join()) {
        keys = [];
        const on = document.documentElement.classList.toggle("phosphor");
        setNote(on ? "Phosphor mode. Somewhere, an old oscilloscope smiles." : "Back to colour.");
        draw();
      }
      if (k.length === 1) typed = (typed + k).slice(-9);
      if (typed === "microwave") {
        typed = "";
        an.setBand(0); an.setZoom(9);
        setNote("Microwave ovens leak right about here, 2.45 GHz, channel 9. Go and put something in for a minute, then come back and watch.");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [an, draw]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 7000);
    return () => clearTimeout(t);
  }, [note]);

  // Esc leaves an enlarged chart.
  useEffect(() => {
    if (!focus) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !help.current?.open) setFocus(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  async function connect() {
    setError(null);
    let s: SerialSource | null = null;
    try {
      const port = await requestBoardPort();
      setLink({ kind: "connecting" });
      s = new SerialSource(port, (note) => setLink((l) => (l.kind === "connected" || l.kind === "connecting" ? { ...l, note } : l)));
      const info = await s.open();
      an.setSource(s);
      setLink({ kind: "connected", board: s.board, mac: s.mac, family: info.split(" ")[0] });
    } catch (e) {
      try { await s?.close(); } catch { /* already gone */ }
      // Closing Chrome's port list (or an empty one) is not a fault.
      if (e instanceof DOMException && e.name === "NotFoundError") { setLink({ kind: "idle", note: "No board chosen" }); return; }
      setLink({ kind: "error" });
      setError(e instanceof FatalLinkError || e instanceof Error ? e.message : String(e));
    }
  }
  async function disconnect() {
    const s = an.source; an.setSource(null);
    try { await s?.close?.(); } catch { /* already gone */ }
    setLink({ kind: "idle" });
  }

  const pointer = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    cursor.current = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    draw();
  };
  const keys = (ev: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const step = (ev.shiftKey ? 0.025 : 0.004) * (ev.key === "ArrowLeft" ? -1 : 1);
    cursor.current = Math.max(0, Math.min(1, (cursor.current ?? 0.5) + step));
    draw();
  };
  const ref = (k: Chart | "marks") => (el: HTMLCanvasElement | null) => { canvases.current[k] = el; };
  const hasData = !!an.cols;
  const waiting = !an.source && !hasData;
  const band = an.band;
  const busy = link.kind === "connecting";
  const shownLines = LINES.filter((x) => an.lines[x.key]);

  const canvas = (k: Chart, label: string, height: string, interactive: boolean) => {
    const on = focus === k;
    if (focus && !on) return null;
    return (
      <div className="plot" key={k}>
        <canvas ref={ref(k)} aria-label={label} tabIndex={interactive ? 0 : undefined}
          onPointerMove={interactive ? pointer : undefined} onPointerDown={interactive ? pointer : undefined}
          onKeyDown={interactive ? keys : undefined} onDoubleClick={() => setFocus(on ? null : k)}
          style={{ height: on ? "max(360px, calc(100vh - 380px))" : height }} />
        <button type="button" className={`enlarge${on ? " on" : ""}`} onClick={() => setFocus(on ? null : k)}
          title={on ? "Back (Esc)" : "Enlarge (or double-click)"}
          aria-label={on ? `Shrink the ${label.toLowerCase()}` : `Enlarge the ${label.toLowerCase()}`}>
          {on ? "Back" : "Enlarge"}
        </button>
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="row">
        <LinkState link={link} />
        {link.kind === "connected"
          ? <button type="button" className="btn" onClick={disconnect}>Disconnect</button>
          : link.kind !== "replay" && (
            <button type="button" className="btn primary" onClick={connect} disabled={busy}>
              <UsbIcon />{busy ? "Connecting…" : "Connect board"}
            </button>
          )}
      </div>

      {error && <Callout kind="error" title={error.startsWith("Replay") ? "Replay not loaded." : "The board stopped."}>{error}</Callout>}
      {note && <div className="toast" role="status">{note}</div>}

      <div className="row">
        <Field label="Band">
          <Segmented label="Band" value={String(an.bandIndex)} onChange={(v) => an.setBand(Number(v))}
            options={BANDS.map((b, i) => ({ value: String(i), text: b.name }))} />
        </Field>
        <Field label="Lines" tip="Lines over the trace, any or none. Peak hold is the highest level seen. Average is the power average of every sweep since the band was chosen.">
          <div className="seg" role="group" aria-label="Lines over the trace">
            {LINES.map((x) => (
              <button key={x.key} type="button" aria-pressed={an.lines[x.key]}
                onClick={() => an.setLines({ ...an.lines, [x.key]: !an.lines[x.key] })}>
                <span className="swatch" style={{ background: x.colour }} aria-hidden="true" />{x.text}
              </button>
            ))}
          </div>
        </Field>
        <div className="row spacer" style={{ gap: 8 }}>
          {an.zoomChannel != null && (
            <button type="button" className="btn" title="Back to the whole band" onClick={() => an.setZoom(null)}>Zoom: ch {an.zoomChannel} ×</button>
          )}
          <button type="button" className="btn" aria-pressed={an.overlay} onClick={() => an.setOverlay(!an.overlay)}
            title="Wi-Fi channel outlines over the trace. Click a channel number under the chart to zoom to it.">Channel overlay</button>
          <button type="button" className="btn" aria-pressed={an.paused} onClick={() => an.setPaused(!an.paused)}>{an.paused ? "Resume" : "Pause"}</button>
          <button type="button" className="btn" title="Start the figures again" onClick={() => an.reset()}>Clear</button>
          <button type="button" className="btn" disabled={!hasData} title="Save what is on screen as a picture, with the band, settings and time on it"
            onClick={() => savePicture((["trace", "fall", "dens", "chan", "marks"] as const).map((k) => canvases.current[k]).filter((c): c is HTMLCanvasElement => !!c),
              `${band.name}  ${band.start}–${band.end} MHz  ${an.summary()}  ${linesText(an.lines)}  ${new Date().toLocaleString("en-GB")}`)}>
            Save picture
          </button>
          <button type="button" className="btn ghost" onClick={() => help.current?.showModal()}>How to read it</button>
        </div>
      </div>

      <div className="card">
        <div className="modebar">
          <div className="tabs" role="tablist" aria-label="View">
            {(["live", "density", "channels"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setFocus(null); }}>
                {m === "live" ? "Live" : m === "density" ? "Density" : "Channels"}
              </button>
            ))}
          </div>
          <span className="summary num">{band.name} · {band.start}–{band.end} MHz · {an.summary()}</span>
        </div>

        {mode === "live" && (
          <div className="row" style={{ padding: "12px 16px" }}>
            <Field label="Detector" tip="Average is the true average power: a busy channel reads as a steady band. Peak is the strongest moment: every burst, busier to read. Changing it starts the figures again.">
              <Segmented label="Detector" value={an.detector} onChange={(v) => an.setDetector(v as Detector)}
                options={[{ value: "avg", text: "Average" }, { value: "peak", text: "Peak" }]} />
            </Field>
            <Field label="Rows" tip="How much time each waterfall row covers.">
              <Segmented label="Waterfall row length" value={String(an.rowSec)} onChange={(v) => an.setRows(Number(v) as RowSec)}
                options={ROWS.map((s) => ({ value: String(s), text: `${s} s` }))} />
            </Field>
            <Field label="Blocks" tip="Groups frequencies in the waterfall, taking the strongest reading in each, blended. Fine is every point.">
              <Segmented label="Waterfall block size" value={String(an.block)} onChange={(v) => an.setBlock(Number(v) as Block)}
                options={BLOCKS.map((m) => ({ value: String(m), text: m ? `${m} MHz` : "Fine" }))} />
            </Field>
          </div>
        )}

        <div style={{ padding: "0 16px 16px", marginTop: mode === "live" ? 0 : 16 }}>
          {waiting ? (
            <div className="empty welcome">
              <div>
                <img src="./icon.svg" alt="" width="56" height="56" />
                <h2>Hello. Let&apos;s see what&apos;s in the air.</h2>
                <p className="muted">
                  This turns a cheap ESP32-C5 board into a 2.4 and 5 GHz spectrum analyser. Wi-Fi shows up,
                  and so does everything else: microwaves, video senders, Bluetooth.
                </p>
                <ol>
                  <li>New board? Put the firmware on it from the{" "}
                    <a href="#firmware" onClick={(e) => { e.preventDefault(); onOpenFirmware(); }}>Firmware</a> tab. It takes half a minute.</li>
                  <li>Plug the board into this computer.</li>
                  <li>Click <b>Connect board</b> and pick <b>USB JTAG/serial debug unit</b>.</li>
                </ol>
                <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                  <button type="button" className="btn primary" onClick={connect} disabled={busy}>
                    <UsbIcon />{busy ? "Connecting…" : "Connect board"}
                  </button>
                  {canInstall && <button type="button" className="btn" onClick={install}
                    title="Its own window and icon, and it works offline">Install app</button>}
                </div>
                <div className="hello">
                  <img src="./james.png" alt="James Julier" width="48" height="48" />
                  <p>Hi, I&apos;m James, and I made this.
                    {canInstall ? " Install it and it's one click away next time." : ""} Have fun, and tell me what you find.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="plots">
              {mode === "live" && <>
                {canvas("trace", "Spectrum trace", "min(44vh, 420px)", true)}
                {canvas("fall", "Waterfall", "min(28vh, 260px)", true)}
              </>}
              {mode === "density" && canvas("dens", "Density", "min(64vh, 600px)", true)}
              {mode === "channels" && canvas("chan", "Channel busy share", "min(64vh, 600px)", false)}
              {mode !== "channels" && <canvas ref={ref("marks")} className="marks" aria-label="Wi-Fi channels: click a number to zoom to that channel"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect(), ch = channelAt(an, (e.clientX - r.left) / r.width);
                  an.setZoom(an.zoomChannel === ch ? null : ch);
                }} />}
            </div>
          )}

          {!waiting && (
            <div className="legend">
              {mode !== "channels" && (
                <span className="row" style={{ gap: 8 }} aria-hidden="true">
                  <span className="ramp" style={{ background: scaleGradient(mode === "live" ? "level" : "density") }} />
                  <span className="num">{mode === "live" ? "0 to +36 dB" : "1 % to all the time"}</span>
                </span>
              )}
              <span>
                {mode === "live" ? "Waterfall colour is the level above the noise floor, newest at the top."
                  : mode === "density" ? "Colour is how often a level is reached at that frequency."
                  : BUSY_TEXT}
              </span>
            </div>
          )}
        </div>

        {mode !== "channels" && !waiting && (
          <div className="stats">
            <Stat label="Frequency" value={readout ? `${readout.mhz.toFixed(1)} MHz` : "—"} />
            <Stat label="Nearest channel" value={readout ? String(readout.channel) : "—"} />
            <Stat label="Now" value={readout ? `+${readout.now.toFixed(0)} dB` : "—"} />
            {shownLines.map((x) => {
              const v = readout?.[x.key];
              return <Stat key={x.key} label={x.text} value={v != null ? `+${v.toFixed(0)} dB` : "—"} />;
            })}
          </div>
        )}
      </div>

      <dialog ref={help} aria-labelledby="help-title">
        <h2 id="help-title">How to read the spectrum</h2>
        <p className="muted">How much radio energy there is at each frequency: Wi-Fi and anything else, such as microwave ovens, video senders and Bluetooth.</p>
        <p><b>Live.</b> The trace is the level now, red at the noise floor to green on strong signals. The waterfall is history, newest at the top: steady colour is a constant signal, flecks are bursts.</p>
        <p><b>Density.</b> How often each level is reached at each frequency, blue rarely to red most of the time. A steady signal is a tight band, bursty traffic a spread.</p>
        <p><b>Channels.</b> The share of time each Wi-Fi channel had energy more than 6 dB above the noise. The lowest bar is the quietest channel.</p>
        <p><b>Good to know.</b> Levels are dB above the noise floor, not dBm: the receiver&apos;s gain is not calibrated. Captures are short snapshots with gaps, so a very brief burst can be missed. Figures cover everything since the band was chosen.</p>
        <p>A board with its own screen shows PHONE CONNECTED while this page has the radio, and returns to its own view 10 s after the page lets go.</p>
        <form method="dialog" style={{ textAlign: "right", marginTop: 16 }}><button className="btn primary">Got it</button></form>
      </dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div className="label">{label}</div><div className="value">{value}</div></div>;
}

function LinkState({ link }: { link: Link }) {
  const dot = link.kind === "connected" ? "ok" : link.kind === "error" ? "bad" : link.kind === "replay" || link.kind === "connecting" ? "warn" : "";
  const text = link.kind === "connected"
    ? <><b>{link.board ?? link.family}</b>{link.mac && <span className="mono"> · {link.mac}</span>}</>
    : link.kind === "connecting" ? "Connecting…"
    : link.kind === "replay" ? "Replay · recorded spectra"
    : link.kind === "error" ? "Disconnected"
    : "Not connected";
  const note = "note" in link && link.note;
  return (
    <span className="status" role="status">
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span>{text}{note && <span className="muted"> · {note}</span>}</span>
    </span>
  );
}
