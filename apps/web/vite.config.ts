// This Vite config serves the Aurora PWA in development and builds the offline shell for production.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The authoritative server runs on 8787 in development; HTTP and WebSocket
// traffic is proxied so the browser only ever talks to one same-origin host.
const SERVER_ORIGIN = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: true },
      "/sync/ws": {
        target: SERVER_ORIGIN.replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
