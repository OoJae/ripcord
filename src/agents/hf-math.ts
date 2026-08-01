/**
 * Post-defense health-factor arithmetic, shared by the heuristic Planner and
 * the heuristic Critic.
 *
 * Sharing the *formula* does not weaken Critic independence: the Critic
 * recomputes the outcome from the raw snapshot rather than trusting the
 * Planner's claimed `expectedHfAfter`, which is exactly the check that catches
 * a Planner that miscalculated or lied.
 */

import type { PlannerProposal, Snapshot } from "../types.js";

/** Health factor after repaying `amountUsd` of debt. Infinity once debt is cleared. */
export function hfAfterRepay(snapshot: Snapshot, amountUsd: number): number {
  const effectiveCollateral =
    snapshot.totalCollateralUsd * (snapshot.liquidationThresholdBps / 1e4);
  const remainingDebt = snapshot.totalDebtUsd - amountUsd;
  if (remainingDebt <= 0) return Number.POSITIVE_INFINITY;
  return effectiveCollateral / remainingDebt;
}

/** Health factor after supplying `amountUsd` more collateral. */
export function hfAfterSupply(snapshot: Snapshot, amountUsd: number): number {
  if (snapshot.totalDebtUsd <= 0) return Number.POSITIVE_INFINITY;
  const effectiveCollateral =
    (snapshot.totalCollateralUsd + amountUsd) * (snapshot.liquidationThresholdBps / 1e4);
  return effectiveCollateral / snapshot.totalDebtUsd;
}

export function hfAfter(snapshot: Snapshot, proposal: PlannerProposal): number {
  if (proposal.action === "repay") return hfAfterRepay(snapshot, proposal.amountUsd);
  if (proposal.action === "supplyCollateral") return hfAfterSupply(snapshot, proposal.amountUsd);
  return snapshot.hf;
}

/**
 * Smallest repayment that reaches `targetHf`; 0 when the position already
 * clears it. Rounded UP to whole cents.
 *
 * The rounding direction is load-bearing, not cosmetic. This number is quoted to
 * the Planner as a VERIFIED FIGURE and then rendered with toFixed(2); an exact
 * value like $4.2295 becomes $4.23 in the prompt but $4.2295 in the comparison,
 * and rounding to *nearest* can just as easily produce $4.22 — which lands at
 * HF 1.5999 and is correctly refused by the Critic for missing the 1.60 target.
 * A live run on 2026-08-01 hit exactly that and no defense could ever execute.
 *
 * Ceiling to the cent is the safe direction and is provably sufficient: with
 * E = effective collateral, D = debt, T = target, the exact requirement is
 * r ≥ D − E/T, so any r above it gives E/(D−r) ≥ T. Over-repaying by at most
 * one cent costs nothing and guarantees the target is cleared.
 */
export function repayNeededForTarget(snapshot: Snapshot, targetHf: number): number {
  const effectiveCollateral =
    snapshot.totalCollateralUsd * (snapshot.liquidationThresholdBps / 1e4);
  const needed = snapshot.totalDebtUsd - effectiveCollateral / targetHf;
  if (!(needed > 0)) return 0;
  // The 1e-9 nudge absorbs binary-float representation error. Without it a value
  // already sitting on a whole cent ceils to the NEXT one, because e.g.
  // 4.23 * 100 === 423.00000000000006. The nudge is ~11 orders of magnitude
  // smaller than a cent, so it can never eat into the safety margin above.
  return Math.ceil(needed * 100 - 1e-9) / 100;
}
