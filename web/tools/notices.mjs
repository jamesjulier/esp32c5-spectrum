// Writes public/third-party-notices.txt: the licence of every library that ships
// inside the published site, taken from the installed packages, so it cannot
// drift from what is bundled. Runs before every build (package.json "build").
//
// Shipped = the production dependency tree (the app bundle) plus the Workbox
// modules the generated service worker (sw.js) and its registration contain.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SW_MODULES = ["workbox-core", "workbox-precaching", "workbox-routing", "workbox-strategies", "workbox-window"];

// npm may mask parts of absolute paths it prints, so keep only the part from the
// first node_modules/ and resolve it against this project.
const tree = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8" })
  .split("\n").filter((p) => p.includes("node_modules"))
  .map((p) => join(root, p.slice(p.indexOf("node_modules"))));
const dirs = [...new Set([...tree, ...SW_MODULES.map((m) => join(root, "node_modules", m))])];

const blocks = dirs.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`${pkg.name} ships in the site but has no licence file`);
  return { name: pkg.name, text: `${pkg.name} ${pkg.version} (${pkg.license})\n${pkg.homepage ?? ""}\n\n${readFileSync(join(dir, file), "utf8").trim()}` };
}).sort((a, b) => a.name.localeCompare(b.name));

const rule = "\n\n" + "-".repeat(78) + "\n\n";
writeFileSync(join(root, "public", "third-party-notices.txt"),
  "ESP32-C5 Spectrum web viewer: third-party software\n\n" +
  "This site is GPL-3.0 (https://github.com/jamesjulier/esp32c5-spectrum). It includes the\n" +
  "libraries below, each under its own licence. esptool-js includes Espressif's flasher stub\n" +
  "programs, which it loads onto the chip while flashing.\n\n" +
  "The firmware images it flashes have their own notices: THIRD-PARTY-NOTICES.md in the\n" +
  "repository." + rule + blocks.map((b) => b.text).join(rule) + "\n");
console.log(`third-party-notices.txt: ${blocks.map((b) => b.name).join(", ")}`);
