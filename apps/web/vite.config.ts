import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.API_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/hooks": { target, changeOrigin: false },
      "/mcp": { target, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
