/**
 * Property-based tests (fast-check) for the threshold policy:
 *  P1 — hf strictly above warn can never reach act/panic (so never defends).
 *  P2 — totality: any hfWad in [0, 2^256-1] with any state yields a valid band, never throws.
 *  P3 — monotonic severity on a fresh armed state: lower hf is never less severe.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { THRESHOLDS_WAD } from "../../src/config.js";
import { evaluate } from "../../src/policy/thresholds.js";
import type { Band, PolicyState } from "../../src/types.js";
import { MAX_UINT256 } from "../fixtures/aave.js";
import { makeSnapshot } from "../helpers/fakes.js";

const BANDS: readonly Band[] = ["healthy", "warn", "act", "panic"];
const SEVERITY: Record<Band, number> = { healthy: 0, warn: 1, act: 2, panic: 3 };
const NUM_RUNS = 100;
const T0 = 1_753_920_000_000;

const bandArb = fc.constantFrom<Band>("healthy", "warn", "act", "panic");

const stateArb: fc.Arbitrary<PolicyState> = fc.record({
  armed: fc.boolean(),
  lastFiredAtMs: fc.option(fc.nat(), { nil: null }),
  lastBand: bandArb,
});

const nowArb = fc.nat();

/** hasDebt=true snapshot with an explicit hfWad override (band uses the wad only). */
function snapAt(hfWad: bigint) {
  return makeSnapshot("1.20", { hfWad, hasDebt: true });
}

describe("thresholds properties", () => {
  it("P1: forall hfWad > warn and arbitrary state — band is never act/panic and never defends", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: THRESHOLDS_WAD.warn + 1n, max: MAX_UINT256 }),
        stateArb,
        nowArb,
        (hfWad, state, nowMs) => {
          const r = evaluate(snapAt(hfWad), THRESHOLDS_WAD, state, nowMs);
          expect(r.band).not.toBe("act");
          expect(r.band).not.toBe("panic");
          expect(r.shouldDefend).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2: totality — forall hfWad in [0, 2^256-1] and arbitrary state, returns one of the 4 bands and never throws", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_UINT256 }),
        stateArb,
        nowArb,
        (hfWad, state, nowMs) => {
          const r = evaluate(snapAt(hfWad), THRESHOLDS_WAD, state, nowMs);
          expect(BANDS).toContain(r.band);
          expect(typeof r.shouldDefend).toBe("boolean");
          expect(typeof r.expedited).toBe("boolean");
          expect(typeof r.reason).toBe("string");
          expect(r.nextState.lastBand).toBe(r.band);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("P3: monotonic severity on a fresh armed state — hf1 <= hf2 implies severity(hf1) >= severity(hf2)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_UINT256 }),
        fc.bigInt({ min: 0n, max: MAX_UINT256 }),
        (a, b) => {
          const lo = a <= b ? a : b;
          const hi = a <= b ? b : a;
          const fresh = (): PolicyState => ({
            armed: true,
            lastFiredAtMs: null,
            lastBand: "healthy",
          });
          const rLo = evaluate(snapAt(lo), THRESHOLDS_WAD, fresh(), T0);
          const rHi = evaluate(snapAt(hi), THRESHOLDS_WAD, fresh(), T0);
          expect(SEVERITY[rLo.band]).toBeGreaterThanOrEqual(SEVERITY[rHi.band]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
