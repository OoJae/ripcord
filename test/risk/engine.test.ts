/**
 * Risk engine — the §8.1 "test-count powerhouse".
 *
 * The engine is advisory (the defense pipeline never consumes it), but it is a
 * PAID product: a wrong score is a refund conversation. Every factor gets
 * boundary-exact example tests, and the aggregate gets property tests.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assessRisk,
  bufferRisk,
  concentrationRisk,
  gradeFor,
  healthFactorRisk,
  RISK_WEIGHTS,
  type RiskInput,
  riskFromAccountData,
  riskFromSnapshot,
  velocityRisk,
  volatilityRisk,
} from "../../src/risk/engine.js";
import { MAX_UINT256 } from "../fixtures/aave.js";
import { makeSnapshot } from "../helpers/fakes.js";

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    hf: 1.4,
    hasDebt: true,
    totalCollateralUsd: 45,
    totalDebtUsd: 26.68,
    availableBorrowsUsd: 9.32,
    hfVelocityPerMin: 0,
    collateralSymbol: "WETH",
    ...overrides,
  };
}

describe("risk: factor curves (boundary-exact)", () => {
  it("healthFactorRisk saturates at HF ≤ 1.0 and vanishes at HF ≥ 2.0", () => {
    expect(healthFactorRisk(0.5)).toBe(100);
    expect(healthFactorRisk(1.0)).toBe(100);
    expect(healthFactorRisk(1.5)).toBe(50);
    expect(healthFactorRisk(2.0)).toBe(0);
    expect(healthFactorRisk(5.0)).toBe(0);
    expect(healthFactorRisk(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("bufferRisk: 100 at/below liquidation, 0 once a 50% collateral drop is survivable", () => {
    expect(bufferRisk(1.0)).toBe(100); // zero tolerance
    expect(bufferRisk(0.9)).toBe(100); // already liquidatable
    expect(bufferRisk(2.0)).toBe(0); // 1 − 1/2 = 50% tolerance
    expect(bufferRisk(4.0)).toBe(0);
    // HF 1.25 → 20% drop tolerance → (0.5−0.2)/0.5 = 60
    expect(bufferRisk(1.25)).toBeCloseTo(60, 10);
    expect(bufferRisk(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("velocityRisk: recovery and stasis are free; −0.01/min saturates", () => {
    expect(velocityRisk(null)).toBe(0);
    expect(velocityRisk(0)).toBe(0);
    expect(velocityRisk(0.05)).toBe(0); // improving fast — still zero
    expect(velocityRisk(-0.005)).toBe(50);
    expect(velocityRisk(-0.01)).toBe(100);
    expect(velocityRisk(-1)).toBe(100); // clamped, not >100
    expect(velocityRisk(Number.NaN)).toBe(0); // corrupt input fails neutral
  });

  it("volatilityRisk knows the allowlisted collaterals and distrusts strangers", () => {
    expect(volatilityRisk("WETH")).toBe(50);
    expect(volatilityRisk("cbETH")).toBe(55);
    expect(volatilityRisk("cbETH")).toBeGreaterThan(volatilityRisk("WETH")); // staking premium
    expect(volatilityRisk("UNKNOWN")).toBe(60);
    expect(volatilityRisk("DOGE9000")).toBe(60); // unknown ⇒ worst recognized class
  });

  it("concentrationRisk is pure utilization of borrowing capacity", () => {
    expect(concentrationRisk(0, 100)).toBe(0);
    expect(concentrationRisk(50, 50)).toBe(50);
    expect(concentrationRisk(90, 10)).toBe(90);
    expect(concentrationRisk(100, 0)).toBe(100); // maxed out
    expect(concentrationRisk(-5, 10)).toBe(0); // corrupt negatives fail safe
    expect(concentrationRisk(5, -10)).toBe(100); // headroom floor at 0
  });

  it("gradeFor bands are half-open and cover [0,100]", () => {
    expect(gradeFor(0)).toBe("minimal");
    expect(gradeFor(19)).toBe("minimal");
    expect(gradeFor(20)).toBe("low");
    expect(gradeFor(39)).toBe("low");
    expect(gradeFor(40)).toBe("elevated");
    expect(gradeFor(59)).toBe("elevated");
    expect(gradeFor(60)).toBe("high");
    expect(gradeFor(79)).toBe("high");
    expect(gradeFor(80)).toBe("critical");
    expect(gradeFor(100)).toBe("critical");
  });
});

describe("risk: assessRisk on real position shapes", () => {
  it("the live mainnet position at HF 1.40 (act-adjacent) grades elevated", () => {
    // collateral $45, debt $26.68, headroom $9.32 — the actual Phase-2 setup.
    const r = assessRisk(input());
    // hf 60×.45 = 27 · buffer 42.86×.20 = 8.57 · vel 0 · WETH 50×.10 = 5
    // · util 74.1×.10 = 7.41  →  47.98 → 48
    expect(r.score).toBe(48);
    expect(r.grade).toBe("elevated");
    expect(r.flags).toEqual({ noDebt: false, noPosition: false, velocityUnknown: false });
  });

  it("a comfortable HF 2.0 position with slack grades minimal/low", () => {
    const r = assessRisk(
      input({ hf: 2.0, totalDebtUsd: 10, availableBorrowsUsd: 40, hfVelocityPerMin: 0 }),
    );
    expect(r.factors.healthFactor.value).toBe(0);
    expect(r.factors.bufferToLiquidation.value).toBe(0);
    expect(r.score).toBe(Math.round(50 * 0.1 + 20 * 0.1)); // only volatility+utilization
    expect(r.grade).toBe("minimal");
  });

  it("a panic-band position crashing fast grades critical", () => {
    const r = assessRisk(
      input({ hf: 1.05, hfVelocityPerMin: -0.02, totalDebtUsd: 95, availableBorrowsUsd: 0 }),
    );
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.grade).toBe("critical");
  });

  it("an already-liquidatable HF 0.98 maxes the position factors", () => {
    const r = assessRisk(input({ hf: 0.98 }));
    expect(r.factors.healthFactor.value).toBe(100);
    expect(r.factors.bufferToLiquidation.value).toBe(100);
  });

  it("no debt → score 0, minimal, flagged — regardless of everything else", () => {
    const r = assessRisk(
      input({
        hf: Number.POSITIVE_INFINITY,
        hasDebt: false,
        totalDebtUsd: 0,
        hfVelocityPerMin: -5, // even absurd inputs cannot conjure risk
        collateralSymbol: "cbETH",
      }),
    );
    expect(r.score).toBe(0);
    expect(r.grade).toBe("minimal");
    expect(r.flags.noDebt).toBe(true);
    expect(r.flags.noPosition).toBe(false); // still holds collateral
  });

  it("an empty account is noPosition, not merely noDebt", () => {
    const r = assessRisk(
      input({
        hf: Number.POSITIVE_INFINITY,
        hasDebt: false,
        totalCollateralUsd: 0,
        totalDebtUsd: 0,
        availableBorrowsUsd: 0,
      }),
    );
    expect(r.score).toBe(0);
    expect(r.flags.noPosition).toBe(true);
  });

  it("velocity warming up is flagged and neutral, not risky", () => {
    const withVel = assessRisk(input({ hfVelocityPerMin: 0 }));
    const warming = assessRisk(input({ hfVelocityPerMin: null }));
    expect(warming.flags.velocityUnknown).toBe(true);
    expect(warming.score).toBe(withVel.score);
  });

  it("weights sum to exactly 1 and every factor reports its own weight", () => {
    const total = Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
    const r = assessRisk(input());
    for (const [name, w] of Object.entries(RISK_WEIGHTS)) {
      expect(r.factors[name as keyof typeof r.factors].weight).toBe(w);
    }
  });
});

describe("risk: adapters", () => {
  it("riskFromSnapshot scores the daemon's own snapshot shape", () => {
    const r = riskFromSnapshot(makeSnapshot("1.20"));
    expect(r.grade).toMatch(/elevated|high/);
    expect(r.factors.collateralVolatility.detail).toContain("WETH");
  });

  it("riskFromAccountData scores exactly what WF-3 returns to a paying caller", () => {
    // The live mainnet read from the hero-tx confirm node.
    const r = riskFromAccountData({
      healthFactorWad: 1_600_155_043_325_427_393n,
      totalCollateralBase8: 4_500_010_000n,
      totalDebtBase8: 2_337_000_000n,
      availableBorrowsBase8: 1_263_000_000n,
      collateralSymbol: "WETH",
    });
    expect(r.factors.healthFactor.value).toBeCloseTo(39.98, 1);
    expect(r.flags.velocityUnknown).toBe(true); // single read has no time series
    expect(r.score).toBeGreaterThan(0);
  });

  it("riskFromAccountData collapses the no-debt sentinel like the sensor does", () => {
    const r = riskFromAccountData({
      healthFactorWad: MAX_UINT256,
      totalCollateralBase8: 0n,
      totalDebtBase8: 0n,
      availableBorrowsBase8: 0n,
    });
    expect(r.score).toBe(0);
    expect(r.flags.noPosition).toBe(true);
  });

  it("riskFromAccountData without a symbol assumes the cautious unknown class", () => {
    const r = riskFromAccountData({
      healthFactorWad: 1_400_000_000_000_000_000n,
      totalCollateralBase8: 4_500_000_000n,
      totalDebtBase8: 2_668_000_000n,
      availableBorrowsBase8: 932_000_000n,
    });
    expect(r.factors.collateralVolatility.value).toBe(60);
  });
});

describe("risk: properties (fast-check)", () => {
  const finiteInputArb = fc.record({
    hf: fc.double({ min: 0.01, max: 100, noNaN: true, noDefaultInfinity: true }),
    hasDebt: fc.constant(true),
    totalCollateralUsd: fc.double({ min: 0.01, max: 1e9, noNaN: true, noDefaultInfinity: true }),
    totalDebtUsd: fc.double({ min: 0.01, max: 1e9, noNaN: true, noDefaultInfinity: true }),
    availableBorrowsUsd: fc.double({ min: 0, max: 1e9, noNaN: true, noDefaultInfinity: true }),
    hfVelocityPerMin: fc.option(
      fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
      { nil: null },
    ),
    collateralSymbol: fc.constantFrom("WETH" as const, "cbETH" as const, "UNKNOWN" as const),
  });

  it("score is always an integer in [0, 100] and grade always matches it", () => {
    fc.assert(
      fc.property(finiteInputArb, (i) => {
        const r = assessRisk(i);
        expect(Number.isInteger(r.score)).toBe(true);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(100);
        expect(r.grade).toBe(gradeFor(r.score));
      }),
      { numRuns: 300 },
    );
  });

  it("raising HF (all else fixed) never raises the score", () => {
    fc.assert(
      fc.property(
        finiteInputArb,
        fc.double({ min: 0.01, max: 50, noNaN: true, noDefaultInfinity: true }),
        (i, bump) => {
          const lower = assessRisk(i);
          const higher = assessRisk({ ...i, hf: i.hf + bump });
          expect(higher.score).toBeLessThanOrEqual(lower.score);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a more negative velocity (all else fixed) never lowers the score", () => {
    fc.assert(
      fc.property(
        finiteInputArb,
        fc.double({ min: 0.0001, max: 1, noNaN: true, noDefaultInfinity: true }),
        (i, worse) => {
          const v = i.hfVelocityPerMin ?? 0;
          const base = assessRisk({ ...i, hfVelocityPerMin: v });
          const crashing = assessRisk({ ...i, hfVelocityPerMin: v - worse });
          expect(crashing.score).toBeGreaterThanOrEqual(base.score);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("total over the full wad domain via the account-data adapter (0 … maxUint256)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_UINT256 }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (hfWad, col, debt) => {
          const r = riskFromAccountData({
            healthFactorWad: hfWad,
            totalCollateralBase8: col,
            totalDebtBase8: debt,
            availableBorrowsBase8: 0n,
          });
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("no-debt inputs score 0 no matter what the other fields claim", () => {
    fc.assert(
      fc.property(finiteInputArb, (i) => {
        const r = assessRisk({ ...i, hasDebt: false, hf: Number.POSITIVE_INFINITY });
        expect(r.score).toBe(0);
        expect(r.grade).toBe("minimal");
      }),
      { numRuns: 200 },
    );
  });
});
