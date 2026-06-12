import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4317"
    },
    allowedHosts: [".ts.net", "localhost", "127.0.0.1"]
  },
  preview: {
    allowedHosts: [".ts.net", "localhost", "127.0.0.1"]
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"]
  }
});
