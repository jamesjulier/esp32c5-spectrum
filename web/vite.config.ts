import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json" with { type: "json" };

// Relative paths, so the same build works at a GitHub Pages project address
// (https://<user>.github.io/esp32c5-spectrum/) and anywhere else.
export default defineConfig({
  base: "./",
  // The release version, from package.json, shown in the footer.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "favicon.svg"],
      manifest: {
        name: "ESP32-C5 Spectrum",
        short_name: "Spectrum",
        description: "A 2.4 and 5 GHz spectrum analyser on an ESP32-C5, over USB.",
        theme_color: "#0f1216",
        background_color: "#0f1216",
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
        // Local test recordings (gitignored, never published) stay out of the cache.
        globIgnores: ["**/replay*.json"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
});
