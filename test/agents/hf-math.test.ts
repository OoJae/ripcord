/**
 * The arithmetic the agents are NOT allowed to do themselves.
 *
 * These figures are quoted to the Planner and the Critic as VERIFIED FIGURES and
 * are what the Guard gates on, so a rounding error here is not cosmetic — it
 * decides whether a real defense executes.
 */

import { describe, expect, it } from "vitest";
import { hfAfterRepay, hfAfterSupply, repayNeededForTarget } from "../../src/agents/hf-math.js";
import { makeSnapshot } from "../helpers/fakes.js";

/** The live Base Sepolia position on 2026-08-01, in the act band. */
const LIVE = makeSnapshot("1.2266", {
  totalCollateralUsd: 26.070307,
  totalDebtUsd: 17.997896,
  liquidationThresholdBps: 8450,
});

describe("repayNeededForTarget", () => {
  it("returns 0 for a position that already clears the target", () => {
    const healthy = makeSnapshot("2.00", { totalCollateralUsd: 100, totalDebtUsd: 10 });
    expect(repayNeededForTarget(healthy, 1.6)).toBe(0);
  });

  it("rounds UP to whole cents, never down, and never by more than a cent", () => {
    // Regression: this is the exact live case that stalled the first armed run.
    // The unrounded requirement was $4.2295 and the prompt rendered it at 2dp.
    const exact = LIVE.totalDebtUsd - (LIVE.totalCollateralUsd * 0.845) / 1.6;
    const needed = repayNeededForTarget(LIVE, 1.6);

    expect(needed).toBeGreaterThanOrEqual(exact); // never a cent short
    expect(needed - exact).toBeLessThan(0.01); // never gratuitously over
    expect(needed).toBe(Number(needed.toFixed(2))); // a whole number of cents
  });

  it("does not jump a whole cent for a value already sitting on one", () => {
    // Math.ceil(x * 100) / 100 is not idempotent in binary floating point:
    // 4.23 * 100 === 423.00000000000006, which would ceil to 4.24.
    const onACent = makeSnapshot("1.20", {
      totalCollateralUsd: 20,
      totalDebtUsd: 20 - (20 * 0.8) / 1.6 + 1.5, // exact requirement = $1.50
      liquidationThresholdBps: 8000,
    });
    expect(repayNeededForTarget(onACent, 1.6)).toBeCloseTo(1.5, 10);
  });

  it("the amount it returns always CLEARS the target, never lands just under", () => {
    // The property that actually matters. A cent short means the Critic rejects
    // with "hfAfter 1.5999 is below the target 1.6" and no defense ever runs.
    for (const [collateral, debt, ltBps] of [
      [26.070307, 17.997896, 8450],
      [42.353269, 17.997896, 8450],
      [30, 20, 8000],
      [100.01, 71.239, 8250],
      [13.337, 9.111, 7700],
    ] as const) {
      const snap = makeSnapshot("1.20", {
        totalCollateralUsd: collateral,
        totalDebtUsd: debt,
        liquidationThresholdBps: ltBps,
      });
      const needed = repayNeededForTarget(snap, 1.6);
      if (needed === 0) continue;
      expect(hfAfterRepay(snap, needed)).toBeGreaterThanOrEqual(1.6);
    }
  });

  it("clears the target by a margin the Critic's display can show as >= 1.6000", () => {
    // The Critic reads hfAfter rendered to 4dp. 1.59995 would print as "1.5999".
    const needed = repayNeededForTarget(LIVE, 1.6);
    expect(hfAfterRepay(LIVE, needed).toFixed(4)).not.toBe("1.5999");
  });
});

describe("hfAfterRepay / hfAfterSupply", () => {
  it("repaying the whole debt clears it entirely", () => {
    expect(hfAfterRepay(LIVE, LIVE.totalDebtUsd)).toBe(Number.POSITIVE_INFINITY);
    expect(hfAfterRepay(LIVE, LIVE.totalDebtUsd + 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("matches the live chain read", () => {
    // collateral $26.070307 x 84.50% / debt $17.997896 = 1.2240
    expect(hfAfterRepay(LIVE, 0)).toBeCloseTo(1.224, 4);
  });

  it("supplying collateral raises HF and repaying the same USD raises it more", () => {
    // Repaying shrinks the denominator; supplying only grows the numerator by LT.
    expect(hfAfterSupply(LIVE, 5)).toBeGreaterThan(hfAfterRepay(LIVE, 0));
    expect(hfAfterRepay(LIVE, 5)).toBeGreaterThan(hfAfterSupply(LIVE, 5));
  });
});
