# Technical notes

How esp32c5-spectrum works, how to build it, and what was learned on the bench. For using it, see
the [README](../README.md).

- [Repository layout](#repository-layout)
- [What is on the board's screen](#what-is-on-the-boards-screen)
- [How it measures](#how-it-measures)
- [A laptop can take over](#a-laptop-can-take-over)
- [Build and flash the firmware](#build-and-flash-the-firmware)
- [Work on the web app](#work-on-the-web-app)
- [Boards in detail](#boards-in-detail)
- [The patch to ESP-SDR](#the-patch-to-esp-sdr)
- [Panel lessons](#panel-lessons-waveshare-147)
- [Not done yet](#not-done-yet)

## Repository layout

```
firmware/
  build.sh                      fetch ESP-SDR at a pinned commit, patch it, build, optionally flash
  make-images.sh                build the release images and manifest.json
  patches/                      our additions to ESP-SDR (nothing of theirs is removed)
  components/eng_spectrum_ui/   the screen, button and touch UI (an ESP-IDF component)
  sdkconfig.*                   per-board settings
  tools/make_fonts.py           regenerates the anti-aliased font tables
web/                            the browser app: analyser and flasher over Web Serial
  public/firmware/              the release images the app flashes, with manifest.json
  tools/                        icon and licence-notice generators
docs/                           this file and the README images
```

## What is on the board's screen

- **Header:** the band, the frequency range, and PEAK HOLD or LIVE. On the 2.8" board, also the
  battery voltage (**BATT 3.94V**), read every 5 s. It is a voltage, not a percentage: on USB with
  no battery fitted the charger holds the line at about 4.2 V, so 4.2 V there means "full or not
  fitted".
- **Trace:** filled and coloured by height, from red at the noise floor to green at +36 dB, with
  grid lines every 12 dB. A running power average over about 4 sweeps.
- **Peak hold:** a grey line, the highest level seen since it was last cleared.
- **Waterfall:** one row every 0.5 s, each the power average of every sweep in it, newest at the top.
- **Wi-Fi channel marks** along the bottom.
- **Scorecard** (2.8"): each channel coloured by how much of the last minute its 20 MHz held energy
  6 dB or more above the floor (green under 10 %, then amber, orange, red from 60 %), and the
  quietest named ("Quietest ch 11 · 4% busy"; on 2.4 GHz only 1, 6 or 11 are considered).

The T-Dongle's small screen has one header line (band and PEAK or LIVE), a 40 px trace and about
8 s of waterfall.

### USB test commands

Answered before the viewer protocol, so they never hand over the radio: `SNAP` (a screenshot of
the panel), `TAP x y`, `DTAP`, `SWIPE L|R`, `HOLD`. A screenshot stops at the first send the host
does not read.

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
is bridged over (±6 bins, about ±0.5 MHz). Each slice is then measured against its own noise floor
(15th percentile, smoothed). Without that, a slice containing a strong access point came back
several dB higher across its whole width.

**Levels are relative: dB above the noise floor, never dBm.** ESP-SDR's gain is not calibrated,
and the receiver sets its gain per capture. A dBm figure would be an invented measurement.

**Captures are snapshots with gaps between them.** A burst shorter than the gap can be missed.

Measured on a 1.47" board: about 285 spectra a second; retune in 8 ms at 2.4 GHz and about 30 ms
at 5 GHz; an access point on channel 149/153 seen about 19 dB above the floor.

## A laptop can take over

The board checks its USB port between captures. When a host sends a command, the screen says
**PHONE CONNECTED** and ESP-SDR's own command loop serves the host exactly as the stock firmware
does, except that `GPIO` writes are refused (the screen uses those pins). After 10 s of silence it
restores its receiver settings and goes back to drawing.

- **This project's web app** draws the same picture as the board, with density and channel-busy views.
- **ESP-SDR's own viewer**, [espargos.net/espsdr/app](https://espargos.net/espsdr/app/), also works,
  in Chrome on a laptop (Web Serial) or on Android (WebUSB).

On Chrome for Android the app talks to the board over WebUSB instead of Web Serial, through
`web/src/lib/webusb.ts`, which presents the same port to the analyser.

Our builds add one command, **`ID?`**, which replies with the board's MAC and name, for example
`ID 02:00:00:C5:00:01 Waveshare ESP32-C5-LCD-1.47`. Every C5 shows the same USB name in a browser's
port picker, so without it a host cannot tell boards apart.

## Build and flash the firmware

```sh
cd firmware
bash build.sh                                       # Waveshare 1.47" (build/)
bash build.sh /dev/cu.usbmodemXXXX                  # build and flash
BOARD=touch28 bash build.sh /dev/cu.usbmodemXXXX    # Waveshare Touch-LCD-2.8 (build-touch28/)
BOARD=tdongle bash build.sh /dev/cu.usbmodemXXXX    # LilyGO T-Dongle-C5 (build-tdongle/)
STOCK=1 bash build.sh                               # stock ESP-SDR + ID?, no screen (build-stock/)
```

What `build.sh` needs:

- **ESP-IDF at commit `25fe69f9`** (v6.1-dev, the commit ESP-SDR pins in `firmware-targets.json`),
  at `~/esp/esp-idf-espsdr` (or set `IDF_DIR`), with `./install.sh esp32c5` run once. ESP-SDR
  drives undocumented radio registers, so another IDF is another experiment.
- **cmake and ninja** on `PATH`. If an ESP-IDF v5 install left copies under `~/.espressif/tools/`,
  `build.sh` uses those.

Every build fetches ESP-SDR at its full pinned commit (`f86da818…`) into `firmware/esp-sdr/`,
resets it to exactly that commit (**local edits there are discarded**: change the patch instead),
applies `patches/0001-local-display.patch`, and takes its settings only from the `sdkconfig.*`
files in git. To build from the mirror instead of upstream:
`ESP_SDR_REPO=https://github.com/jamesjulier/esp-sdr bash build.sh`.

To change the patch: edit the files in `firmware/esp-sdr/`, run `git -C firmware/esp-sdr diff >
firmware/patches/0001-local-display.patch`, then build.

### Release images

The web app flashes the images in `web/public/firmware/`. After a firmware change, commit it, then:

```sh
OUT=$PWD/web/public/firmware bash firmware/make-images.sh
```

It refuses to run with uncommitted firmware changes, because `manifest.json` records this
repository's commit and ESP-SDR's as the images' source.

### Two apps on one board

On the 2.8" board (32 MB flash) the analyser can share the board with another ESP-IDF app: that
app in OTA slot 0, the analyser in slot 1. Build with `ENG_OTHER_APP=<that app's PROJECT_NAME>
BOARD=touch28 bash build.sh` and a 3 s BOOT hold boots the other slot. Only a slot whose app has
that name is started, so a board flashed with the analyser alone ignores the hold.

## Work on the web app

```sh
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # the analyser maths and serial protocol
npm run build      # into web/dist/
```

It is published to GitHub Pages from `main` by `.github/workflows/pages.yml`. To try it without a
board, put a recording at `web/public/replay-bench.json` (gitignored) and open
`/?replay=./replay-bench.json`. A recording is `{ "<centre MHz>": [[1024 codes], …] }`. Replay files
must come from the same site.

The icons are drawn from `web/public/icon.svg` by `python3 web/tools/make_icons.py` (needs Chrome).
`favicon.svg` is a simplified version for 16–32 px.

## Boards in detail

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

## The patch to ESP-SDR

Additions only; each changed file is marked "Modified by James Julier, 2026".

- **`spectrum_snapshot()`:** the same capture, window, FFT, DC removal and power path as their
  `SPEC` command, with the mean detector. It returns the levels instead of sending them over USB.
- **`receiver.c`:** in local-display builds, start-up sets the widest bandwidth and hands control
  to `eng_spectrum_run()`. Between captures it polls USB and, when a host speaks, runs their command
  loop until 10 s of silence, refusing `GPIO` writes (`ERR gpio_reserved_by_display`; `GPIO?` still
  reads).
- **`MAX_FFT` 1024 in local-display builds.** Stock ESP-SDR leaves only about 1.2 KB of `.bss` before
  the 128 KB SRAM bank its C5 captures own, and its linker guard fails the build if anything grows
  into it. Halving the FFT buffers frees about 13 KB. The screen's SPI and DMA interrupt code is
  also kept out of IRAM, and the optional UART command port is off, so USB is the only one
  (`sdkconfig.waveshare`).
- **`ID?`**, when built with `-DBOARD_NAME=…` (`build.sh` sets it for every board).

## Panel lessons (Waveshare 1.47")

- **Colour order is BGR**, although Waveshare's BSP says RGB. Proven with a test card.
- **Pixels go out byte-swapped** (RGB565 big-endian).
- **The factory panel settings cannot show black;** it comes out a washed pink-grey. We send the
  voltage and gamma settings LovyanGFX uses (`eng_lcd.c`).
- **Rounded corners clip text,** so the header sits about 10 px in from the edges.

## Not done yet

- **Network names on the overlay.** That needs a Wi-Fi scan, and the radio is busy being the analyser.
- **The 2.8" in the release images and the web app's Firmware tab.** It is built and flashed with
  `build.sh`.
- **Flashing from Android.** The analyser runs on Chrome for Android over WebUSB (`web/src/lib/webusb.ts`);
  flashing still needs Web Serial on a computer. iPhones can use neither.
