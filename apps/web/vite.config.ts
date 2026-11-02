import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/auth": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    maxWorkers: 2,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
