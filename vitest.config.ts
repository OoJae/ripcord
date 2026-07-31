import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // better-sqlite3 is a native addon; forks are the known-good pool for native modules.
    pool: "forks",
  },
});
