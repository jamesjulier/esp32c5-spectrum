/**
 * Flash a board from the browser: the images and manifest.json in public/firmware/,
 * made by firmware/make-images.sh. Each is one merged image written at 0x0.
 *
 * ESP-SDR is GPL-3.0: the manifest names the exact ESP-SDR commit and this repository's
 * patch commit, and this page shows both, which is how anyone given an image finds its source.
 */
import { useEffect, useRef, useState } from "react";
import { chipMatches, connectBoard, fetchVerified, requestBoardPort, type BoardSession } from "./lib/flasher";
import { Callout, UsbIcon } from "./ui";

const DIR = "./firmware";
const REPO = "https://github.com/jamesjulier/esp32c5-spectrum";

interface Image { board: string; label: string; file: string; chip: string; offset: string; flash_size: string; kind: string; bytes: number; sha256: string }
interface Manifest {
  built: string;
  esp_sdr: { repo: string; mirror?: string; commit: string; licence: string };
  patch: { path: string; commit: string };
  images: Image[];
}
const short = (sha: string) => sha.slice(0, 7);

const WHAT: Record<string, string> = {
  "spectrum-on-screen": "Spectrum on its own screen. This page can also take it over from the Analyser tab.",
  "esp-sdr-stock": "ESP-SDR, no screen: use it from the Analyser tab.",
};

type Phase = "idle" | "connecting" | "connected" | "flashing" | "done" | "error";

export function Firmware({ onOpenAnalyser }: { onOpenAnalyser: () => void }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [chip, setChip] = useState("");
  const [mac, setMac] = useState("");
  const [pct, setPct] = useState(0);
  const [message, setMessage] = useState("");
  const session = useRef<BoardSession | null>(null);

  useEffect(() => {
    fetch(`${DIR}/manifest.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
      .then((m: Manifest) => { setManifest(m); setBoard(m.images[0]?.board ?? null); })
      .catch((e) => setLoadError(String(e.message ?? e)));
    // Leaving the tab must let go of the port, or the Analyser cannot open it.
    return () => { session.current?.close(); session.current = null; };
  }, []);

  const image = manifest?.images.find((i) => i.board === board) ?? null;

  async function connect() {
    if (!image) return;
    setPhase("connecting"); setMessage(""); setPct(0);
    try {
      const port = await requestBoardPort();
      const s = await connectBoard(port, () => {});
      if (!chipMatches(s.chip, image.chip)) {
        await s.close();
        throw new Error(`That board is ${s.chip}, not an ESP32-C5. Nothing was written.`);
      }
      session.current = s;
      setChip(s.chip); setMac(s.mac); setPhase("connected");
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") { setPhase("idle"); return; }
      setPhase("error"); setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function flash() {
    const s = session.current;
    if (!s || !image) return;
    setPhase("flashing"); setPct(0); setMessage("Downloading and checking the image…");
    try {
      const data = await fetchVerified(`${DIR}/${image.file}`, image.sha256, {});
      setMessage("Writing…");
      await s.write([{ name: image.file, address: parseInt(image.offset, 16), data }], setPct);
      await s.resetToApp();
      await s.close(); session.current = null;
      setPhase("done");
      setMessage("Written, verified and restarted.");
    } catch (e) {
      try { await s.close(); } catch { /* already closed */ }
      session.current = null;
      setPhase("error"); setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  if (loadError) return <Callout kind="error" title="The firmware images are missing from this site.">{loadError}. They are built by firmware/make-images.sh.</Callout>;
  if (!manifest) return <div className="card pad muted">Loading…</div>;

  const busy = phase === "connecting" || phase === "flashing";
  return (
    <div className="narrow">
      <Callout kind="warn" title="This replaces whatever the board runs.">
        Everything on the board is overwritten, its saved settings included.
      </Callout>

      <section className="card pad">
        <h2>1. Which board?</h2>
        <p className="muted">All are ESP32-C5. The image depends on the board, so choose it here.</p>
        <div className="boards" role="radiogroup" aria-label="Board">
          {manifest.images.map((im) => (
            <button key={im.board} type="button" role="radio" className="board" aria-checked={board === im.board} disabled={busy}
              onClick={() => { setBoard(im.board); if (phase === "done" || phase === "error") setPhase(session.current ? "connected" : "idle"); }}>
              <b>{im.label}</b>
              <span className="muted">{WHAT[im.kind] ?? im.kind}</span>
              <small className="mono">{im.file} · {(im.bytes / 1024).toFixed(0)} KB · {im.flash_size} header</small>
            </button>
          ))}
        </div>
      </section>

      <section className="card pad" style={{ display: "grid", gap: 12 }}>
        <div>
          <h2>2. Connect and flash</h2>
          <p className="muted">Plug the board into this computer with USB-C, then pick <b>USB JTAG/serial debug unit</b>.</p>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <button type="button" className={`btn${phase === "connected" ? "" : " primary"}`} onClick={connect} disabled={busy || !image || phase === "connected"}>
            <UsbIcon />{phase === "connected" ? "Connected" : "Connect board"}
          </button>
          <button type="button" className="btn primary" onClick={flash} disabled={phase !== "connected"}>Flash {image?.label ?? ""}</button>
          {chip && <span className="muted">{chip} · <span className="mono">{mac}</span></span>}
        </div>
        {phase === "flashing" && (
          <div style={{ display: "grid", gap: 4 }}>
            <progress max={100} value={pct} aria-label="Flashing progress" />
            <span className="muted" role="status">{message} {pct > 0 ? `${pct}%` : ""}</span>
          </div>
        )}
        {phase === "done" && (
          <Callout kind="ok" title={message}>
            Open the <a href="#analyser" onClick={(e) => { e.preventDefault(); onOpenAnalyser(); }}>Analyser</a> tab and connect.
            {image?.kind === "spectrum-on-screen" && " The board's own screen shows the spectrum straight away."}
          </Callout>
        )}
        {phase === "error" && <Callout kind="error" title="Not flashed.">{message}</Callout>}
      </section>

      <p className="muted" style={{ fontSize: 12 }}>
        Built from <a href={`${manifest.esp_sdr.repo}/tree/${manifest.esp_sdr.commit}`}>ESP-SDR {short(manifest.esp_sdr.commit)}</a> by
        Florian Euchner ({manifest.esp_sdr.licence}{manifest.esp_sdr.mirror && <>, <a href={`${manifest.esp_sdr.mirror}/tree/${manifest.esp_sdr.commit}`}>mirror</a></>}),
        modified by James Julier with <a href={`${REPO}/blob/${manifest.patch.commit}/${manifest.patch.path}`} className="mono">{manifest.patch.path}</a> at {short(manifest.patch.commit)}.
        Images built {manifest.built}. <a href={`${REPO}/blob/main/THIRD-PARTY-NOTICES.md`}>Third-party licences</a>.
      </p>
    </div>
  );
}
