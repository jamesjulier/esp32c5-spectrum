// SPDX-License-Identifier: GPL-3.0-or-later
// Spectrum view, drawn on the Waveshare ESP32-C5-LCD-1.47 or
// ESP32-C5-Touch-LCD-2.8, or the LilyGO T-Dongle-C5 (eng_lcd.h).
//
//   ┌──────────────────────────────────────┐
//   │ 2.4 GHz            2402-2482 MHz PEAK │  header
//   │  live trace (filled), peak hold line  │  80 px, about 0.6 dB per pixel
//   │  waterfall, newest at the top         │  60 sweeps
//   │  1    6    11            channel marks│
//   └──────────────────────────────────────┘
//
// Button (BOOT, GPIO28): short press = next view, double press = peak hold on
// or off (and cleared).
//
// Levels are RELATIVE. ESP-SDR's gain is not calibrated in dB, so the scale is
// "dB above this view's noise floor", never dBm: printing a dBm figure would
// be inventing a measurement.
#include "eng_spectrum_ui.h"
#include "eng_font.h"
#include "eng_font_aa.h"
#include "eng_lcd.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

// ─── Capture plan ─────────────────────────────────────────────────────────────
// 80 MS/s, 1024-point FFT (78 kHz per bin). The C5's widest analog setting is
// about 48 MHz, but its edges are weaker: at 40 MHz per segment the seams showed
// as stripes in the waterfall (bench, 2026-10-20). So only the middle 32 MHz
// of each capture is used and views are stitched from 32 MHz segments. Measured on the bench board, 2026-10-20: about
// 285 spectra a second, retune 8 ms at 2.4 GHz and about 30 ms at 5 GHz.
#define RATE_CODE     0          // 80 MS/s
#define FFT_N         1024
#define SEG_MHZ       32         // used from each capture: its clean middle
#define FFTS_PER_SEG  16         // max-hold over 16 snapshots per segment
#define DC_MASK_BINS  6          // the receiver's own spike at the tuned frequency (~0.5 MHz)

typedef struct {
    const char *name;            // header, left
    unsigned start, end;         // MHz
    unsigned ch_first, ch_last, ch_step, ch_label_every;
    unsigned ch_base_mhz;        // channel n centre = base + 5n
} view_t;

static const view_t VIEWS[] = {
    { "2.4 GHz",          2402, 2482,   1,  13, 1, 5, 2407 },
    { "5 GHz CH 36-64",   5170, 5330,  36,  64, 4, 8, 5000 },
    { "5 GHz CH 100-144", 5490, 5730, 100, 144, 4, 8, 5000 },
    { "5 GHz CH 149-165", 5735, 5855, 149, 165, 4, 8, 5000 },
};
#define VIEW_COUNT (sizeof VIEWS / sizeof VIEWS[0])

// ─── Layout ───────────────────────────────────────────────────────────────────
// The 2.8" board is upright (240 wide): the header takes three lines (band;
// range and mode; battery), then a taller trace and a long waterfall. The 1.47"
// layout is unchanged.
//
//   2.8" (240 x 320)                  1.47" (320 x 172)
//   0    band name, battery           0    band, mode, range
//   24   range or marker, mode        18   trace (80)
//   44   trace (120)                  100  waterfall
//   166  waterfall (108 rows, 54 s)        channel marks
//   275  channel marks and numbers
//   294  channel scorecard
//
//   T-Dongle (160 x 80): band and mode on one line (0), trace (9, 40 px),
//   waterfall (51, 17 rows, about 8 s), channel marks and numbers (69).
#if defined(ENG_BOARD_TOUCH28)
#define TRACE_Y    44
#define TRACE_H    120
#define BOTTOM_H   46            // channel marks and numbers (19), scorecard (27)
#elif defined(ENG_BOARD_TDONGLE)
#define TRACE_Y    9
#define TRACE_H    40
#define BOTTOM_H   12            // channel marks (3) and numbers (7)
#else
#define TRACE_Y    18
#define TRACE_H    80
#define BOTTOM_H   14            // channel marks and numbers
#endif
#define WF_Y       (TRACE_Y + TRACE_H + 2)
#define WF_H       (LCD_H - WF_Y - BOTTOM_H)
#define MARK_Y     (WF_Y + WF_H + 1)
#define SCORE_Y    (MARK_Y + 19)
#define STRIP_H    20
#define RANGE_DB   48            // shown above the floor
#define FLOOR_PAD_DB 4           // shown below it

static uint8_t  s_col[LCD_W];        // this sweep, code per column (2 x dB)
static uint8_t  s_peak[LCD_W];
// The two big buffers are allocated at start-up, not static: on the C5, ESP-SDR
// reserves the 128 KB SRAM bank right after .bss for its captures, and its
// linker guard ("C5 RF dump overlaps BSS") fails the build if static data grows
// into it. The heap lives above that bank.
static uint8_t  (*s_wf)[LCD_W];      // [WF_H][LCD_W] waterfall, 0-255, row 0 newest
static uint16_t *s_strip;            // LCD_W * STRIP_H
static uint8_t  *s_codes;            // FFT_N, heap (see below)
static uint8_t  *s_shift;            // FFT_N, heap

// As the web viewer's defaults (Average, 0.5 s rows,
// Fine), chosen on the bench, 2026-10-20:
//   - each slice is a mean-power spectrum (spectrum_snapshot, detector 0)
//   - the trace is a running power average across sweeps, about 4
//   - each waterfall row is the power average of every sweep in ROW_MS
// Peak hold is still the maximum of the sweeps.
#define ROW_MS      500
static float   *s_avg;               // LCD_W, trace average, linear power
static float   *s_row_sum;           // LCD_W, waterfall row being filled
static int      s_row_n;
static int64_t  s_row_t0;
static uint8_t  s_shown[LCD_W];      // what the trace draws
static inline float to_lin(float code) { return powf(10.0f, code / 20.0f); }
static inline uint8_t to_code(float lin)
{
    float c = lin > 0 ? 20.0f * log10f(lin) : 0;
    return (uint8_t)(c < 0 ? 0 : c > 255 ? 255 : c + 0.5f);
}
// Every segment is put on one scale: its own noise floor is moved to FLOOR_CODE.
// The receiver's automatic gain is set per capture, so a segment holding a
// strong AP came back several dB higher across its whole width than its
// neighbours, and the view showed steps at the seams (bench, 2026-10-20). The
// screen shows "dB above the noise floor", so measuring each segment against
// its own floor keeps that meaning in every segment.
#define FLOOR_CODE 80
#define MAX_SEGS   8
static const float s_floor = FLOOR_CODE;
static float    s_seg_floor[MAX_SEGS];   // codes, smoothed across sweeps; <0 = none yet
static volatile bool s_next, s_peak_toggle, s_switch;
static bool     s_peak_on = true;
static unsigned s_view;
static float    s_batt = -1;         // volts, smoothed; < 0 = not read
static int64_t  s_batt_t;
static int      s_wf_rows;           // waterfall rows filled since the view was set

// Touch (2.8 only; on the 1.47 these never change from their defaults).
static int      s_marker_x = -1;     // column of the tap marker; -1 = none
static bool     s_overlay = true;    // Wi-Fi channel widths shaded over the trace
static bool     s_frozen;            // sweeping paused, the screen held still
static bool     s_zoomed;            // a 40 MHz view of one channel
static view_t   s_zoom;
static char     s_zoom_name[24];
static volatile bool s_snap_req;
static eng_send_fn s_send;

// The channel scorecard: for each channel in the view, the share of the
// waterfall (about the last minute) where that channel's 20 MHz held energy
// 6 dB or more above the floor. Only what was measured: a channel the view
// does not wholly cover has no figure.
#define BUSY_DB     6
#define MAX_CH      32
#ifdef ENG_BOARD_TOUCH28
static int8_t   s_busy[MAX_CH];      // percent, -1 = not measured
#endif

// ─── Colours ──────────────────────────────────────────────────────────────────
static uint16_t C_BG, C_GRID, C_TEXT, C_MUTED, C_PEAK, C_MARK;
static uint16_t C_OK, C_WARN, C_ELEV, C_CRIT, C_NONE;   // the state palette
// The trace fill, coloured by height (after a reference
// analyser): red at the noise floor, through orange and yellow, to green at
// the top. One colour per trace row; s_edge is the brighter tip of the same.
static uint16_t s_fill[TRACE_H], s_edge[TRACE_H];

static void colours_init(void)
{
    C_BG    = rgb565(0, 0, 0);
    C_GRID  = rgb565(40, 40, 64);
    C_TEXT  = rgb565(255, 255, 255);
    C_MUTED = rgb565(150, 150, 180);
    C_PEAK  = rgb565(170, 170, 185);     // peak hold, a thin grey line
    for (int ty = 0; ty < TRACE_H; ty++) {
        // A smooth hue sweep, red (0 deg) at the floor to green (120 deg) at
        // +36 dB, the top grid line, and green above it (tuned on the
        // bench, 2026-10-20, so the gradient reads across the usual range). Signals
        // here rarely pass mid-scale, so ending at the very top hid the green.
        float db = (float)(TRACE_H - 1 - ty) * (RANGE_DB + FLOOR_PAD_DB) / TRACE_H - FLOOR_PAD_DB;
        float h = db <= 0 ? 0 : db >= 36 ? 1 : db / 36.0f;
        float hue = h * 120.0f;                       // HSV, full saturation and value
        uint8_t r, g;
        if (hue < 60) { r = 255; g = (uint8_t)(hue / 60 * 255); }
        else          { r = (uint8_t)((120 - hue) / 60 * 255); g = 255; }
        s_fill[ty] = rgb565(r, g, 0);
        s_edge[ty] = rgb565((uint8_t)(r + (255 - r) / 2), 255, 120);
    }
    C_MARK  = rgb565(167, 139, 250);     // violet (#A78BFA)
    // State palette (green, amber, orange, red), for the scorecard and FROZEN.
    C_OK    = rgb565(0x22, 0xC5, 0x5E);
    C_WARN  = rgb565(0xFB, 0xBF, 0x24);
    C_ELEV  = rgb565(0xF9, 0x73, 0x16);
    C_CRIT  = rgb565(0xEF, 0x44, 0x44);
    C_NONE  = rgb565(60, 60, 80);
}

// Dark blue -> cyan -> yellow -> red, for the waterfall. Intensity is relative
// to the floor; the scale bar in the header says what the colours mean.
static uint16_t heat(uint8_t v)
{
    if (v < 16) return C_BG;
    if (v < 96)  return rgb565(0, (uint8_t)((v - 16) * 2), (uint8_t)(80 + (v - 16)));
    if (v < 176) return rgb565((uint8_t)((v - 96) * 3), 200, (uint8_t)(160 - (v - 96) * 2));
    return rgb565(255, (uint8_t)(200 - (v - 176) * 2), 0);
}

// ─── Text ─────────────────────────────────────────────────────────────────────
// Draw `s` with its top-left at (x, y) into the current strip, clipping to it.
static void text(int strip_y, int x, int y, const char *s, int scale, uint16_t col)
{
    for (; *s; s++, x += 6 * scale) {
        const uint8_t *g = eng_font_glyph(*s);
        if (!g) continue;
        for (int r = 0; r < 7 * scale; r++) {
            int py = y + r - strip_y;
            if (py < 0 || py >= STRIP_H) continue;
            uint8_t bits = g[r / scale];
            for (int c = 0; c < 5 * scale; c++) {
                int px = x + c;
                if (px < 0 || px >= LCD_W) continue;
                if (bits & (0x10 >> (c / scale))) s_strip[py * LCD_W + px] = col;
            }
        }
    }
}

#ifdef ENG_BOARD_TOUCH28
// Smooth text (2.8): `top` is the top of the line; glyphs sit on top + ascent.
// Each glyph's coverage is blended onto what the strip already holds.
static inline uint16_t blend(uint16_t bg, uint16_t fg, uint8_t a)
{
    int rb = (bg >> 11) & 31, gb = (bg >> 5) & 63, bb = bg & 31;
    int rf = (fg >> 11) & 31, gf = (fg >> 5) & 63, bf = fg & 31;
    int r = rb + ((rf - rb) * a) / 255, g = gb + ((gf - gb) * a) / 255, b = bb + ((bf - bb) * a) / 255;
    return (uint16_t)((r << 11) | (g << 5) | b);
}

static int aa_index(const char **s)
{
    unsigned char c = (unsigned char)**s;
    if (c >= 0x20 && c < 0x7F) { (*s)++; return c - 0x20; }
    if (c == 0xC2 && (unsigned char)(*s)[1] == 0xB7) { *s += 2; return 95; }                  // ·
    if (c == 0xE2 && (unsigned char)(*s)[1] == 0x80 && (unsigned char)(*s)[2] == 0x94) { *s += 3; return 96; }  // —
    (*s)++;
    return 0;                                                                              // space
}

static int aa_width(const char *s, const eng_aa_font_t *f)
{
    int w = 0;
    while (*s) w += f->g[aa_index(&s)].adv;
    return w;
}

static void aa_text(int strip_y, int x, int top, const char *s, const eng_aa_font_t *f, uint16_t col)
{
    int base = top + f->ascent;
    while (*s) {
        const eng_glyph_t *g = &f->g[aa_index(&s)];
        int gx = x + g->left, gy = base - g->top;
        for (int r = 0; r < g->h; r++) {
            int py = gy + r - strip_y;
            if (py < 0 || py >= STRIP_H) continue;
            const uint8_t *cov = f->px + g->off + r * g->w;
            for (int c = 0; c < g->w; c++) {
                int px = gx + c;
                if (cov[c] == 0 || px < 0 || px >= LCD_W) continue;
                uint16_t *d = &s_strip[py * LCD_W + px];
                *d = cov[c] == 255 ? col : blend(*d, col, cov[c]);
            }
        }
        x += g->adv;
    }
}

static void strip_rect(int strip_y, int x, int y, int w, int h, uint16_t col)
{
    for (int r = y; r < y + h; r++) {
        int py = r - strip_y;
        if (py < 0 || py >= STRIP_H) continue;
        for (int c = x; c < x + w; c++)
            if (c >= 0 && c < LCD_W) s_strip[py * LCD_W + c] = col;
    }
}

#endif

// ─── Mapping ──────────────────────────────────────────────────────────────────
static int code_to_y(float code)          // 0 = top of the trace area
{
    float db_above = (code - s_floor) / 2.0f + FLOOR_PAD_DB;
    int h = (int)(db_above * TRACE_H / (RANGE_DB + FLOOR_PAD_DB));
    if (h < 0) h = 0;
    if (h > TRACE_H - 1) h = TRACE_H - 1;
    return TRACE_H - 1 - h;
}

static uint8_t code_to_heat(uint8_t code)
{
    float db_above = (code - s_floor) / 2.0f;
    if (db_above <= 0) return 0;
    float v = db_above * 255.0f / 36.0f;      // full colour at 36 dB above the floor
    return v > 255 ? 255 : (uint8_t)v;
}

static int mhz_to_x(const view_t *v, float mhz)
{
    return (int)((mhz - v->start) * LCD_W / (float)(v->end - v->start));
}

static const view_t *cur_view(void) { return s_zoomed ? &s_zoom : &VIEWS[s_view]; }

// The channel nearest column x, within the view's channel list.
static unsigned channel_at(const view_t *v, int x)
{
    float mhz = v->start + (x + 0.5f) * (v->end - v->start) / (float)LCD_W;
    unsigned best = v->ch_first;
    float bd = 1e9f;
    for (unsigned ch = v->ch_first; ch <= v->ch_last; ch += v->ch_step) {
        float d = fabsf(mhz - (float)(v->ch_base_mhz + 5 * ch));
        if (d < bd) { bd = d; best = ch; }
    }
    return best;
}

// Zoom to 40 MHz around one channel: that channel and its neighbours.
static void zoom_to(const view_t *parent, unsigned ch)
{
    unsigned c = parent->ch_base_mhz + 5 * ch;
    s_zoom = *parent;
    s_zoom.start = c - 20;
    s_zoom.end = c + 20;
    s_zoom.ch_first = ch;
    while (s_zoom.ch_first >= parent->ch_first + parent->ch_step &&
           parent->ch_base_mhz + 5 * (s_zoom.ch_first - parent->ch_step) >= s_zoom.start)
        s_zoom.ch_first -= parent->ch_step;
    s_zoom.ch_last = ch;
    while (s_zoom.ch_last + parent->ch_step <= parent->ch_last &&
           parent->ch_base_mhz + 5 * (s_zoom.ch_last + parent->ch_step) <= s_zoom.end)
        s_zoom.ch_last += parent->ch_step;
    s_zoom.ch_label_every = parent->ch_step;
    snprintf(s_zoom_name, sizeof s_zoom_name, "Channel %u", ch);
    s_zoom.name = s_zoom_name;
    s_zoomed = true;
}

#ifdef ENG_BOARD_TOUCH28
// Fills s_busy for the view's channels from the waterfall. The heat value is
// dB above the floor scaled so 36 dB is 255 (code_to_heat).
static void compute_busy(const view_t *v)
{
    const int thr = BUSY_DB * 255 / 36 + 1;
    int i = 0;
    for (unsigned ch = v->ch_first; ch <= v->ch_last && i < MAX_CH; ch += v->ch_step, i++) {
        float c = (float)(v->ch_base_mhz + 5 * ch);
        int x0 = mhz_to_x(v, c - 10), x1 = mhz_to_x(v, c + 10);
        if (x0 < 0 || x1 > LCD_W || s_wf_rows == 0) { s_busy[i] = -1; continue; }
        int rows = s_wf_rows < WF_H ? s_wf_rows : WF_H, hot = 0, all = 0;
        for (int r = 0; r < rows; r++)
            for (int x = x0; x < x1; x++, all++)
                if (s_wf[r][x] >= thr) hot++;
        s_busy[i] = all ? (int8_t)(hot * 100 / all) : -1;
    }
    for (; i < MAX_CH; i++) s_busy[i] = -1;
}

// The quietest channel worth recommending: on 2.4 GHz only 1, 6 or 11 (the
// three that do not overlap), on 5 GHz any. -1 when nothing was measured.
static int best_channel(const view_t *v, int *pct)
{
    int best = -1, bp = 101, i = 0;
    for (unsigned ch = v->ch_first; ch <= v->ch_last && i < MAX_CH; ch += v->ch_step, i++) {
        if (s_busy[i] < 0) continue;
        if (v->ch_base_mhz < 3000 && ch != 1 && ch != 6 && ch != 11) continue;
        if (s_busy[i] < bp) { bp = s_busy[i]; best = (int)ch; }
    }
    *pct = bp;
    return best;
}

#endif

// The Wi-Fi channel overlay, drawn as Chanalyzer draws it:
// each channel's spectral mask as a coloured outline, a flat top over the
// middle 18 MHz and sides sloping out to 22 MHz at the floor, with a channel
// tag on top. On 2.4 GHz only 1, 6 and 11, the three that do not overlap (all
// thirteen would be a tangle); on 5 GHz every channel in view.
#ifdef ENG_BOARD_TOUCH28
#define MAX_OV   16
#define OV_TOP   14                  // the mask's top, rows below the trace top
typedef struct { int16_t x0, xa, xb, x1; uint16_t col; unsigned ch; } ov_t;
static ov_t     s_ovl[MAX_OV];
static int      s_ovn;

static void overlay_mask(const view_t *v)
{
    // Tremor's chart colours, in order.
    const uint16_t pal[4] = { rgb565(0x3B, 0x82, 0xF6), rgb565(0x10, 0xB9, 0x81),
                              rgb565(0x8B, 0x5C, 0xF6), rgb565(0xF5, 0x9E, 0x0B) };
    s_ovn = 0;
    for (unsigned ch = v->ch_first; ch <= v->ch_last && s_ovn < MAX_OV; ch += v->ch_step) {
        if (v->ch_base_mhz < 3000 && ch != 1 && ch != 6 && ch != 11) continue;
        float c = (float)(v->ch_base_mhz + 5 * ch);
        ov_t *o = &s_ovl[s_ovn];
        o->x0 = mhz_to_x(v, c - 11); o->xa = mhz_to_x(v, c - 9);
        o->xb = mhz_to_x(v, c + 9);  o->x1 = mhz_to_x(v, c + 11);
        o->col = pal[s_ovn % 4];
        o->ch = ch;
        s_ovn++;
    }
}

// One trace row of the outlines: the top edge (2 px), then the two sloping sides.
static void overlay_row(uint16_t *row, int ty)
{
    if (ty < OV_TOP) return;
    for (int i = 0; i < s_ovn; i++) {
        const ov_t *o = &s_ovl[i];
        if (ty <= OV_TOP + 1) {
            for (int x = o->xa; x <= o->xb; x++) if (x >= 0 && x < LCD_W) row[x] = o->col;
            continue;
        }
        int span = TRACE_H - 1 - OV_TOP;
        int l = o->xa + (o->x0 - o->xa) * (ty - OV_TOP) / span;
        int r = o->xb + (o->x1 - o->xb) * (ty - OV_TOP) / span;
        if (l >= 0 && l < LCD_W) row[l] = o->col;
        if (r >= 0 && r < LCD_W) row[r] = o->col;
    }
}

// The tags, over the top edges.
static void overlay_tags(int sy)
{
    char b[8];
    for (int i = 0; i < s_ovn; i++) {
        const ov_t *o = &s_ovl[i];
        snprintf(b, sizeof b, "%u", o->ch);
        int w = aa_width(b, &eng_font_label) + 6, cx = (o->xa + o->xb) / 2;
        int top = TRACE_Y + OV_TOP - 6;
        strip_rect(sy, cx - w / 2, top, w, 13, o->col);
        strip_rect(sy, cx - w / 2 + 1, top + 1, w - 2, 11, C_BG);
        aa_text(sy, cx - w / 2 + 3, top, b, &eng_font_label, o->col);
    }
}
#endif

#ifdef ENG_BOARD_TOUCH28
static uint16_t busy_colour(int pct)
{
    return pct < 0 ? C_NONE : pct < 10 ? C_OK : pct < 30 ? C_WARN : pct < 60 ? C_ELEV : C_CRIT;
}
#endif

// ─── Text and the scorecard on the 2.8 ───────────────────────────────────────
#ifdef ENG_BOARD_TOUCH28
static void overlay_28(int sy, const view_t *v, const char *range, const char *info)
{
    char b[48];
    aa_text(sy, 10, 2, v->name, &eng_font_title, C_TEXT);
    if (s_batt >= 0) {
        // The measured voltage, not a percentage: a LiPo's charge curve would
        // be a guess, and on USB 4.2 V also means "no battery".
        int cv = (int)(s_batt * 100 + 0.5f);
        snprintf(b, sizeof b, "%d.%02d V", cv / 100, cv % 100);
        aa_text(sy, LCD_W - 10 - aa_width(b, &eng_font_text), 5, b, &eng_font_text, C_MUTED);
    }
    // Line 2: the marker's reading when there is one, else the range. The mode
    // on the right shortens when the reading needs the room.
    int left_w;
    if (s_marker_x >= 0) {
        float mhz = v->start + (s_marker_x + 0.5f) * (v->end - v->start) / (float)LCD_W;
        int db = (int)((s_shown[s_marker_x] - s_floor) / 2.0f + 0.5f);
        if (db < 0) db = 0;
        snprintf(b, sizeof b, "%u MHz \u00b7 ch %u \u00b7 +%d dB", (unsigned)(mhz + 0.5f),
                 channel_at(v, s_marker_x), db);
        aa_text(sy, 10, 24, b, &eng_font_text, C_TEXT);
        left_w = aa_width(b, &eng_font_text);
    } else {
        aa_text(sy, 10, 24, range, &eng_font_text, C_MUTED);
        left_w = aa_width(range, &eng_font_text);
    }
    if (10 + left_w + 12 + aa_width(info, &eng_font_text) > LCD_W - 10)
        info = s_frozen ? "FROZEN" : s_peak_on ? "PEAK" : "LIVE";
    aa_text(sy, LCD_W - 10 - aa_width(info, &eng_font_text), 24, info, &eng_font_text,
            s_frozen ? C_WARN : C_MUTED);
    // dB labels on a black backing, so the trace fill never hides them.
    for (int db = 12; db <= RANGE_DB - 12; db += 12) {
        snprintf(b, sizeof b, "+%d", db);
        int top = TRACE_Y + code_to_y(s_floor + db * 2) - 12;
        strip_rect(sy, 1, top, aa_width(b, &eng_font_label) + 4, 12, C_BG);
        aa_text(sy, 3, top, b, &eng_font_label, C_MUTED);
    }
    if (s_overlay) overlay_tags(sy);
    // Channel numbers, and the scorecard block under each.
    unsigned i = 0;
    int pitch = mhz_to_x(v, (float)(v->ch_base_mhz + 5 * v->ch_step)) - mhz_to_x(v, (float)v->ch_base_mhz);
    int bw = pitch - 2 < 4 ? 4 : pitch - 2 > 24 ? 24 : pitch - 2;
    for (unsigned ch = v->ch_first; ch <= v->ch_last && i < MAX_CH; ch += v->ch_step, i++) {
        int x = mhz_to_x(v, (float)(v->ch_base_mhz + 5 * ch));
        strip_rect(sy, x - bw / 2, SCORE_Y, bw, 6, busy_colour(s_busy[i]));
        if (i % (v->ch_label_every / v->ch_step ? v->ch_label_every / v->ch_step : 1)) continue;
        snprintf(b, sizeof b, "%u", ch);
        aa_text(sy, x - aa_width(b, &eng_font_label) / 2, MARK_Y + 4, b, &eng_font_label, C_MUTED);
    }
    int pct, best = best_channel(v, &pct);
    if (best >= 0) snprintf(b, sizeof b, "Quietest ch %d \u00b7 %d%% busy", best, pct);
    else           snprintf(b, sizeof b, "Quietest ch \u2014");
    aa_text(sy, 10, SCORE_Y + 7, b, &eng_font_text, C_TEXT);
    const char *span = "last min";
    aa_text(sy, LCD_W - 10 - aa_width(span, &eng_font_text), SCORE_Y + 7, span, &eng_font_text, C_MUTED);
}
#endif

// ─── Render ───────────────────────────────────────────────────────────────────
static void render(const view_t *v, int64_t sweep_ms)
{
    int col_y[LCD_W], peak_y[LCD_W];
    for (int x = 0; x < LCD_W; x++) {
        col_y[x] = code_to_y(s_shown[x]);
        peak_y[x] = code_to_y(s_peak[x]);
    }
    (void)sweep_ms;
    char range[40];
    snprintf(range, sizeof range, "%u-%u MHz", v->start, v->end);
    const char *info = s_frozen ? "FROZEN" : s_peak_on ? "PEAK HOLD" : "LIVE";
#ifdef ENG_BOARD_TOUCH28
    compute_busy(v);
    overlay_mask(v);
#endif
    bool snap = s_snap_req && s_send;
    if (snap) { s_snap_req = false; eng_lcd_snap(s_send, true); }

    for (int sy = 0; sy < LCD_H; sy += STRIP_H) {
        int h = (sy + STRIP_H > LCD_H) ? LCD_H - sy : STRIP_H;
        for (int r = 0; r < h; r++) {
            int y = sy + r;
            uint16_t *row = &s_strip[r * LCD_W];
            if (y >= TRACE_Y && y < TRACE_Y + TRACE_H) {
                int ty = y - TRACE_Y;
                // dB grid every 12 dB above the floor, dotted
                bool grid = false;
                for (int db = 0; db <= RANGE_DB; db += 12)
                    if (ty == code_to_y(s_floor + db * 2)) grid = true;
                for (int x = 0; x < LCD_W; x++) {
                    uint16_t c = (grid && (x & 3) == 0) ? C_GRID : C_BG;
                    if (ty > col_y[x]) c = s_fill[ty];
                    if (ty == col_y[x] || (x && ty < col_y[x] && ty >= col_y[x - 1])) c = s_edge[ty];
                    // Peak hold as a joined line, not dots: span from the last column's
                    // level to this one's, as the trace edge does.
                    if (s_peak_on && ty < col_y[x]) {
                        int a = peak_y[x], b = x ? peak_y[x - 1] : peak_y[x];
                        int lo = a < b ? a : b, hi = a < b ? b : a;
                        if (ty >= lo && ty <= hi) c = C_PEAK;
                    }
                    row[x] = c;
                }
#ifdef ENG_BOARD_TOUCH28
                if (s_overlay) overlay_row(row, ty);
#endif
                if (s_marker_x >= 0 && (ty & 2)) row[s_marker_x] = C_TEXT;
            } else if (y >= WF_Y && y < WF_Y + WF_H) {
                const uint8_t *w = s_wf[y - WF_Y];
                for (int x = 0; x < LCD_W; x++) row[x] = heat(w[x]);
                if (s_marker_x >= 0 && (y & 2)) row[s_marker_x] = C_TEXT;
            } else if (y >= MARK_Y && y < MARK_Y + 3) {
                for (int x = 0; x < LCD_W; x++) row[x] = C_BG;
                for (unsigned ch = v->ch_first; ch <= v->ch_last; ch += v->ch_step) {
                    int x = mhz_to_x(v, (float)(v->ch_base_mhz + 5 * ch));
                    if (x >= 0 && x < LCD_W) row[x] = C_MARK;
                }
            } else {
                for (int x = 0; x < LCD_W; x++) row[x] = C_BG;
            }
        }
#if defined(ENG_BOARD_TOUCH28)
        overlay_28(sy, v, range, info);
#elif defined(ENG_BOARD_TDONGLE)
        // One line: band and mode. The range is left out: the band name and
        // the channel numbers say where the view is, and 160 px holds no more.
        text(sy, 2, 1, v->name, 1, C_TEXT);
        if (s_frozen || !s_peak_on) info = s_frozen ? "FROZEN" : "LIVE";
        else info = "PEAK";
        text(sy, LCD_W - 2 - eng_font_width(info, 1), 1, info, 1, C_MUTED);
        // One grid label: at 40 px tall the others would sit on top of each other.
        text(sy, 2, TRACE_Y + code_to_y(s_floor + 24 * 2) - 8, "+24", 1, C_MUTED);
        unsigned i = 0;
        for (unsigned ch = v->ch_first; ch <= v->ch_last; ch += v->ch_step, i++) {
            if (i % (v->ch_label_every / v->ch_step ? v->ch_label_every / v->ch_step : 1)) continue;
            char l[16];
            snprintf(l, sizeof l, "%u", ch);
            int x = mhz_to_x(v, (float)(v->ch_base_mhz + 5 * ch)) - eng_font_width(l, 1) / 2;
            text(sy, x, MARK_Y + 3, l, 1, C_MUTED);
        }
#else
        // Text over the strip
        // Kept in from the corners: the panel's rounded corners clip text there.
        text(sy, 10, 2, v->name, 2, C_TEXT);
#ifdef ENG_BOARD_TOUCH28
        // 240 px cannot hold the band name and the range on one line.
        text(sy, 10, 22, range, 1, C_MUTED);
        text(sy, LCD_W - 12 - eng_font_width(info, 1), 22, info, 1, C_MUTED);
        const int batt_y = 32;
#else
        text(sy, LCD_W - 12 - eng_font_width(info, 1), 2, info, 1, C_MUTED);
        text(sy, LCD_W - 12 - eng_font_width(range, 1), 10, range, 1, C_MUTED);
        const int batt_y = 18;
#endif
        if (s_batt >= 0) {
            // The measured voltage, not a percentage: a LiPo's charge curve
            // would be a guess, and on USB 4.2 V also means "no battery".
            char b[24];
            int cv = (int)(s_batt * 100 + 0.5f);
            snprintf(b, sizeof b, "BATT %d.%02dV", cv / 100, cv % 100);
            text(sy, LCD_W - 12 - eng_font_width(b, 1), batt_y, b, 1, C_MUTED);
        }
        // dB-above-floor labels on the grid, left edge
        for (int db = 12; db <= RANGE_DB - 12; db += 12) {
            char l[16];
            snprintf(l, sizeof l, "+%d", db);
            text(sy, 2, TRACE_Y + code_to_y(s_floor + db * 2) - 8, l, 1, C_MUTED);
        }
        // Channel numbers
        unsigned i = 0;
        for (unsigned ch = v->ch_first; ch <= v->ch_last; ch += v->ch_step, i++) {
            if (i % (v->ch_label_every / v->ch_step ? v->ch_label_every / v->ch_step : 1)) continue;
            char l[16];
            snprintf(l, sizeof l, "%u", ch);
            int x = mhz_to_x(v, (float)(v->ch_base_mhz + 5 * ch)) - eng_font_width(l, 1) / 2;
            text(sy, x, MARK_Y + 4, l, 1, C_MUTED);
        }
#endif
        eng_lcd_push(0, sy, LCD_W, h, s_strip);
    }
    if (snap) eng_lcd_snap(s_send, false);
}

// ─── Sweep ────────────────────────────────────────────────────────────────────
// One segment: tune to `centre`, take a max-hold spectrum, and fold it into the
// columns it covers. Returns false if the capture failed.
static bool sweep_segment(const view_t *v, unsigned k, unsigned centre, eng_tune_fn tune,
                          eng_spectrum_fn spectrum)
{
    tune(centre);
    if (!spectrum(RATE_CODE, FFT_N, FFTS_PER_SEG, s_codes)) return false;
    // Natural order has bin 0 at the tuned frequency; centre it (fftshift).
    uint8_t *sh = s_shift;
    for (int i = 0; i < FFT_N; i++) sh[i] = s_codes[(i + FFT_N / 2) % FFT_N];
    // The receiver's own DC spike: bridge the few bins either side of centre.
    int c = FFT_N / 2;
    uint8_t lo = sh[c - DC_MASK_BINS - 1], hi = sh[c + DC_MASK_BINS + 1];
    for (int i = c - DC_MASK_BINS; i <= c + DC_MASK_BINS; i++) sh[i] = (uint8_t)((lo + hi) / 2);

    const float mhz_per_bin = 80.0f / FFT_N;
    const float mhz_per_col = (float)(v->end - v->start) / LCD_W;
    int x0 = -1, x1 = -1;
    for (int x = 0; x < LCD_W; x++) {
        float f = v->start + (x + 0.5f) * mhz_per_col;
        float off = f - (float)centre;
        if (off < -SEG_MHZ / 2.0f || off >= SEG_MHZ / 2.0f) continue;
        int b0 = c + (int)((off - mhz_per_col / 2) / mhz_per_bin);
        int b1 = c + (int)((off + mhz_per_col / 2) / mhz_per_bin);
        if (b1 < b0) b1 = b0;
        uint8_t m = 0;
        for (int b = b0; b <= b1; b++)
            if (b >= 0 && b < FFT_N && sh[b] > m) m = sh[b];
        s_col[x] = m;
        if (x0 < 0) x0 = x;
        x1 = x;
    }
    if (x0 < 0) return true;

    // This segment's noise floor: the 15th percentile of its columns, smoothed
    // across sweeps so the scale does not jump. 15 %, because a 20 MHz AP fills
    // most of a 32 MHz segment but never 85 % of it.
    uint8_t sorted[LCD_W];
    int n = x1 - x0 + 1;
    memcpy(sorted, &s_col[x0], n);
    for (int i = 1; i < n; i++) {                       // insertion sort, <= 320 items
        uint8_t key = sorted[i]; int j = i - 1;
        while (j >= 0 && sorted[j] > key) { sorted[j + 1] = sorted[j]; j--; }
        sorted[j + 1] = key;
    }
    float now = sorted[n * 15 / 100];
    float *fl = &s_seg_floor[k < MAX_SEGS ? k : MAX_SEGS - 1];
    *fl = *fl < 0 ? now : *fl * 0.85f + now * 0.15f;
    for (int x = x0; x <= x1; x++) {
        int v2 = (int)s_col[x] - (int)(*fl + 0.5f) + FLOOR_CODE;
        s_col[x] = (uint8_t)(v2 < 0 ? 0 : v2 > 255 ? 255 : v2);
    }
    return true;
}

static void reset_view(void)
{
    memset(s_peak, 0, sizeof s_peak);
    memset(s_wf, 0, WF_H * LCD_W);
    for (int i = 0; i < MAX_SEGS; i++) s_seg_floor[i] = -1;
    if (s_avg) for (int x = 0; x < LCD_W; x++) s_avg[x] = -1;   // -1: no sweep yet
    if (s_row_sum) memset(s_row_sum, 0, LCD_W * sizeof(float));
    s_row_n = 0;
    s_row_t0 = esp_timer_get_time();
    s_wf_rows = 0;
}

// ─── Button ───────────────────────────────────────────────────────────────────
// Press, double press and a 3 s hold, debounced.
#define BOOT_BTN 28
static void button_task(void *arg)
{
    (void)arg;
    int stable = 1, raw_last = 1;
    int64_t raw_since = 0, last_release = 0;
    bool pending = false, spent = false;   // spent: this press already made a double
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(10));
        int64_t t = esp_timer_get_time() / 1000;
        int raw = gpio_get_level(BOOT_BTN);
        if (raw != raw_last) { raw_last = raw; raw_since = t; }
        // Held 3 s: to the companion app in the other slot, if built with one.
        if (stable == 0 && raw == 0 && !spent && t - raw_since >= 3000) { spent = true; pending = false; s_switch = true; }
        if (raw != stable && t - raw_since >= 30) {
            stable = raw;
            if (stable == 0) {
                if (pending && t - last_release <= 350) { pending = false; spent = true; s_peak_toggle = true; }
            } else {
                if (!spent) { pending = true; last_release = t; }
                spent = false;
            }
        }
        if (pending && t - last_release > 350) { pending = false; s_next = true; }
    }
}

// ─── Entry ────────────────────────────────────────────────────────────────────
// Full screen while a phone or laptop has the radio, so the frozen trace is
// not mistaken for a live one.
static void draw_host_screen(void)
{
    for (int sy = 0; sy < LCD_H; sy += STRIP_H) {
        int h = (sy + STRIP_H > LCD_H) ? LCD_H - sy : STRIP_H;
        for (int i = 0; i < LCD_W * h; i++) s_strip[i] = C_BG;
#ifdef ENG_BOARD_TDONGLE
        // Always on a laptop's USB, so the page closing is what hands it back.
        const char *a = "VIEWER CONNECTED", *b = "THE PAGE HAS THE RADIO", *c = "CLOSE IT TO RETURN";
        text(sy, (LCD_W - eng_font_width(a, 1)) / 2, 22, a, 1, C_TEXT);
        text(sy, (LCD_W - eng_font_width(b, 1)) / 2, 40, b, 1, C_MUTED);
        text(sy, (LCD_W - eng_font_width(c, 1)) / 2, 52, c, 1, C_MUTED);
#else
        const char *a = "PHONE CONNECTED", *b = "VIEWER HAS THE RADIO", *c = "UNPLUG TO RETURN";
        int y0 = (LCD_H - 172) / 2;       // centred on either screen
        text(sy, (LCD_W - eng_font_width(a, 2)) / 2, y0 + 58, a, 2, C_TEXT);
        text(sy, (LCD_W - eng_font_width(b, 1)) / 2, y0 + 86, b, 1, C_MUTED);
        text(sy, (LCD_W - eng_font_width(c, 1)) / 2, y0 + 100, c, 1, C_MUTED);
#endif
        eng_lcd_push(0, sy, LCD_W, h, s_strip);
    }
}

// ─── Gestures ─────────────────────────────────────────────────────────────────
// From the touch screen (2.8) or the USB test commands (both boards), handled
// on the sweep loop between captures.
//   swipe left / right   next / previous band
//   tap the header       Wi-Fi channel overlay on or off
//   tap trace/waterfall  marker: frequency, channel and level at that column;
//                        tap on the marker again to clear it
//   tap channel strip    zoom to 40 MHz around that channel; again to zoom out
//   double tap           peak hold on or off
//   hold 1 s             freeze or unfreeze
typedef enum { EV_TAP, EV_DTAP, EV_SWIPE_L, EV_SWIPE_R, EV_HOLD } ev_kind_t;
typedef struct { ev_kind_t k; int16_t x, y; } ev_t;
static QueueHandle_t s_ev;

static void post(ev_kind_t k, int x, int y)
{
    ev_t e = { k, (int16_t)x, (int16_t)y };
    if (s_ev) xQueueSend(s_ev, &e, 0);
}

static void set_view(unsigned view)
{
    s_view = view % VIEW_COUNT;
    s_zoomed = false;
    s_marker_x = -1;
    reset_view();
}

static void handle_events(void)
{
    ev_t e;
    while (s_ev && xQueueReceive(s_ev, &e, 0) == pdTRUE) {
        switch (e.k) {
        case EV_SWIPE_L: set_view(s_view + 1); break;
        case EV_SWIPE_R: set_view(s_view + VIEW_COUNT - 1); break;
        case EV_DTAP:    s_peak_on = !s_peak_on; memset(s_peak, 0, sizeof s_peak); break;
        case EV_HOLD:    s_frozen = !s_frozen; break;
        case EV_TAP:
            if (e.y < TRACE_Y) {
                s_overlay = !s_overlay;
            } else if (e.y < MARK_Y) {
                if (s_marker_x >= 0 && abs(e.x - s_marker_x) <= 8) s_marker_x = -1;
                else s_marker_x = e.x < 0 ? 0 : e.x >= LCD_W ? LCD_W - 1 : e.x;
            } else if (s_zoomed) {
                s_zoomed = false; s_marker_x = -1; reset_view();
            } else {
                zoom_to(&VIEWS[s_view], channel_at(cur_view(), e.x));
                s_marker_x = -1; reset_view();
            }
            break;
        }
    }
}

bool eng_spectrum_local_command(const char *line, eng_send_fn send)
{
    int x, y;
    char d;
    if (!strcmp(line, "SNAP"))  { s_send = send; s_snap_req = true; return true; }
    if (!strcmp(line, "DTAP"))  { post(EV_DTAP, 0, 0); return true; }
    if (!strcmp(line, "HOLD"))  { post(EV_HOLD, 0, 0); return true; }
    if (sscanf(line, "SWIPE %c", &d) == 1 && (d == 'L' || d == 'R')) { post(d == 'L' ? EV_SWIPE_L : EV_SWIPE_R, 0, 0); return true; }
    if (sscanf(line, "TAP %d %d", &x, &y) == 2) { post(EV_TAP, x, y); return true; }
    return false;
}

#ifdef ENG_BOARD_TOUCH28
// CST3530 touch, polled. Protocol from Waveshare's driver: read 9 bytes at 0xD0070000, then write 0xD00002AB.
// Coordinates are panel pixels, the same way up as this screen.
#define TOUCH_ADDR  0x58
#define T_POLL_MS   25
#define T_SWIPE_PX  50
#define T_TAP_PX    15
#define T_TAP_MS    400
#define T_DOUBLE_MS 300
#define T_HOLD_MS   1000
static i2c_master_dev_handle_t s_touch;

static bool touch_point(int *x, int *y)
{
    static const uint8_t data_reg[4] = {0xD0, 0x07, 0x00, 0x00};
    static const uint8_t end_reg[4]  = {0xD0, 0x00, 0x02, 0xAB};
    uint8_t b[9];
    if (i2c_master_transmit_receive(s_touch, data_reg, 4, b, sizeof b, 50) != ESP_OK) return false;
    i2c_master_transmit(s_touch, end_reg, 4, 50);
    if ((b[3] & 0x0F) == 0 || (b[8] & 0xF0) == 0) return false;
    *x = ((b[7] & 0x0F) << 8) | b[4];
    *y = ((b[7] & 0xF0) << 4) | b[5];
    return true;
}

static void touch_task(void *arg)
{
    (void)arg;
    bool down = false, held = false, pending = false;
    int x0 = 0, y0 = 0, x = 0, y = 0, px = 0, py = 0;
    int64_t t0 = 0, tap_t = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(T_POLL_MS));
        int64_t now = esp_timer_get_time() / 1000;
        int nx, ny;
        if (touch_point(&nx, &ny)) {
            if (!down) { down = true; held = false; x0 = nx; y0 = ny; t0 = now; }
            x = nx; y = ny;
            if (!held && abs(x - x0) < T_TAP_PX && abs(y - y0) < T_TAP_PX && now - t0 >= T_HOLD_MS) {
                held = true; pending = false;
                post(EV_HOLD, x, y);
            }
        } else if (down) {
            down = false;
            int dx = x - x0, dy = y - y0;
            if (held) {
                // the hold already acted
            } else if (abs(dx) >= T_SWIPE_PX && abs(dx) > 2 * abs(dy)) {
                pending = false;
                post(dx < 0 ? EV_SWIPE_L : EV_SWIPE_R, 0, 0);
            } else if (abs(dx) < T_TAP_PX && abs(dy) < T_TAP_PX && now - t0 <= T_TAP_MS) {
                // A tap waits T_DOUBLE_MS for a second one, so a double tap does
                // not also act as a single tap.
                if (pending && now - tap_t <= T_DOUBLE_MS) { pending = false; post(EV_DTAP, 0, 0); }
                else { pending = true; tap_t = now; px = x0; py = y0; }
            }
        }
        if (pending && !down && now - tap_t > T_DOUBLE_MS) { pending = false; post(EV_TAP, px, py); }
    }
}

static void touch_start(void)
{
    i2c_master_bus_handle_t bus = eng_lcd_i2c_bus();
    i2c_device_config_t dc = { .device_address = TOUCH_ADDR, .scl_speed_hz = 400000 };
    if (!bus || i2c_master_bus_add_device(bus, &dc, &s_touch) != ESP_OK) return;
    xTaskCreate(touch_task, "eng_touch", 3072, NULL, 5, NULL);
}
#endif

// ─── A companion app in the other app slot ──────────────────────────────────
// Optional. On a board flashed with two apps (an OTA partition table: the
// companion in app0, this analyser in app1), a 3 s BOOT hold switches to the
// companion. Build with -DENG_OTHER_APP=<its PROJECT_NAME> to turn it on: only
// a slot whose app has that name is started. Without it, or flashed on its own
// with ESP-SDR's single-app table, the hold does nothing.
static void switch_to_engineer(void)
{
#ifndef ENG_OTHER_APP
    return;
#else
    const esp_partition_t *other = esp_ota_get_next_update_partition(NULL);
    esp_app_desc_t d;
    if (!other || esp_ota_get_partition_description(other, &d) != ESP_OK ||
        strcmp(d.project_name, ENG_OTHER_APP) != 0) return;
    for (int sy = 0; sy < LCD_H; sy += STRIP_H) {
        int h = (sy + STRIP_H > LCD_H) ? LCD_H - sy : STRIP_H;
        for (int i = 0; i < LCD_W * h; i++) s_strip[i] = C_BG;
        const char *a = "SWITCHING APP";
        text(sy, (LCD_W - eng_font_width(a, 2)) / 2, LCD_H / 2 - 7, a, 2, C_TEXT);
        eng_lcd_push(0, sy, LCD_W, h, s_strip);
    }
    if (esp_ota_set_boot_partition(other) == ESP_OK) esp_restart();
#endif
}

void eng_spectrum_run(eng_tune_fn tune, eng_spectrum_fn spectrum,
                      eng_host_waiting_fn host_waiting, eng_host_serve_fn host_serve)
{
    colours_init();
    s_wf = heap_caps_calloc(WF_H, LCD_W, MALLOC_CAP_INTERNAL);
    s_strip = heap_caps_malloc(LCD_W * STRIP_H * sizeof(uint16_t), MALLOC_CAP_INTERNAL);
    s_codes = heap_caps_malloc(FFT_N, MALLOC_CAP_INTERNAL);
    s_shift = heap_caps_malloc(FFT_N, MALLOC_CAP_INTERNAL);
    s_avg = heap_caps_malloc(LCD_W * sizeof(float), MALLOC_CAP_INTERNAL);
    s_row_sum = heap_caps_malloc(LCD_W * sizeof(float), MALLOC_CAP_INTERNAL);
    if (!s_wf || !s_strip || !s_codes || !s_shift || !s_avg || !s_row_sum) abort();
    eng_lcd_init();
    gpio_config_t io = { .pin_bit_mask = 1ULL << BOOT_BTN, .mode = GPIO_MODE_INPUT,
                         .pull_up_en = GPIO_PULLUP_ENABLE };
    gpio_config(&io);
    xTaskCreate(button_task, "eng_btn", 2048, NULL, 5, NULL);
    s_ev = xQueueCreate(8, sizeof(ev_t));
    if (!s_ev) abort();
#ifdef ENG_BOARD_TOUCH28
    touch_start();
#endif
    reset_view();

    for (;;) {
        if (s_switch) { s_switch = false; switch_to_engineer(); }
        if (s_next) { s_next = false; set_view(s_view + 1); }
        if (s_peak_toggle) { s_peak_toggle = false; s_peak_on = !s_peak_on; memset(s_peak, 0, sizeof s_peak); }
        handle_events();
        const view_t *v = cur_view();

        // Frozen: no sweeps, the picture held, but the marker and zoom-out still
        // work and a viewer can still take over.
        if (s_frozen) {
            if (host_waiting && host_waiting()) {
                draw_host_screen(); host_serve(); s_frozen = false; reset_view(); continue;
            }
            render(v, 0);
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        int64_t t0 = esp_timer_get_time();
        memset(s_col, 0, sizeof s_col);
        unsigned span = v->end - v->start;
        unsigned segs = (span + SEG_MHZ - 1) / SEG_MHZ;
        bool ok = true;
        bool hosted = false;
        for (unsigned k = 0; k < segs && !s_next && !uxQueueMessagesWaiting(s_ev); k++) {
            if (host_waiting && host_waiting()) {
                draw_host_screen();
                host_serve();            // until the viewer goes quiet
                reset_view();
                hosted = true;
                break;
            }
            ok &= sweep_segment(v, k, v->start + SEG_MHZ / 2 + k * SEG_MHZ, tune, spectrum);
            vTaskDelay(1);   // let the idle task and the button run
        }
        if (hosted) continue;
        if (s_next || !ok || uxQueueMessagesWaiting(s_ev)) continue;
        int64_t sweep_ms = (esp_timer_get_time() - t0) / 1000;

        for (int x = 0; x < LCD_W; x++) if (s_col[x] > s_peak[x]) s_peak[x] = s_col[x];
        // Trace: running power average across sweeps.
        for (int x = 0; x < LCD_W; x++) {
            float p = to_lin(s_col[x]);
            s_avg[x] = s_avg[x] < 0 ? p : s_avg[x] * 0.75f + p * 0.25f;
            s_shown[x] = to_code(s_avg[x]);
        }
        // Waterfall: one row per ROW_MS, the power average of its sweeps.
        for (int x = 0; x < LCD_W; x++) s_row_sum[x] += to_lin(s_col[x]);
        s_row_n++;
        if (esp_timer_get_time() - s_row_t0 >= ROW_MS * 1000LL) {
            memmove(s_wf[1], s_wf[0], (WF_H - 1) * LCD_W);
            for (int x = 0; x < LCD_W; x++) s_wf[0][x] = code_to_heat(to_code(s_row_sum[x] / s_row_n));
            memset(s_row_sum, 0, LCD_W * sizeof(float));
            s_row_n = 0;
            s_row_t0 = esp_timer_get_time();
            if (s_wf_rows < WF_H) s_wf_rows++;
        }

        // Battery, every 5 s: one I2C read on the 2.8" board, nothing on the 1.47".
        if (esp_timer_get_time() - s_batt_t >= 5000000LL) {
            s_batt_t = esp_timer_get_time();
            float b = eng_lcd_battery_v();
            s_batt = b < 0 ? -1 : s_batt < 0 ? b : s_batt * 0.7f + b * 0.3f;
        }
        render(v, sweep_ms);
        // Started from the engineer screen: confirm this app once it has drawn,
        // or the bootloader's rollback returns to the engineer screen on the
        // next restart. A crash before here rolls back by itself, as it should.
        static bool confirmed;
        if (!confirmed) { confirmed = true; esp_ota_mark_app_valid_cancel_rollback(); }
    }
}
