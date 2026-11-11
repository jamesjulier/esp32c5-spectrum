// SPDX-License-Identifier: GPL-3.0-or-later
// Anti-aliased text for the 2.8" board (tools/make_fonts.py makes the tables).
// Glyphs are 8-bit coverage, blended onto whatever is already in the strip.
#pragma once
#include <stdint.h>

typedef struct {
    uint8_t  w, h;        // bitmap size
    int8_t   left, top;   // pen x to bitmap left; baseline to bitmap top (up is +)
    uint8_t  adv;         // pen advance
    uint32_t off;         // into the font's coverage bytes
} eng_glyph_t;

typedef struct {
    const eng_glyph_t *g;     // ASCII 0x20-0x7E, then U+00B7 (middle dot), U+2014 (em dash)
    const uint8_t     *px;
    uint8_t            ascent; // baseline below the top of a line
    uint8_t            size;   // nominal pixel size, the line height to leave
} eng_aa_font_t;

extern const eng_aa_font_t eng_font_title;   // Manrope Bold 18
extern const eng_aa_font_t eng_font_text;    // Inter Medium 13
extern const eng_aa_font_t eng_font_label;   // Inter Medium 11
