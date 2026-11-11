import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Relative paths, so the same build works at a GitHub Pages project address
// (https://<user>.github.io/esp32c5-spectrum/) and anywhere else.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "ESP32-C5 Spectrum",
        short_name: "Spectrum",
        description: "A 2.4 and 5 GHz spectrum analyser on an ESP32-C5, over USB.",
        theme_color: "#0b1018",
        background_color: "#0b1018",
        display: "standalone",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The firmware images too, so the installed app can flash a board offline.
        globPatterns: ["**/*.{js,css,html,svg,png,json,bin}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
});
