import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dev: `npm run dev` proxies the API to the backend. Build: output goes to backend/public,
// which the backend serves at "/".
export default defineConfig({
  plugins: [react()],
  // hls.js (~600 kB) is loaded on demand, only when the HLS mode is chosen.
  build: { outDir: "../backend/public", emptyOutDir: true, chunkSizeWarningLimit: 700 },
  test: { environment: "jsdom" },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/health": "http://127.0.0.1:3100",
    },
  },
});
