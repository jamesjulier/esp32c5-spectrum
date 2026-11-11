// SPDX-License-Identifier: GPL-3.0-or-later
// The screen. Two boards:
//   - Waveshare ESP32-C5-LCD-1.47 (default): ST7789, 172x320, used sideways,
//     320 x 172, so frequency runs along the long edge
//   - Waveshare ESP32-C5-Touch-LCD-2.8 (ENG_BOARD_TOUCH28): ST7789, 240x320,
//     upright, the same way up as the board is held, with a LiPo whose voltage it can read
//   - LilyGO T-Dongle-C5 (ENG_BOARD_TDONGLE): ST7735, 80x160, used sideways,
//     160 x 80, a USB stick that plugs into the engineer's laptop
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#if defined(ENG_BOARD_TOUCH28)
#define LCD_W 240
#define LCD_H 320
#elif defined(ENG_BOARD_TDONGLE)
#define LCD_W 160
#define LCD_H 80
#else
#define LCD_W 320
#define LCD_H 172
#endif

void eng_lcd_init(void);
// Push a w x h block of RGB565 pixels (host byte order) at (x, y).
void eng_lcd_push(int x, int y, int w, int h, const uint16_t *px);
// Battery voltage in volts, or a negative number when the board cannot read
// one. On USB with no battery fitted the charger holds this at about 4.2 V, so
// 4.2 V on USB means "full or not fitted" (bench, 2026-10-21).
float eng_lcd_battery_v(void);

#ifdef ENG_BOARD_TOUCH28
#include "driver/i2c_master.h"
// The I2C bus the CH32 is on, which the touch chip shares. NULL before init.
i2c_master_bus_handle_t eng_lcd_i2c_bus(void);
#endif

// Screenshot: while on, every eng_lcd_push() row is also written to `send` as
// hex RGB565 (big-endian), between "SNAP BEGIN w h" and "SNAP END".
typedef bool (*eng_lcd_send_fn)(const void *data, size_t size);
void eng_lcd_snap(eng_lcd_send_fn send, bool on);

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b)
{
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
