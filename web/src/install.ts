/**
 * "Install app": Chrome and Edge say once, early, that the page can be installed
 * (beforeinstallprompt). That event is kept here so a button shown later can use it.
 * The button only appears while installing is possible: never in Safari or Firefox,
 * and not once the app is installed or already running as the app.
 */
import { useEffect, useState } from "react";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let pending: InstallEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();               // our own button instead of Chrome's mini bar
  pending = e as InstallEvent;
  changed();
});
window.addEventListener("appinstalled", () => { pending = null; changed(); });

/** [can install now, install()] */
export function useInstall(): [boolean, () => Promise<void>] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  const install = async () => {
    const e = pending;
    if (!e) return;
    pending = null;                 // the event can be used once
    changed();
    await e.prompt();
  };
  return [pending != null, install];
}
