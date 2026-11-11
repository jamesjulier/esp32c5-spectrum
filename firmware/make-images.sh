#!/usr/bin/env bash
# Build the release images and write them, with a manifest, to dist/.
#
#   waveshare-c5-lcd-spectrum.bin   on-screen spectrum + USB hand-over
#   tdongle-c5-spectrum.bin         the same for the LilyGO T-Dongle-C5
#   xiao-c5-esp-sdr.bin             ESP-SDR as published plus ID?, for a XIAO (USB only)
#
# Each is ONE merged image written at 0x0 (esptool merge-bin). Writing from 0x0
# erases whatever the board held before, including its NVS.
#
# ESP-SDR is GPL-3.0. The manifest records the exact ESP-SDR commit and the
# commit of this repository's patch, which is how anyone given an image gets
# its source.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$HERE/dist}"
# The manifest names this repository's commit as the source of the images, so
# that commit must hold exactly what is built: no uncommitted firmware changes.
if [ -n "$(git -C "$HERE" status --porcelain -- .)" ]; then
    echo "firmware/ has uncommitted changes: commit them first" >&2
    git -C "$HERE" status --short -- . >&2; exit 1
fi
mkdir -p "$OUT"
bash "$HERE/build.sh"
BOARD=tdongle bash "$HERE/build.sh"
STOCK=1 bash "$HERE/build.sh"

IDF_DIR="${IDF_DIR:-$HOME/esp/esp-idf-espsdr}"
# shellcheck disable=SC1091
. "$IDF_DIR/export.sh" >/dev/null
merge() {   # build dir, output name
    ( cd "$1" && python -m esptool --chip esp32c5 merge-bin -o "$OUT/$2" @flash_args >/dev/null )
}
merge "$HERE/build"         waveshare-c5-lcd-spectrum.bin
merge "$HERE/build-tdongle" tdongle-c5-spectrum.bin
merge "$HERE/build-stock"   xiao-c5-esp-sdr.bin

SDR_COMMIT="$(git -C "$HERE/esp-sdr" rev-parse HEAD)"
OUR_COMMIT="$(git -C "$HERE" rev-parse HEAD)"
VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$HERE/../web/package.json")"
python3 - "$OUT" "$SDR_COMMIT" "$OUR_COMMIT" "$VERSION" <<'PY'
import hashlib, json, os, sys, datetime
out, sdr, ours, version = sys.argv[1:5]
def entry(name, board, label, flash, kind):
    p = os.path.join(out, name); b = open(p, "rb").read()
    return {"board": board, "label": label, "file": name, "chip": "esp32c5", "offset": "0x0",
            "flash_size": flash, "kind": kind, "bytes": len(b), "sha256": hashlib.sha256(b).hexdigest()}
m = {
  "version": version,
  "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
  "esp_sdr": {"repo": "https://github.com/ESPARGOS/esp-sdr", "mirror": "https://github.com/jamesjulier/esp-sdr",
              "commit": sdr, "licence": "GPL-3.0", "author": "Florian Euchner (ESPARGOS)"},
  "patch": {"repo": "https://github.com/jamesjulier/esp32c5-spectrum", "path": "firmware/patches/0001-local-display.patch",
            "commit": ours, "licence": "GPL-3.0"},
  "images": [
    entry("waveshare-c5-lcd-spectrum.bin", "waveshare-c5-lcd-1.47", "Waveshare ESP32-C5-LCD-1.47", "4MB", "spectrum-on-screen"),
    entry("tdongle-c5-spectrum.bin", "lilygo-t-dongle-c5", "LilyGO T-Dongle-C5", "16MB", "spectrum-on-screen"),
    entry("xiao-c5-esp-sdr.bin", "xiao-esp32c5", "XIAO ESP32-C5", "2MB", "esp-sdr-stock"),
  ],
}
json.dump(m, open(os.path.join(out, "manifest.json"), "w"), indent=2)
print(json.dumps(m, indent=2))
PY
