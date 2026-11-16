import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Three windows, three pages: the chat panel, the mascot and the settings dashboard.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120", // WebView2 on Windows 10/11
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        mascot: resolve(import.meta.dirname, "mascot.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
      },
    },
  },
});
