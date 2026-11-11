# esp32c5-spectrum

By James Julier.

**Open the viewer: https://jamesjulier.github.io/esp32c5-spectrum/** (Chrome or Edge on a computer)

A pocket 2.4 GHz and 5 GHz spectrum analyser on an ESP32-C5 board with a screen. No laptop and
no extra radio hardware: the ESP32-C5's own Wi-Fi receiver does the measuring. It shows RF
energy that is not Wi-Fi, such as microwave ovens, video senders and Bluetooth, next to the
Wi-Fi channels it lands on.

Supported boards:

| Board | Screen | Notes |
|---|---|---|
| **Waveshare ESP32-C5-LCD-1.47** | 320 × 172, read sideways | BOOT button only |
| **Waveshare ESP32-C5-Touch-LCD-2.8** | 240 × 320, upright | Touch gestures, battery voltage |
| **LilyGO T-Dongle-C5** | 160 × 80, read sideways | A USB stick; also a good radio for the web viewer |
| **Seeed XIAO ESP32-C5** | none | Stock ESP-SDR over USB, for the web viewer |

It is built on [ESP-SDR](https://github.com/ESPARGOS/esp-sdr) by ESPARGOS, which reads raw radio
samples from the ESP32's own receiver through an undocumented debug path. This repository adds
a screen, a button and touch on top of it, as a patch plus one ESP-IDF component.

> [!WARNING]
> **Receive only.** Nothing is transmitted after start-up (the radio chip may emit a brief
> internal calibration tone as it powers up). Newer ESP-SDR forks can transmit, which is not
> licensed outside the Wi-Fi rules. Do not add it.

## Licence

Copyright © 2026 James Julier. **GPL-3.0** (see `LICENSE`), because ESP-SDR is GPL-3.0. Third-party parts and their licences are in
`THIRD-PARTY-NOTICES.md`. The fonts in the firmware are SIL OFL 1.1
(see `FONTS-LICENCE.md`).

ESP-SDR itself is not in this repository. `firmware/build.sh` fetches it at a pinned commit (the full 40-character id) and
applies `firmware/patches/0001-local-display.patch`. Anyone given a board running this firmware is
entitled to its source: this repository plus ESP-SDR at that commit.

## Repository layout

```
firmware/
  build.sh                 fetch ESP-SDR, patch it, build, optionally flash
  make-images.sh           build the release images and a manifest into firmware/dist/
  patches/                 our additions to ESP-SDR (nothing of theirs is changed)
  components/eng_spectrum_ui/   the screen, button and touch UI (ESP-IDF component)
  sdkconfig.*              per-board settings
  tools/make_fonts.py      regenerates the anti-aliased font tables
web/                       browser viewer and flasher (Web Serial), an installable app
```

## What is on screen

- **Header:** the band, the frequency range, and PEAK HOLD or LIVE. On the 2.8" board, also the
  battery voltage (**BATT 3.94V**), read every 5 s. It is a voltage, not a percentage: on USB
  with no battery fitted the charger holds the line at about 4.2 V, so 4.2 V there means "full
  or not fitted".
- **Trace:** filled and coloured by height, from red at the noise floor to green at +36 dB, with
  grid lines every 12 dB. A running power average over about 4 sweeps.
- **Peak hold:** a grey line, the highest level seen since it was last cleared.
- **Waterfall:** one row every 0.5 s, each the power average of every sweep in it, newest at the
  top.
- **Wi-Fi channel marks** along the bottom.

**Levels are relative: dB above the noise floor, never dBm.** ESP-SDR's gain is not calibrated,
and each 32 MHz slice is measured against its own floor because the receiver sets its gain per
capture. A dBm figure would be an invented measurement.

The T-Dongle's small screen has one header line (band and PEAK or LIVE), a 40 px trace and about
8 s of waterfall.

### Button (BOOT)

| Press | Does |
|---|---|
| Short | Next view: 2.4 GHz, then 5 GHz ch 36–64, ch 100–144, ch 149–165 |
| Double | Peak hold on or off (cleared each time) |
| Hold 3 s | Switch to a companion app in the other OTA slot, if built with one (see below) |

### Touch, on the 2.8"

| Gesture | Does |
|---|---|
| Swipe left / right | Next / previous band |
| Tap the trace or waterfall | Marker: frequency, channel and level ("2437 MHz · ch 6 · +24 dB"); tap again to clear |
| Tap the header | Wi-Fi channel overlay on or off: each channel's mask as a coloured outline |
| Tap the channel strip | Zoom to 40 MHz around that channel; tap again to zoom out |
| Double tap | Peak hold on or off |
| Hold 1 s | Freeze; FROZEN shows in amber |

Under the channel numbers is a **scorecard**: each channel coloured by how much of the last
minute its 20 MHz held energy 6 dB or more above the floor (green under 10 %, then amber,
orange, red from 60 %), and the quietest named ("Quietest ch 11 · 4% busy"; on 2.4 GHz only 1, 6
or 11 are considered).

### USB test commands

Answered before the viewer protocol, so they never hand over the radio: `SNAP` (a screenshot of the
panel), `TAP x y`, `DTAP`, `SWIPE L|R`, `HOLD`.

## A laptop or phone can take over

The board checks its USB port between captures. When a host sends a command, the screen says
**PHONE CONNECTED** and ESP-SDR's own command loop serves the host exactly as the stock firmware
does. After 10 s of silence it restores its receiver settings and goes back to drawing.

- **ESP-SDR's own viewer**, [espargos.net/espsdr/app](https://espargos.net/espsdr/app/), works in
  Chrome on a laptop (Web Serial) or on Android (WebUSB).
- **This repository's viewer** (below) draws the same picture as the board, with density and
  channel-busy views.

Our builds add one command, **`ID?`**, which replies with the board's MAC and name, for example
`ID 00:11:22:33:44:55 Waveshare ESP32-C5-LCD-1.47`. Every C5 shows the same USB name in a
browser's port picker, so without it a host cannot tell boards apart.

## The web viewer

`web/` is a browser app, published to GitHub Pages from `main` by `.github/workflows/pages.yml`.
It needs **Chrome or Edge on a computer**, because it talks to the board over Web Serial.
Safari, Firefox and phones cannot.

- **Analyser:** **Connect board**, pick **USB JTAG/serial debug unit**, and it takes the radio
  over. **Live** shows the trace and waterfall, with Peak hold and Average lines, the detector
  (Average or Peak), row length and block size. **Density** shows how often each level is reached
  at each frequency. **Channels** shows the busy share of each Wi-Fi channel. Hover or use the
  arrow keys to read a frequency, double-click a chart to enlarge it, and **Save picture** saves
  what is on screen.
- **Firmware:** flashes a board from the browser with the images in `web/public/firmware/`,
  checking each one's SHA-256 before writing.

**Install it as a desktop app:** open the viewer in Chrome or Edge and choose **Install** in the
address bar. It gets its own window and icon, and works offline, flashing included.

To work on it:

```sh
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # the analyser maths and serial protocol
npm run build      # into web/dist/
```

To try it without a board, put a recording at `web/public/replay-bench.json` (gitignored) and
open `/?replay=./replay-bench.json`. A recording is `{ "<centre MHz>": [[1024 codes], …] }`.

After changing the firmware, rebuild the images the viewer serves, after committing (the manifest
records the commit):

```sh
OUT=$PWD/web/public/firmware bash firmware/make-images.sh
```

## How it measures

Each capture is taken at 80 MS/s with a 1024-point FFT (78 kHz per bin), using the receiver's
widest analog bandwidth (about 48 MHz). Only the middle **32 MHz** of each capture is used,
because the edges are weaker and showed as stripes. Views are stitched from slices:

| View | Range | Slices |
|---|---|---|
| 2.4 GHz | 2402–2482 MHz | 3 |
| 5 GHz ch 36–64 | 5170–5330 MHz | 5 |
| 5 GHz ch 100–144 | 5490–5730 MHz | 8 |
| 5 GHz ch 149–165 | 5735–5855 MHz | 4 |

Each slice is the power average of 16 snapshots. The receiver's own spike at each slice's centre
is bridged over (±6 bins, about ±0.5 MHz). Each slice is then measured against its own noise
floor (15th percentile, smoothed). Without that, a slice containing a strong access point came
back several dB higher across its whole width.

**Captures are snapshots with gaps between them.** A burst shorter than the gap can be missed.

Measured on a 1.47" board: about 285 spectra a second; retune in 8 ms at 2.4 GHz and about 30 ms
at 5 GHz; an access point on channel 149/153 seen about 19 dB above the floor.

## Build and flash

```sh
cd firmware
bash build.sh                                       # Waveshare 1.47" (build/)
bash build.sh /dev/cu.usbmodemXXXX                  # build and flash
BOARD=touch28 bash build.sh /dev/cu.usbmodemXXXX    # Waveshare Touch-LCD-2.8 (build-touch28/)
BOARD=tdongle bash build.sh /dev/cu.usbmodemXXXX    # LilyGO T-Dongle-C5 (build-tdongle/)
STOCK=1 bash build.sh                               # stock ESP-SDR + ID?, no screen (build-stock/)
bash make-images.sh                                 # merged release images + manifest.json in dist/
```

What `build.sh` needs:

- **ESP-IDF at commit `25fe69f9`** (v6.1-dev, the commit ESP-SDR pins in
  `firmware-targets.json`), at `~/esp/esp-idf-espsdr` (or set `IDF_DIR`), with
  `./install.sh esp32c5` run once. ESP-SDR drives undocumented radio registers, so another IDF
  is another experiment.
- **cmake and ninja** on `PATH`. If an ESP-IDF v5 install left copies under
  `~/.espressif/tools/`, `build.sh` uses those.

`build.sh` fetches ESP-SDR at commit `f86da818…` into `firmware/esp-sdr/`, resets it to exactly that
commit (any local edits there are discarded), applies the patch, and
builds with `ESP_SDR_LOCAL_DISPLAY=ON`. Flashing replaces whatever the board was running.

### Two apps on one board

On the 2.8" board (32 MB flash) the analyser can share the board with another ESP-IDF app: that
app in OTA slot 0, the analyser in slot 1. Build with `ENG_OTHER_APP=<that app's PROJECT_NAME>
BOARD=touch28 bash build.sh` and a 3 s BOOT hold boots the other slot. Only a slot whose app has
that name is started, so a board flashed with the analyser alone ignores the hold.

### Boards

| | ESP32-C5-LCD-1.47 | ESP32-C5-Touch-LCD-2.8 | LilyGO T-Dongle-C5 |
|---|---|---|---|
| Shown | 320 × 172, sideways | 240 × 320, upright: 120 px trace, 142-row waterfall | 160 × 80, sideways: 40 px trace, 17-row waterfall |
| Panel | ST7789 | ST7789 | ST7735 (esp_lcd's ST7789 driver plus LilyGO's power and gamma settings), 20 MHz SPI, gap 1/26 |
| Panel reset, backlight | ESP pins | CH32V003 expander on I2C 0x24 (SDA 0, SCL 1): EXIO1 reset, reg 0x05 backlight | ESP pins: SCK 6, MOSI 2, CS 10, DC 3, RST 1, backlight 0 (active low) |
| Battery | none | CH32 reg 0x06, VBAT ÷ 3 (200K/100K) | none |
| Colour order | BGR | RGB | BGR |
| Flash | 4 MB | 32 MB | 16 MB |
| Touch | none | CST3530 | none. The APA102 LED (4/5) is sent off; the SD slot's CS (23) is held high |

The T-Dongle's pins come from LilyGO's `pin_config.h`
([Xinyuan-LilyGO/T-Dongle-C5](https://github.com/Xinyuan-LilyGO/T-Dongle-C5)).

## The patch to ESP-SDR (additions only)

- **`spectrum_snapshot()`:** the same capture, window, FFT, DC removal and power path as their
  `SPEC` command, with the mean detector. It returns the levels instead of sending them over USB.
- **`receiver.c`:** in local-display builds, start-up sets the widest bandwidth and hands control
  to `eng_spectrum_run()`. Between captures it polls USB and, when a host speaks, runs their
  command loop until 10 s of silence.
- **`MAX_FFT` 1024 in local-display builds.** Stock ESP-SDR leaves only about 1.2 KB of `.bss`
  before the 128 KB SRAM bank its C5 captures own, and its linker guard fails the build if
  anything grows into it. Halving the FFT buffers frees about 13 KB. The screen's SPI and DMA
  interrupt code is also kept out of IRAM (`sdkconfig.waveshare`).
- **`ID?`**, when built with `-DBOARD_NAME=…` (`build.sh` sets it for every board).
- **No `GPIO` writes while a host has the radio.** The screen, touch, backlight and BOOT button use
  the pins ESP-SDR's `GPIO` command frees up, so the screen builds answer `ERR gpio_reserved_by_display`.
  `GPIO?` still reads them. The screen builds also turn off ESP-SDR's optional UART port, so USB is the
  only command port.

To build from the mirror instead of upstream: `ESP_SDR_REPO=https://github.com/jamesjulier/esp-sdr bash build.sh`.

## Panel lessons (Waveshare 1.47")

- **Colour order is BGR**, although Waveshare's BSP says RGB. Proven with a test card.
- **Pixels go out byte-swapped** (RGB565 big-endian).
- **The factory panel settings cannot show black;** it comes out a washed pink-grey. We send the
  voltage and gamma settings LovyanGFX uses (`eng_lcd.c`).
- **Rounded corners clip text,** so the header sits about 10 px in from the edges.

## Not done yet

- **Network names on the overlay.** That needs a Wi-Fi scan, and the radio is busy being the
  analyser.
- **The 2.8" in the release images and the Firmware tab.** `make-images.sh` builds the 1.47",
  the T-Dongle and the XIAO. The 2.8" is built and flashed with `build.sh`.
- **WebUSB for Android** in the web viewer. iPhones cannot use either.

## Credits

Written by James Julier.

- **[ESP-SDR](https://github.com/ESPARGOS/esp-sdr) by Florian Euchner (ESPARGOS)**, which does all the
  radio work. This project is a modified version of it: our changes are the patch in `firmware/patches/`
  (marked "Modified by James Julier, 2026" in each file it touches) and the component in
  `firmware/components/`. A mirror of the exact version used is kept at
  [jamesjulier/esp-sdr](https://github.com/jamesjulier/esp-sdr/tree/esp32c5-spectrum-base).
- **Espressif**: ESP-IDF, esp-dsp and esptool-js.
- **LovyanGFX**, **LilyGO** and **Waveshare**, whose published panel settings, pin maps and touch protocol
  the screen code uses.
- **[Inter](https://github.com/rsms/inter)** and **[Manrope](https://github.com/sharanda/manrope)** fonts.

Every third-party component and its licence: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
