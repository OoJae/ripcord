import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// MPA: three real pages, real URLs, real <a href> navigation between them.
// outDir stays "dist" — the root repo's biome/.gitignore patterns depend on it.
export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        evidence: fileURLToPath(new URL("evidence.html", import.meta.url)),
        system: fileURLToPath(new URL("system.html", import.meta.url)),
      },
    },
  },
});
