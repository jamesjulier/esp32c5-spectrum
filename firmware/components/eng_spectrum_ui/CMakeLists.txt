# SPDX-License-Identifier: GPL-3.0-or-later
idf_component_register(
    SRCS "eng_spectrum_ui.c" "eng_lcd.c" "eng_font.c" "eng_font_aa.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_lcd esp_driver_spi esp_driver_gpio esp_driver_i2c esp_timer freertos app_update
)
# BOARD=touch28 in build.sh: the Waveshare ESP32-C5-Touch-LCD-2.8.
if(ENG_BOARD STREQUAL "touch28")
    target_compile_definitions(${COMPONENT_LIB} PUBLIC ENG_BOARD_TOUCH28=1)
endif()
# BOARD=tdongle in build.sh: the LilyGO T-Dongle-C5.
if(ENG_BOARD STREQUAL "tdongle")
    target_compile_definitions(${COMPONENT_LIB} PUBLIC ENG_BOARD_TDONGLE=1)
endif()
# Optional companion app in the other OTA slot (see switch_to_engineer).
if(ENG_OTHER_APP)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "ENG_OTHER_APP=\"${ENG_OTHER_APP}\"")
endif()
# Keep the build machine's paths out of the image (__FILE__ in error checks).
target_compile_options(${COMPONENT_LIB} PRIVATE "-fmacro-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}=eng_spectrum_ui")
