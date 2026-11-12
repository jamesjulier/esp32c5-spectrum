# CLAUDE.md

Notes for Claude Code (and anyone else) working in this repository. What the project is and how
to use it: [README.md](README.md). How it works and how to build it: [docs/technical.md](docs/technical.md).

## What is here

- `firmware/`: a patch to [ESP-SDR](https://github.com/ESPARGOS/esp-sdr) plus the on-screen UI
  component (`components/eng_spectrum_ui/`), built with ESP-IDF for the ESP32-C5.
- `web/`: the browser app (Vite + React PWA) that shows the spectrum and flashes boards. Published
  to GitHub Pages from `main` by `.github/workflows/pages.yml`.

## Rules

- **Credit ESP-SDR.** It is GPL-3.0, by Florian Euchner (ESPARGOS). Keep the credit in the README,
  the app footer and the Firmware tab. Every ESP-SDR file the patch changes carries a
  "Modified by …, 2026" line: add one when the patch touches a new file.
- **Never edit `firmware/esp-sdr/` and expect it to stay.** `build.sh` resets it to the pinned
  commit on every build. Change the patch instead: edit in `firmware/esp-sdr/`, then
  `git -C firmware/esp-sdr diff > firmware/patches/0001-local-display.patch`.
- **Settings come only from the `firmware/sdkconfig.*` files.** `build.sh` deletes the cached
  sdkconfig before each build.
- **Levels are dB above the noise floor, never dBm.** ESP-SDR's gain is not calibrated.
- **Receive only.** Nothing transmits after start-up. Do not add features that transmit.
- **Do not send `GPIO` writes to a board with a screen.** The screen uses those pins (our firmware
  refuses them, older builds did not).
- **Keep esptool-js at a version that has flashed a real board.** Test on hardware before a bump.
- British English in text.

## Commands

```sh
cd web && npm install && npm test && npm run build   # app: tests, then build into web/dist/
cd web && npm run dev                                # http://localhost:5173
bash firmware/build.sh [/dev/cu.usbmodemXXXX]        # firmware (BOARD=touch28|tdongle, STOCK=1)
```

The lock file is written with npm 10 (`npx npm@10 install`); CI runs `npm ci --ignore-scripts`.
Without a board, put a recording at `web/public/replay-board.json` (gitignored) and open
`/?replay=./replay-board.json`.

## Releasing

1. `git pull --rebase origin main` first.
2. Bump `version` in `web/package.json` (`npx npm@10 install` updates the lock) and commit.
3. Build the firmware images **last**, after the final rebase, because `manifest.json` records the
   commit they came from: `OUT=$PWD/web/public/firmware bash firmware/make-images.sh` (it refuses
   uncommitted firmware changes). Commit them, push, wait for the Pages deploy.
4. `gh release create vX.Y.Z --target <sha>` with the `.bin` files, `manifest.json` and
   `SHA256SUMS.txt`.

Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `build:`).
