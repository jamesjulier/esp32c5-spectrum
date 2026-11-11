#!/usr/bin/env bash
# Build (and optionally flash) the spectrum analyser firmware for the Waveshare
# ESP32-C5-LCD-1.47 (default), the Touch-LCD-2.8 or the LilyGO T-Dongle-C5.
#
#   bash build.sh                 build
#   bash build.sh /dev/cu.usbmodemXXXX   build and flash
#   BOARD=touch28 bash build.sh    for the Waveshare ESP32-C5-Touch-LCD-2.8;
#                                   build dir build-touch28/
#   BOARD=tdongle bash build.sh    for the LilyGO T-Dongle-C5;
#                                   build dir build-tdongle/
#   ENG_OTHER_APP=name             (touch28) a 3 s BOOT hold boots the app
#                                   of that PROJECT_NAME in the other OTA slot
#   STOCK=1 bash build.sh          stock ESP-SDR behaviour (no screen, USB only),
#                                   for a XIAO ESP32-C5; build dir build-stock/
#
# ESP-SDR is fetched, not committed, at the commit this was tested with, and
# built with the exact ESP-IDF commit it pins (firmware-targets.json): it drives
# undocumented radio registers, so a different IDF is a different experiment.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Upstream, or the mirror kept so the source of published images stays available:
# ESP_SDR_REPO=https://github.com/jamesjulier/esp-sdr bash build.sh
ESP_SDR_REPO="${ESP_SDR_REPO:-https://github.com/ESPARGOS/esp-sdr}"
# The full commit id, never an abbreviation: a short prefix can be matched by a
# different commit pushed later. Tested on hardware, 2026-10-20.
ESP_SDR_COMMIT="f86da81807b7f6e850742f6b789d9468c190ad41"
IDF_COMMIT="25fe69f946311abdaf9ad56591f25fedbc20ac98"
IDF_DIR="${IDF_DIR:-$HOME/esp/esp-idf-espsdr}"
SRC="$HERE/esp-sdr"

# Every build starts from exactly the pinned commit with only our patch on top.
# A stale or edited copy would build images whose manifest names source they
# were not built from. Submodules (esp-dsp) follow the commit's own pins.
if [ ! -d "$SRC/.git" ]; then
    git init -q "$SRC"
    git -C "$SRC" remote add origin "$ESP_SDR_REPO"
fi
if ! git -C "$SRC" cat-file -e "$ESP_SDR_COMMIT^{commit}" 2>/dev/null; then
    git -C "$SRC" fetch -q --depth 1 "$ESP_SDR_REPO" "$ESP_SDR_COMMIT"
fi
git -C "$SRC" checkout -q --force --detach "$ESP_SDR_COMMIT"
git -C "$SRC" clean -qfdx
if [ "$(git -C "$SRC" rev-parse HEAD)" != "$ESP_SDR_COMMIT" ]; then
    echo "ESP-SDR is not at $ESP_SDR_COMMIT" >&2; exit 1
fi
git -C "$SRC" submodule update -q --init --force --depth 1
git -C "$SRC" submodule foreach -q 'git clean -qfdx'
git -C "$SRC" apply "$HERE"/patches/*.patch
if [ ! -d "$IDF_DIR/.git" ] || [ "$(git -C "$IDF_DIR" rev-parse HEAD)" != "$IDF_COMMIT" ]; then
    echo "ESP-IDF $IDF_COMMIT is needed at $IDF_DIR (see README.md)" >&2; exit 1
fi

# This IDF expects cmake and ninja on PATH; reuse the copies the v5.5.5
# toolchain installed rather than installing more system-wide.
CMAKE_BIN="$(ls -d "$HOME"/.espressif/tools/cmake/*/CMake.app/Contents/bin 2>/dev/null | tail -1)"
NINJA_BIN="$(ls -d "$HOME"/.espressif/tools/ninja/*/ 2>/dev/null | tail -1)"
export PATH="$CMAKE_BIN:$NINJA_BIN:$PATH"
# shellcheck disable=SC1091
. "$IDF_DIR/export.sh" >/dev/null

cd "$SRC"
DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32c5"
SCREEN=(-DEXTRA_COMPONENT_DIRS="$HERE/components" -DESP_SDR_LOCAL_DISPLAY=ON)
if [ -n "${STOCK:-}" ]; then
    # Without ESP_SDR_LOCAL_DISPLAY this is ESP-SDR as published (2048-point
    # FFTs, USB/UART command loop), 2 MB image header, plus one addition: the
    # ID? command, so a host page can name the board it is talking to.
    B="$HERE/build-stock"
    ARGS=(-DESP_SDR_LOCAL_DISPLAY=OFF "-DBOARD_NAME=XIAO ESP32-C5")
elif [ "${BOARD:-}" = touch28 ]; then
    B="$HERE/build-touch28"
    DEFAULTS="$DEFAULTS;$HERE/sdkconfig.waveshare;$HERE/sdkconfig.touch28"
    ARGS=("${SCREEN[@]}" -DENG_BOARD=touch28 "-DENG_OTHER_APP=${ENG_OTHER_APP:-}"
          "-DBOARD_NAME=Waveshare ESP32-C5-Touch-LCD-2.8")
elif [ "${BOARD:-}" = tdongle ]; then
    B="$HERE/build-tdongle"
    DEFAULTS="$DEFAULTS;$HERE/sdkconfig.waveshare;$HERE/sdkconfig.tdongle"
    ARGS=("${SCREEN[@]}" -DENG_BOARD=tdongle "-DBOARD_NAME=LilyGO T-Dongle-C5")
else
    B="$HERE/build"
    DEFAULTS="$DEFAULTS;$HERE/sdkconfig.waveshare"
    ARGS=("${SCREEN[@]}" "-DBOARD_NAME=Waveshare ESP32-C5-LCD-1.47")
fi
# Settings come only from the sdkconfig files in git: a kept sdkconfig would
# override a changed default and build an image the repository does not describe.
rm -f "$B/sdkconfig"
idf.py -B "$B" -DIDF_TARGET=esp32c5 -DSDKCONFIG="$B/sdkconfig" "-DSDKCONFIG_DEFAULTS=$DEFAULTS" "${ARGS[@]}" build
if [ -n "${1:-}" ]; then idf.py -B "$B" -p "$1" flash; fi
