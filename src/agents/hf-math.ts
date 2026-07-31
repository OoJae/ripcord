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
  const effectiveCollateral = snapshot.totalCollateralUsd * (snapshot.liquidationThresholdBps / 1e4);
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

/** Smallest repayment that reaches `targetHf`; 0 when the position already clears it. */
export function repayNeededForTarget(snapshot: Snapshot, targetHf: number): number {
  const effectiveCollateral = snapshot.totalCollateralUsd * (snapshot.liquidationThresholdBps / 1e4);
  const needed = snapshot.totalDebtUsd - effectiveCollateral / targetHf;
  return needed > 0 ? needed : 0;
}
