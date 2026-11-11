// SPDX-License-Identifier: GPL-3.0-or-later
#include "eng_lcd.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>

#ifdef ENG_BOARD_TOUCH28
// Waveshare ESP32-C5-Touch-LCD-2.8, from its schematic and BSP. LCD reset and
// the backlight are not ESP pins: they hang off a CH32V003 I/O expander on I2C.
#include "driver/i2c_master.h"
#define PIN_SCLK  6
#define PIN_MOSI  7
#define PIN_CS   10
#define PIN_DC    9
#define PIN_RST  -1              // CH32 EXIO1
#define PIN_SDA   0
#define PIN_SCL   1
#define CH32_ADDR 0x24
#define CH32_DIR  0x02           // 1 = output
#define CH32_OUT  0x03
#define CH32_PWM  0x05           // backlight, 0-255
#define CH32_ADC  0x06           // BAT_ADC, 10-bit, little-endian
#define EXIO_TP_RST (1 << 0)
#define EXIO_LCD_RST (1 << 1)
#define GAP_Y     0
#elif defined(ENG_BOARD_TDONGLE)
// LilyGO T-Dongle-C5, from LilyGO's pin_config.h (github.com/Xinyuan-LilyGO/
// T-Dongle-C5). The SD card slot shares the SPI bus, with its own CS.
#define PIN_SCLK  6
#define PIN_MOSI  2
#define PIN_CS   10
#define PIN_DC    3
#define PIN_RST   1
#define PIN_BL    0              // active LOW
#define PIN_SD_CS 23
#define PIN_LED_CI 4             // APA102 clock
#define PIN_LED_DI 5             // APA102 data
// The 80 x 160 panel sits inside the ST7735's 132 x 162 at column 26, row 1;
// sideways, those become y and x (LilyGO's setAddrWindow).
#define GAP_X     1
#define GAP_Y    26
#else
// Waveshare ESP32-C5-LCD-1.47. Pins from Waveshare's schematic and BSP.
#define PIN_SCLK  7
#define PIN_MOSI  6
#define PIN_CS   23
#define PIN_DC   24
#define PIN_RST  26
#define PIN_BL   10
// The 172 visible columns sit in the middle of the controller's 240, so the
// 34-pixel gap moves to y once x and y swap.
#define GAP_Y    34
#endif
#ifdef ENG_BOARD_TDONGLE
#define SPI_HZ   20000000        // as LilyGO's driver; an ST7735 is slower than an ST7789
#else
#define SPI_HZ   40000000
#endif

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;


__attribute__((unused)) static void cmd(uint8_t c, const uint8_t *d, size_t n)
{
    esp_lcd_panel_io_tx_param(s_io, c, d, n);
}

// The voltage and gamma settings LovyanGFX sends to an ST7789. On this panel
// the factory settings (all esp_lcd and Waveshare's driver send) cannot show
// black: it came out a washed pink-grey on the bench, 2026-10-19. These gave a
// true black on the same board. RAMCTRL is left to
// esp_lcd, which owns the byte order.
#ifdef ENG_BOARD_TOUCH28
static i2c_master_dev_handle_t s_ch32;
static i2c_master_bus_handle_t s_bus;
i2c_master_bus_handle_t eng_lcd_i2c_bus(void) { return s_bus; }

static void ch32_write(uint8_t reg, uint8_t val)
{
    i2c_master_transmit(s_ch32, (const uint8_t[]){reg, val}, 2, 100);
}

// Resets the panel (EXIO1) and holds touch out of reset (EXIO0), as
// Waveshare's BSP does. EXIO3, the speaker amplifier, stays an input.
static void board_init(void)
{
    i2c_master_bus_config_t bc = {
        .i2c_port = 0, .sda_io_num = PIN_SDA, .scl_io_num = PIN_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = 1,
    };
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    s_bus = bus;
    i2c_device_config_t dc = { .device_address = CH32_ADDR, .scl_speed_hz = 400000 };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &s_ch32));
    ch32_write(CH32_DIR, EXIO_TP_RST | EXIO_LCD_RST);
    ch32_write(CH32_OUT, EXIO_TP_RST);
    vTaskDelay(pdMS_TO_TICKS(20));
    ch32_write(CH32_OUT, EXIO_TP_RST | EXIO_LCD_RST);
    vTaskDelay(pdMS_TO_TICKS(120));
}

// VBAT reaches the CH32's ADC through 200K over 100K, so a third of it.
float eng_lcd_battery_v(void)
{
    uint8_t r[2];
    if (i2c_master_transmit_receive(s_ch32, (const uint8_t[]){CH32_ADC}, 1, r, 2, 100) != ESP_OK)
        return -1;
    return (r[0] | (r[1] << 8)) * 3.3f / 1023 * 3;
}
#else
float eng_lcd_battery_v(void) { return -1; }
#endif

#ifdef ENG_BOARD_TDONGLE
// The ST7735 settings LilyGO's driver sends after sleep-out: frame rate, power
// and gamma. esp_lcd has no ST7735 driver; its ST7789 one sends the commands
// the two share (sleep out, MADCTL, COLMOD, invert, window, display on), and
// these are the rest.
static void st7735_tuning(void)
{
    cmd(0xB1, (const uint8_t[]){0x01, 0x2C, 0x2D}, 3);                      // FRMCTR1
    cmd(0xB2, (const uint8_t[]){0x01, 0x2C, 0x2D}, 3);                      // FRMCTR2
    cmd(0xB3, (const uint8_t[]){0x01, 0x2C, 0x2D, 0x01, 0x2C, 0x2D}, 6);    // FRMCTR3
    cmd(0xB4, (const uint8_t[]){0x07}, 1);                                  // INVCTR
    cmd(0xC0, (const uint8_t[]){0xA2, 0x02, 0x84}, 3);                      // PWCTR1
    cmd(0xC1, (const uint8_t[]){0xC5}, 1);
    cmd(0xC2, (const uint8_t[]){0x0A, 0x00}, 2);
    cmd(0xC3, (const uint8_t[]){0x8A, 0x2A}, 2);
    cmd(0xC4, (const uint8_t[]){0x8A, 0xEE}, 2);
    cmd(0xC5, (const uint8_t[]){0x0E}, 1);                                  // VMCTR1
    cmd(0xE0, (const uint8_t[]){0x02, 0x1C, 0x07, 0x12, 0x37, 0x32, 0x29, 0x2D,
                                0x29, 0x25, 0x2B, 0x39, 0x00, 0x01, 0x03, 0x10}, 16);
    cmd(0xE1, (const uint8_t[]){0x03, 0x1D, 0x07, 0x06, 0x2E, 0x2C, 0x29, 0x2D,
                                0x2E, 0x2E, 0x37, 0x3F, 0x00, 0x00, 0x02, 0x10}, 16);
}

// The APA102 LED keeps whatever it held, or comes up lit, so it is sent one
// "off" frame. Bit-banged: one LED, once, at start-up.
static void apa102_off(void)
{
    gpio_config_t io = { .pin_bit_mask = (1ULL << PIN_LED_CI) | (1ULL << PIN_LED_DI),
                         .mode = GPIO_MODE_OUTPUT };
    gpio_config(&io);
    const uint8_t frame[] = { 0, 0, 0, 0, 0xE0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF };
    for (size_t i = 0; i < sizeof frame; i++)
        for (int b = 7; b >= 0; b--) {
            gpio_set_level(PIN_LED_DI, (frame[i] >> b) & 1);
            gpio_set_level(PIN_LED_CI, 1);
            gpio_set_level(PIN_LED_CI, 0);
        }
}
#endif

__attribute__((unused)) static void panel_tuning(void)
{
    cmd(0xB7, (const uint8_t[]){0x35}, 1);                    // gate control
    cmd(0xBB, (const uint8_t[]){0x28}, 1);                    // VCOM
    cmd(0xC0, (const uint8_t[]){0x0C}, 1);                    // LCM control
    cmd(0xC2, (const uint8_t[]){0x01, 0xFF}, 2);              // VDV/VRH enable
    cmd(0xC3, (const uint8_t[]){0x10}, 1);                    // VRH
    cmd(0xC4, (const uint8_t[]){0x20}, 1);                    // VDV
    cmd(0xD0, (const uint8_t[]){0xA4, 0xA1}, 2);              // power control 1
    cmd(0xE0, (const uint8_t[]){0xD0, 0x00, 0x02, 0x07, 0x0A, 0x28, 0x32,
                                0x44, 0x42, 0x06, 0x0E, 0x12, 0x14, 0x17}, 14);
    cmd(0xE1, (const uint8_t[]){0xD0, 0x00, 0x02, 0x07, 0x0A, 0x28, 0x31,
                                0x54, 0x47, 0x0E, 0x1C, 0x17, 0x1B, 0x1E}, 14);
}

void eng_lcd_init(void)
{
#ifdef ENG_BOARD_TOUCH28
    board_init();
#endif
#ifdef ENG_BOARD_TDONGLE
    apa102_off();
    // Keep the SD card off the shared bus.
    gpio_config_t sd = { .pin_bit_mask = 1ULL << PIN_SD_CS, .mode = GPIO_MODE_OUTPUT };
    gpio_config(&sd);
    gpio_set_level(PIN_SD_CS, 1);
#endif
    spi_bus_config_t bus = {
        .sclk_io_num = PIN_SCLK, .mosi_io_num = PIN_MOSI, .miso_io_num = -1,
        .quadwp_io_num = -1, .quadhd_io_num = -1,
        .max_transfer_sz = LCD_W * 20 * 2 + 8,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
    esp_lcd_panel_io_spi_config_t io = {
        .dc_gpio_num = PIN_DC, .cs_gpio_num = PIN_CS, .pclk_hz = SPI_HZ,
        .lcd_cmd_bits = 8, .lcd_param_bits = 8, .spi_mode = 0, .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io, &s_io));
    esp_lcd_panel_dev_config_t dev = {
        .reset_gpio_num = PIN_RST,
#ifdef ENG_BOARD_TOUCH28
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,     // as Waveshare's BSP for this board
#elif defined(ENG_BOARD_TDONGLE)
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,     // LilyGO's driver always sets MADCTL BGR
#else
        // BGR, although Waveshare's BSP says RGB: a test card of known colours
        // on this board (2026-10-20) showed red and blue exchanged under RGB.
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
#endif
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(s_io, &dev, &s_panel));
    esp_lcd_panel_reset(s_panel);
    esp_lcd_panel_init(s_panel);
#if defined(ENG_BOARD_TDONGLE)
    st7735_tuning();
#elif !defined(ENG_BOARD_TOUCH28)
    panel_tuning();               // the 1.47's panel only; see panel_tuning()
#endif
    esp_lcd_panel_invert_color(s_panel, true);         // as Waveshare's BSP and LilyGO's driver
#ifndef ENG_BOARD_TOUCH28
    // Sideways: swap the axes. On the dongle this is LilyGO's rotation 3
    // (MADCTL MY + MV), USB plug on the left.
    esp_lcd_panel_swap_xy(s_panel, true);
    esp_lcd_panel_mirror(s_panel, false, true);
#ifdef ENG_BOARD_TDONGLE
    esp_lcd_panel_set_gap(s_panel, GAP_X, GAP_Y);
#else
    esp_lcd_panel_set_gap(s_panel, 0, GAP_Y);
#endif
#endif
    esp_lcd_panel_disp_on_off(s_panel, true);

#if defined(ENG_BOARD_TOUCH28)
    ch32_write(CH32_PWM, 255);    // backlight full 
#elif defined(ENG_BOARD_TDONGLE)
    gpio_config_t bl = { .pin_bit_mask = 1ULL << PIN_BL, .mode = GPIO_MODE_OUTPUT };
    gpio_config(&bl);
    gpio_set_level(PIN_BL, 0);    // active low: on
#else
    // Backlight full on. A plain pin, not LEDC dimming: LEDC's HAL costs fast
    // RAM this build does not have to spare (see sdkconfig.waveshare).
    gpio_config_t bl = { .pin_bit_mask = 1ULL << PIN_BL, .mode = GPIO_MODE_OUTPUT };
    gpio_config(&bl);
    gpio_set_level(PIN_BL, 1);
#endif
}

static eng_lcd_send_fn s_snap;

// A send that fails (the host stopped reading) ends the snapshot there. Each
// failed send waits out the serial driver's timeout, about 3 s, so carrying on
// would freeze the screen for the rest of the frame (hours on the 2.8").
void eng_lcd_snap(eng_lcd_send_fn send, bool on)
{
    char head[40];
    if (on) {
        int n = snprintf(head, sizeof head, "\nSNAP BEGIN %d %d\n", LCD_W, LCD_H);
        s_snap = send(head, n) ? send : NULL;
    } else {
        if (s_snap) s_snap(head, snprintf(head, sizeof head, "SNAP END\n"));
        s_snap = NULL;
    }
}

// One row as hex, sent in pieces small enough for the USB driver's buffer.
static void snap_rows(int w, int h, const uint16_t *px)
{
    static const char hex[] = "0123456789abcdef";
    char out[129];
    for (int r = 0; r < h && s_snap; r++) {
        int n = 0;
        for (int i = 0; i < w; i++) {
            uint16_t v = px[r * w + i];
            out[n++] = hex[v >> 12]; out[n++] = hex[(v >> 8) & 15];
            out[n++] = hex[(v >> 4) & 15]; out[n++] = hex[v & 15];
            if (n == 128) {
                if (!s_snap(out, n)) { s_snap = NULL; return; }
                n = 0;
            }
        }
        out[n++] = '\n';
        if (!s_snap(out, n)) { s_snap = NULL; return; }
    }
}

void eng_lcd_push(int x, int y, int w, int h, const uint16_t *px)
{
    if (s_snap && x == 0 && w == LCD_W) snap_rows(w, h, px);
    // Copied to a DMA-capable buffer from the heap (see eng_spectrum_ui.c on the
    // RF dump bank), byte-swapped: the panel takes RGB565 big-endian and the CPU
    // holds it little-endian. Proven with a test card, 2026-10-20: unswapped,
    // black drew navy and green drew blue.
    static uint16_t *dma;
    if (!dma) dma = heap_caps_malloc(LCD_W * 20 * sizeof(uint16_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    int n = w * h;
    if (!dma || n > LCD_W * 20) return;
    for (int i = 0; i < n; i++) dma[i] = (uint16_t)((px[i] >> 8) | (px[i] << 8));
    esp_lcd_panel_draw_bitmap(s_panel, x, y, x + w, y + h, dma);
    // draw_bitmap queues the transfer; a parameter write waits for it, so `dma`
    // is free again when this returns.
    esp_lcd_panel_io_tx_param(s_io, 0x00, NULL, 0);   // NOP
}
