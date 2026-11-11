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
ESP_SDR_REPO="https://github.com/ESPARGOS/esp-sdr"
ESP_SDR_COMMIT="f86da81"            # tested on hardware, 2026-10-20
IDF_COMMIT="25fe69f946311abdaf9ad56591f25fedbc20ac98"
IDF_DIR="${IDF_DIR:-$HOME/esp/esp-idf-espsdr}"
SRC="$HERE/esp-sdr"

if [ ! -d "$SRC/.git" ]; then
    git clone -q "$ESP_SDR_REPO" "$SRC"
    git -C "$SRC" checkout -q "$ESP_SDR_COMMIT"
    git -C "$SRC" submodule update --init --depth 1 -q
    git -C "$SRC" apply "$HERE"/patches/*.patch
fi
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
if [ -n "${STOCK:-}" ]; then
    # Without ESP_SDR_LOCAL_DISPLAY this is ESP-SDR as published (2048-point
    # FFTs, USB/UART command loop), 2 MB image header, plus one addition: the
    # ID? command, so a host page can name the board it is talking to.
    B="$HERE/build-stock"
    idf.py -B "$B" -DIDF_TARGET=esp32c5 -DSDKCONFIG="$B/sdkconfig" \
        "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.esp32c5" \
        -DESP_SDR_LOCAL_DISPLAY=OFF "-DBOARD_NAME=XIAO ESP32-C5" build
elif [ "${BOARD:-}" = touch28 ]; then
    B="$HERE/build-touch28"
    idf.py -B "$B" -DIDF_TARGET=esp32c5 -DSDKCONFIG="$B/sdkconfig" \
        "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.esp32c5;$HERE/sdkconfig.waveshare;$HERE/sdkconfig.touch28" \
        -DEXTRA_COMPONENT_DIRS="$HERE/components" -DESP_SDR_LOCAL_DISPLAY=ON -DENG_BOARD=touch28 "-DENG_OTHER_APP=${ENG_OTHER_APP:-}" \
        "-DBOARD_NAME=Waveshare ESP32-C5-Touch-LCD-2.8" build
elif [ "${BOARD:-}" = tdongle ]; then
    B="$HERE/build-tdongle"
    idf.py -B "$B" -DIDF_TARGET=esp32c5 -DSDKCONFIG="$B/sdkconfig" \
        "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.esp32c5;$HERE/sdkconfig.waveshare;$HERE/sdkconfig.tdongle" \
        -DEXTRA_COMPONENT_DIRS="$HERE/components" -DESP_SDR_LOCAL_DISPLAY=ON -DENG_BOARD=tdongle \
        "-DBOARD_NAME=LilyGO T-Dongle-C5" build
else
    B="$HERE/build"
    idf.py -B "$B" -DIDF_TARGET=esp32c5 -DSDKCONFIG="$B/sdkconfig" \
        "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.esp32c5;$HERE/sdkconfig.waveshare" \
        -DEXTRA_COMPONENT_DIRS="$HERE/components" -DESP_SDR_LOCAL_DISPLAY=ON \
        "-DBOARD_NAME=Waveshare ESP32-C5-LCD-1.47" build
fi
if [ -n "${1:-}" ]; then idf.py -B "$B" -p "$1" flash; fi
