// SPDX-License-Identifier: GPL-3.0-or-later
// Spectrum view: ESP-SDR (ESPARGOS, GPL-3.0) drawn on the
// Waveshare ESP32-C5-LCD-1.47's own screen, with no host. See ../../README.md.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

// Tune the receiver to `mhz` (whole MHz) and recalibrate it.
typedef void (*eng_tune_fn)(unsigned mhz);
// One max-hold spectrum of `ffts` snapshots at sample-rate code `rate` with an
// n-point FFT. `codes` gets n bytes in natural FFT order (bin 0 = the tuned
// frequency), each 2 x dB on ESP-SDR's uncalibrated scale.
typedef bool (*eng_spectrum_fn)(unsigned rate, unsigned n, unsigned ffts, uint8_t *codes);

// A phone or laptop running ESP-WebSDR may take the radio over USB at any time.
// host_waiting() is polled between captures; when it returns true, the screen
// says so and host_serve() runs until the host has gone quiet, restoring the
// receiver's settings before it returns.
typedef bool (*eng_host_waiting_fn)(void);
typedef void (*eng_host_serve_fn)(void);

// The screen's own USB commands, answered without handing the radio to a host:
//   SNAP          print the next full frame (tools/snap.py makes a PNG of it)
//   TAP x y       a tap at screen pixel (x, y); DTAP a double tap
//   SWIPE L|R     a swipe; HOLD a 1 s press (freeze)
// The gestures are the touch screen's, for testing a layout without a finger.
// Returns true when `line` was one of these. `send` writes to the USB port.
typedef bool (*eng_send_fn)(const void *data, size_t size);
bool eng_spectrum_local_command(const char *line, eng_send_fn send);

// Runs the screen, the button and the sweep. Does not return.
void eng_spectrum_run(eng_tune_fn tune, eng_spectrum_fn spectrum,
                      eng_host_waiting_fn host_waiting, eng_host_serve_fn host_serve);

#ifdef __cplusplus
}
#endif
