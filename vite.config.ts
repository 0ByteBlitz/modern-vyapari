import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as path from "path";
import * as fs from "fs";

/* The titlebar showed a hardcoded "0.1.0" while the release was 0.1.0-alpha.5.
   One source: package.json, baked in at build time. */
const APP_VERSION: string = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")).version;

// Vite builds ONLY the renderer. Main process + preload stay on plain tsc
// (no bundler in the money path).
export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
    rolldownOptions: {
      output: {
        // Rolldown (Vite 8) only accepts the function form.
        manualChunks(id: string) {
          for (const pkg of ["klinecharts", "lucide-react"]) {
            if (id.includes(`/node_modules/${pkg}/`)) return pkg;
          }
          return undefined;
        }
      }
    }
  },
});
