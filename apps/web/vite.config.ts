import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      // Installable in the dev server too, so add-to-home-screen works over Tailscale
      // without a separate build step.
      devOptions: { enabled: true, type: "module" },
      manifest: {
        name: "MiSonos",
        short_name: "MiSonos",
        description: "Sonos controller",
        theme_color: "#141716",
        background_color: "#141716",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // Never let the SW intercept bridge calls — SSE (/api/events) and dynamic
        // endpoints must always hit the network.
        navigateFallbackDenylist: [/^\/api\//],
        // Quiet the verbose dev-mode console logging ("No route found" / "Precaching
        // did not find a match") that fired for every uncached bridge call.
        disableDevLogs: true,
        runtimeCaching: [
          {
            // Album art is keyed by the encoded upstream URL, so it's safe to cache.
            // Same-origin only — art from a switched-to (cross-origin) backend bypasses
            // the SW and loads directly, like the rest of that host's API.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname === "/api/art",
            handler: "CacheFirst",
            options: {
              cacheName: "album-art",
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Same-origin bridge calls always hit the network and are never cached.
            // A registered route stops workbox falling through to "No route found".
            // Cross-origin calls (to a switched-to backend) and the SSE stream are left
            // to bypass the SW entirely so they go straight to the target host.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/") && url.pathname !== "/api/events",
            handler: "NetworkOnly"
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4317"
    },
    allowedHosts: [".ts.net", "localhost", "127.0.0.1"]
  },
  preview: {
    proxy: {
      "/api": "http://127.0.0.1:4317"
    },
    allowedHosts: [".ts.net", "localhost", "127.0.0.1"]
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"]
  }
});
