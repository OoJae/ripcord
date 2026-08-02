/**
 * Oracle-sanity gate: the deterministic half.
 *
 * The 2026 headline liquidations (Moonwell's $1.12 cbETH print, Aave's CAPO
 * glitch) were single-block oracle mispricings. This gate cannot out-race a
 * block — its job is to refuse to ACT on corrupted pricing. The failure
 * posture is asymmetric by design and pinned here:
 *   divergent   → block (a defense sized from a corrupted price is a hazard)
 *   unavailable → proceed with warning (the reference must never brick a rescue)
 */

import { describe, expect, it } from "vitest";
import {
  evaluateOracleSanity,
  REFERENCE_MAX_STALENESS_MS,
} from "../../src/sensor/oracle-sanity.js";

const NOW = 1_753_920_000_000;
const FRESH = NOW - 60_000;

const WETH_BAND = { refRatioMin: 0.95, refRatioMax: 1.05 };
const CBETH_BAND = { refRatioMin: 0.8, refRatioMax: 1.4 };

function evalWith(aave: number, ref: number, band = WETH_BAND, updatedAt = FRESH) {
  return evaluateOracleSanity({
    aaveCollateralUsd: aave,
    referenceEthUsd: ref,
    referenceUpdatedAtMs: updatedAt,
    nowMs: NOW,
    ...band,
  });
}

describe("oracle-sanity: verdicts", () => {
  it("agreement passes (live figures from 2026-08-02: Aave 1870.56 vs Chainlink 1874.63)", () => {
    const r = evalWith(1870.56, 1874.63);
    expect(r.status).toBe("ok");
    expect(r.ratio).toBeCloseTo(0.9978, 3);
  });

  it("REPLAYS MOONWELL: cbETH printed at $1.12 against ~$1.9k ETH → divergent", () => {
    // The Feb 2026 incident that liquidated 181 borrowers. Ratio ≈ 0.0006,
    // four orders of magnitude below even the wide cbETH floor.
    const r = evalWith(1.12, 1874.63, CBETH_BAND);
    expect(r.status).toBe("divergent");
    expect(r.detail).toMatch(/ORACLE ANOMALY/);
  });

  it("a legitimate cbETH staking premium is NOT an anomaly", () => {
    expect(evalWith(2043.0, 1874.63, CBETH_BAND).status).toBe("ok"); // ratio 1.09
  });

  it("WETH band edges are exact", () => {
    expect(evalWith(1874.63 * 0.95, 1874.63).status).toBe("ok"); // exactly min
    expect(evalWith(1874.63 * 0.9499, 1874.63).status).toBe("divergent");
    expect(evalWith(1874.63 * 1.05, 1874.63).status).toBe("ok"); // exactly max
    expect(evalWith(1874.63 * 1.0501, 1874.63).status).toBe("divergent");
  });

  it("an upward-lying Aave oracle is also caught (inflated collateral hides risk)", () => {
    const r = evalWith(5000, 1874.63);
    expect(r.status).toBe("divergent");
  });

  it("stale reference → unavailable, never a verdict from old data", () => {
    const stale = NOW - REFERENCE_MAX_STALENESS_MS - 1;
    const r = evalWith(1.12, 1874.63, CBETH_BAND, stale);
    expect(r.status).toBe("unavailable");
    expect(r.detail).toMatch(/proceeding on the Aave oracle alone/);
  });

  it("garbage reference (zero/NaN) → unavailable", () => {
    expect(evalWith(1870, 0).status).toBe("unavailable");
    expect(evalWith(1870, Number.NaN).status).toBe("unavailable");
  });

  it("a non-positive AAVE price is divergent, not unavailable — that IS the anomaly", () => {
    expect(evalWith(0, 1874.63).status).toBe("divergent");
    expect(evalWith(-5, 1874.63).status).toBe("divergent");
  });
});
