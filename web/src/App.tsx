/**
 * The page: Analyser and Firmware tabs. Only one is mounted at a time, because both
 * open the board's serial port and a port has one owner.
 */
import { useEffect, useState } from "react";
import { analyserSupported, flashSupported as canFlash } from "./lib/webusb";
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
  const flashSupported = canFlash();

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
        {!analyserSupported() ? (
          <Callout kind="warn" title="This needs Chrome or Edge on a computer, or Chrome on Android.">
            It talks to the board over USB, which Safari, Firefox and iPhones do not allow.
          </Callout>
        ) : tab === "analyser" ? <Analyser onOpenFirmware={() => go("firmware")} />
          : !flashSupported ? (
            <Callout kind="warn" title="Flashing needs Chrome or Edge on a computer.">
              The analyser works on this phone. To put the firmware on a new board, use this page on a Mac,
              Windows, Linux or ChromeOS computer.
            </Callout>
          ) : <Firmware onOpenAnalyser={() => go("analyser")} />}
      </main>

      <footer className="foot">
        <span>By <a href="https://www.linkedin.com/in/james-alexander-julier-2137844/" rel="noopener noreferrer">JJ</a></span>
        <span>v{__APP_VERSION__}</span>
        <span>Built on <a href="https://github.com/ESPARGOS/esp-sdr">ESP-SDR</a> by Florian Euchner (ESPARGOS)</span>
        <span><a href="https://github.com/jamesjulier/esp32c5-spectrum">Source code</a> · GPL-3.0 · <a href="./third-party-notices.txt">Third-party licences</a></span>
        <span>Receive only: nothing is transmitted after start-up.</span>
      </footer>
    </div>
  );
}
