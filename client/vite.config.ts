import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // L'enregistrement est fait dans main.tsx (désactivé dans Tauri).
      injectRegister: false,
      registerType: "autoUpdate",
      manifest: {
        name: "Nexa ERP",
        short_name: "Nexa",
        lang: "fr",
        display: "standalone",
        start_url: "/",
        background_color: "#eef1f4",
        theme_color: "#0e5a4f",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        navigateFallback: "index.html",
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    // En développement, l'API locale est jointe via le même port (pas de CORS à configurer,
    // utile dans Codespaces où un seul port est exposé).
    proxy: Object.fromEntries(
      ["/auth", "/sync", "/users", "/roles", "/health"].map((path) => [path, "http://localhost:8080"]),
    ),
  },
  clearScreen: false,
});
