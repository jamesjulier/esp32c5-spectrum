/**
 * The page: Analyser and Firmware tabs. Only one is mounted at a time, because both
 * open the board's serial port and a port has one owner.
 */
import { useEffect, useState } from "react";
import { webSerialSupported } from "./lib/flasher";
import { Analyser } from "./Analyser";
import { Firmware } from "./Firmware";
import { Callout } from "./ui";

type Tab = "analyser" | "firmware";
const fromHash = (): Tab => (window.location.hash === "#firmware" ? "firmware" : "analyser");

export function App() {
  const [tab, setTab] = useState<Tab>(fromHash);
  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (t: Tab) => { history.replaceState(null, "", t === "firmware" ? "#firmware" : window.location.pathname + window.location.search); setTab(t); };
  const supported = webSerialSupported();

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <div>
            <h1>ESP32-C5 Spectrum</h1>
            <p>Radio energy across 2.4 and 5 GHz, from an ESP32-C5 over USB.</p>
          </div>
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          <button type="button" role="tab" aria-selected={tab === "analyser"} onClick={() => go("analyser")}>Analyser</button>
          <button type="button" role="tab" aria-selected={tab === "firmware"} onClick={() => go("firmware")}>Firmware</button>
        </nav>
      </header>

      <main>
        {!supported ? (
          <Callout kind="warn" title="This needs Chrome or Edge on a computer.">
            It talks to the board over USB with Web Serial, which Safari, Firefox and phones do not have.
          </Callout>
        ) : tab === "analyser" ? <Analyser onOpenFirmware={() => go("firmware")} /> : <Firmware onOpenAnalyser={() => go("analyser")} />}
      </main>

      <footer className="foot">
        <span>By James Julier</span>
        <span>Built on <a href="https://github.com/ESPARGOS/esp-sdr">ESP-SDR</a> by Florian Euchner (ESPARGOS)</span>
        <span><a href="https://github.com/jamesjulier/esp32c5-spectrum">Source code</a> · GPL-3.0 · <a href="./third-party-notices.txt">Third-party licences</a></span>
        <span>Receive only: nothing is transmitted after start-up.</span>
      </footer>
    </div>
  );
}
