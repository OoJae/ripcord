/**
 * Deterministic liquidation-risk engine (build guide §8.1).
 *
 * This is the reference implementation of the score behind the marketplace
 * listing WF-3 `ripcord-risk-score`: the workflow returns the raw on-chain
 * figures (so callers can verify everything themselves), and this pure function
 * turns those figures into a 0–100 score. Same philosophy as the rest of
 * Ripcord — deterministic code computes; nothing here consults a model.
 *
 * ADVISORY, NOT SAFETY-CRITICAL. The defense pipeline's band classification
 * uses bigint wad comparisons (src/policy/thresholds.ts) because a 1-wei
 * difference there changes whether money moves. A risk *score* is a smooth
 * summary for humans and agents, so float arithmetic on the display HF is
 * appropriate — banding decisions must never be derived from it.
 */

import type { CollateralSymbol, Snapshot } from "../types.js";

/** The subset of a position the engine needs; adapters below construct it. */
export interface RiskInput {
  /** Display health factor; Infinity when there is no debt. */
  hf: number;
  hasDebt: boolean;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  /** HF drift per minute; null while the sample window is warming up. */
  hfVelocityPerMin: number | null;
  collateralSymbol: CollateralSymbol | "UNKNOWN";
}

export type RiskGrade = "minimal" | "low" | "elevated" | "high" | "critical";

export interface RiskFactor {
  /** 0 (no risk contribution) … 100 (maximal). */
  value: number;
  /** Contribution weight; all weights sum to 1. */
  weight: number;
  detail: string;
}

export interface RiskReport {
  /** 0 (no position / fully safe) … 100 (liquidation imminent). */
  score: number;
  grade: RiskGrade;
  factors: {
    healthFactor: RiskFactor;
    bufferToLiquidation: RiskFactor;
    hfVelocity: RiskFactor;
    collateralVolatility: RiskFactor;
    debtConcentration: RiskFactor;
  };
  flags: {
    /** No debt at all — nothing can be liquidated. */
    noDebt: boolean;
    /** No collateral AND no debt — the address has no Aave position. */
    noPosition: boolean;
    /** Velocity window not yet warmed up; the velocity factor is neutral. */
    velocityUnknown: boolean;
  };
}

// Weights sum to 1. Ordering mirrors the build guide's factor list.
export const RISK_WEIGHTS = {
  healthFactor: 0.45,
  bufferToLiquidation: 0.2,
  hfVelocity: 0.15,
  collateralVolatility: 0.1,
  debtConcentration: 0.1,
} as const;

/**
 * Volatility class of the collateral backing the position. Stablecoin
 * collateral would be 0; ETH-correlated assets sit mid-scale (drawdowns are
 * routine but not exotic); cbETH carries a small staking-derivative premium
 * (depeg + validator risk on top of ETH beta). Unknown assets are assumed
 * worse than anything we recognize — fail toward caution.
 */
export const VOLATILITY_CLASS: Record<string, number> = {
  WETH: 50,
  cbETH: 55,
};
const VOLATILITY_UNKNOWN = 60;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 100 at HF ≤ 1.0 (liquidatable), 0 at HF ≥ 2.0, linear between. */
export function healthFactorRisk(hf: number): number {
  if (!Number.isFinite(hf)) return 0; // no debt → nothing at risk
  return clamp(((2.0 - hf) / 1.0) * 100, 0, 100);
}

/**
 * How far collateral value can fall before liquidation: drop = 1 − 1/HF.
 * (HF scales linearly with collateral value at fixed debt and LT.)
 * 0% tolerance → 100 risk; ≥50% tolerance → 0.
 */
export function bufferRisk(hf: number): number {
  if (!Number.isFinite(hf)) return 0;
  if (hf <= 1) return 100;
  const dropTolerance = 1 - 1 / hf;
  return clamp(((0.5 - dropTolerance) / 0.5) * 100, 0, 100);
}

/**
 * Negative HF drift is risk; positive or flat drift contributes nothing
 * (recovery speed is not a hazard). −0.01 HF/min (≈ −0.6/hour) saturates the
 * factor: at that pace a warn-band position reaches liquidation within hours.
 */
export function velocityRisk(hfVelocityPerMin: number | null): number {
  if (hfVelocityPerMin === null || !Number.isFinite(hfVelocityPerMin)) return 0;
  if (hfVelocityPerMin >= 0) return 0;
  return clamp((-hfVelocityPerMin / 0.01) * 100, 0, 100);
}

export function volatilityRisk(symbol: string): number {
  return VOLATILITY_CLASS[symbol] ?? VOLATILITY_UNKNOWN;
}

/**
 * Borrowing-capacity utilization: debt / (debt + headroom). A maxed-out
 * position (no remaining borrow headroom) has no slack anywhere; a barely
 * drawn one can absorb shocks by construction.
 */
export function concentrationRisk(totalDebtUsd: number, availableBorrowsUsd: number): number {
  const debt = Math.max(0, totalDebtUsd);
  const headroom = Math.max(0, availableBorrowsUsd);
  if (debt <= 0) return 0;
  const denominator = debt + headroom;
  if (denominator <= 0) return 0;
  return clamp((debt / denominator) * 100, 0, 100);
}

export function gradeFor(score: number): RiskGrade {
  if (score < 20) return "minimal";
  if (score < 40) return "low";
  if (score < 60) return "elevated";
  if (score < 80) return "high";
  return "critical";
}

export function assessRisk(input: RiskInput): RiskReport {
  const noDebt = !input.hasDebt || !Number.isFinite(input.hf) || input.totalDebtUsd <= 0;
  const noPosition = noDebt && input.totalCollateralUsd <= 0;
  const velocityUnknown = input.hfVelocityPerMin === null;

  const factor = (value: number, weight: number, detail: string): RiskFactor => ({
    // Round for presentation stability; the weighted sum uses the raw value.
    value: Math.round(value * 100) / 100,
    weight,
    detail,
  });

  if (noDebt) {
    // Nothing can be liquidated. Volatility is reported as informational zero:
    // a score must never suggest risk where liquidation is impossible.
    const zero = "no debt — liquidation is impossible";
    return {
      score: 0,
      grade: "minimal",
      factors: {
        healthFactor: factor(0, RISK_WEIGHTS.healthFactor, zero),
        bufferToLiquidation: factor(0, RISK_WEIGHTS.bufferToLiquidation, zero),
        hfVelocity: factor(0, RISK_WEIGHTS.hfVelocity, zero),
        collateralVolatility: factor(0, RISK_WEIGHTS.collateralVolatility, zero),
        debtConcentration: factor(0, RISK_WEIGHTS.debtConcentration, zero),
      },
      flags: { noDebt: true, noPosition, velocityUnknown },
    };
  }

  const hfR = healthFactorRisk(input.hf);
  const bufR = bufferRisk(input.hf);
  const velR = velocityRisk(input.hfVelocityPerMin);
  const volR = volatilityRisk(input.collateralSymbol);
  const conR = concentrationRisk(input.totalDebtUsd, input.availableBorrowsUsd);

  const raw =
    hfR * RISK_WEIGHTS.healthFactor +
    bufR * RISK_WEIGHTS.bufferToLiquidation +
    velR * RISK_WEIGHTS.hfVelocity +
    volR * RISK_WEIGHTS.collateralVolatility +
    conR * RISK_WEIGHTS.debtConcentration;
  const score = Math.round(clamp(raw, 0, 100));

  const dropPct = Number.isFinite(input.hf) && input.hf > 1 ? (1 - 1 / input.hf) * 100 : 0;

  return {
    score,
    grade: gradeFor(score),
    factors: {
      healthFactor: factor(
        hfR,
        RISK_WEIGHTS.healthFactor,
        `HF ${input.hf.toFixed(4)} (100 risk at ≤1.0, 0 at ≥2.0)`,
      ),
      bufferToLiquidation: factor(
        bufR,
        RISK_WEIGHTS.bufferToLiquidation,
        `collateral can drop ${dropPct.toFixed(1)}% before liquidation`,
      ),
      hfVelocity: factor(
        velR,
        RISK_WEIGHTS.hfVelocity,
        velocityUnknown
          ? "velocity unknown (window warming up) — neutral"
          : `HF drift ${input.hfVelocityPerMin?.toFixed(4)}/min (−0.01/min saturates)`,
      ),
      collateralVolatility: factor(
        volR,
        RISK_WEIGHTS.collateralVolatility,
        `collateral class ${input.collateralSymbol}`,
      ),
      debtConcentration: factor(
        conR,
        RISK_WEIGHTS.debtConcentration,
        `borrowing capacity ${conR.toFixed(1)}% utilized`,
      ),
    },
    flags: { noDebt: false, noPosition: false, velocityUnknown },
  };
}

/** Score straight from a daemon Snapshot. */
export function riskFromSnapshot(s: Snapshot): RiskReport {
  return assessRisk({
    hf: s.hf,
    hasDebt: s.hasDebt,
    totalCollateralUsd: s.totalCollateralUsd,
    totalDebtUsd: s.totalDebtUsd,
    availableBorrowsUsd: s.availableBorrowsUsd,
    hfVelocityPerMin: s.hfVelocityPerMin,
    collateralSymbol: s.balances.collateralSymbol,
  });
}

/**
 * Score from the raw getUserAccountData figures — exactly what WF-3
 * `ripcord-risk-score` returns to a paying caller (wad HF, 8-decimal base-USD
 * amounts), so a response body can be fed straight into the engine.
 * Velocity is a time-series property a single read cannot provide → null.
 */
export function riskFromAccountData(raw: {
  healthFactorWad: bigint;
  totalCollateralBase8: bigint;
  totalDebtBase8: bigint;
  availableBorrowsBase8: bigint;
  collateralSymbol?: string;
}): RiskReport {
  // Same collapse rule as the sensor: absurdly large wads are the no-debt
  // sentinel; convert via 1e6 precision to avoid Number overflow on real wads.
  const hf =
    raw.healthFactorWad > 10n ** 24n
      ? Number.POSITIVE_INFINITY
      : Number(raw.healthFactorWad / 10n ** 12n) / 1e6;
  return assessRisk({
    hf,
    hasDebt: raw.totalDebtBase8 > 0n,
    totalCollateralUsd: Number(raw.totalCollateralBase8) / 1e8,
    totalDebtUsd: Number(raw.totalDebtBase8) / 1e8,
    availableBorrowsUsd: Number(raw.availableBorrowsBase8) / 1e8,
    hfVelocityPerMin: null,
    collateralSymbol: (raw.collateralSymbol as CollateralSymbol) ?? "UNKNOWN",
  });
}
