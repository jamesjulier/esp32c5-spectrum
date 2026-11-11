// SPDX-License-Identifier: GPL-3.0-or-later
// A 5x7 pixel font with only the characters this screen writes: digits, a few
// symbols, capitals and "c h k z". Anything else draws as a blank.
#pragma once
#include <stdint.h>

// Rows top to bottom; bit 4 is the leftmost pixel. Returns NULL for a blank.
const uint8_t *eng_font_glyph(char c);

// Width in pixels of `s` at `scale` (6 px per character at scale 1).
int eng_font_width(const char *s, int scale);
