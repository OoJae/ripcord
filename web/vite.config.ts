import { resolve } from "node:path";
import { defineConfig } from "vite";

// MPA: three real pages, real URLs, real <a href> navigation between them.
// outDir stays "dist" — the root repo's biome/.gitignore patterns depend on it.
export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        evidence: resolve(import.meta.dirname, "evidence.html"),
        system: resolve(import.meta.dirname, "system.html"),
      },
    },
  },
});
