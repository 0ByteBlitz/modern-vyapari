import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as path from "path";

// Vite builds ONLY the renderer. Main process + preload stay on plain tsc
// (no bundler in the money path).
export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
      // Shared IPC contract types. Type-only today (erased at build), but
      // aliased so the import path is stable if a shared constant is ever
      // added.
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          "recharts": ["recharts"],
          "klinecharts": ["klinecharts"],
          "lucide-react": ["lucide-react"]
        }
      }
    }
  },
});
