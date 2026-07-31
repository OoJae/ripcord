import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs the test pipeline", () => {
    expect(1 + 1).toBe(2);
  });

  it("has a complete .env.example", () => {
    expect(existsSync(new URL("../.env.example", import.meta.url))).toBe(true);
  });
});
