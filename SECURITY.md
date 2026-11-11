# Security

## Reporting a problem

Please report security problems privately, through GitHub's
[**Report a vulnerability**](https://github.com/jamesjulier/esp32c5-spectrum/security/advisories/new)
form, rather than in a public issue. I aim to reply within a week.

Problems in ESP-SDR itself belong with [ESPARGOS/esp-sdr](https://github.com/ESPARGOS/esp-sdr).

## What to expect from this project

- **Receive only.** No command in this firmware makes the radio transmit. The radio chip may
  emit a brief internal calibration tone at power-up.
- **Anyone with the USB port has the board.** The firmware is built without secure boot or flash
  encryption, so anyone who can plug into the board can reflash it. Do not leave a board where
  untrusted people can reach its USB port and rely on it. Even so, the screen builds refuse
  `GPIO` writes while a host has the radio, and a screenshot stops as soon as the host stops reading.
- **The web viewer runs in your browser only.** It talks to a board you choose in Chrome's port
  picker and sends nothing anywhere else. Firmware images are checked against their SHA-256 before
  they are written.
