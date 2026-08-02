/**
 * The funding ladder — where a defense's money comes from.
 *
 * This is Ripcord's biggest competitive gap, stated honestly in code rather
 * than hidden. Every incumbent funds the defense from the POSITION:
 *   • DeFi Saver — "No funds are required in your wallet": flash-loan the
 *     collateral, swap, repay, withdraw to settle, all atomic.
 *   • Instadapp  — "uses any available collateral in the position".
 *   • Summer.fi  — flash loan the debt asset, repay, sell freed collateral.
 * Ripcord funds from idle wallet USDC, which is self-defeating: anyone holding
 * idle stables would have supplied or repaid them already, so the users who
 * most need protection are exactly the ones who cannot use it.
 *
 * Why the flash loan is architecturally necessary (worth internalising before
 * anyone tries the "simpler" version): the naive order — withdraw collateral,
 * swap, repay — LOWERS the health factor first. At the panic band that
 * intermediate dip is where the position gets liquidated out from under you, or
 * Aave's own HF check simply reverts the withdrawal. The flash loan inverts the
 * order (repay first, settle second) so HF never dips, and makes it atomic.
 *
 * This module ranks the rungs and reports capacity. Only WALLET_USDC is wired
 * to an executor today; the rest are declared so the daemon can tell the
 * operator the truth about what it could and could not do, and so the roadmap
 * lives next to the code it describes rather than in a slide.
 */

import type { Snapshot } from "../types.js";

export type FundingSourceId =
  /** Idle USDC in the wallet → Pool.repay. Wired. */
  | "wallet-usdc"
  /** Supplied USDC (aUSDC) → Pool.repayWithATokens. No allowance, no swap, no
   *  flash loan, no price feed — the cheapest defense that exists when the user
   *  supplies the same asset they borrow. Sensed; execution not yet wired. */
  | "atoken-usdc"
  /** Collateral → ParaSwapRepayAdapter (flash loan → repay → pull collateral →
   *  swap → settle). Full parity with the incumbents. Not implemented. */
  | "collateral-swap";

export interface FundingRung {
  id: FundingSourceId;
  /** USD this rung could contribute to a defense right now. */
  capacityUsd: number;
  /** False when Ripcord can see the money but cannot yet spend it. */
  executable: boolean;
  detail: string;
}

export interface FundingAssessment {
  rungs: FundingRung[];
  /** Capacity Ripcord can actually use today. */
  executableUsd: number;
  /** Capacity that exists but needs an unbuilt execution path. */
  potentialUsd: number;
}

/**
 * Rank funding sources for the current snapshot, cheapest/safest first.
 * Pure: no I/O, no config beyond the snapshot.
 */
export function assessFunding(snapshot: Snapshot): FundingAssessment {
  const aUsdc = Math.max(0, snapshot.balances.aUsdcUsd);
  const wallet = Math.max(0, snapshot.balances.usdcUsd);
  // Collateral is priced by the Aave oracle in the position aggregate; only the
  // portion above the liquidation threshold is realistically extractable, and
  // extracting it needs the flash-loan path. Reported, never counted as usable.
  const effectiveCollateral =
    snapshot.totalCollateralUsd * (snapshot.liquidationThresholdBps / 1e4);
  const headroomUsd = Math.max(0, effectiveCollateral - snapshot.totalDebtUsd);

  const rungs: FundingRung[] = [
    {
      id: "atoken-usdc",
      capacityUsd: aUsdc,
      executable: false,
      detail:
        aUsdc > 0
          ? `$${aUsdc.toFixed(2)} of supplied USDC could repay debt directly via repayWithATokens (no allowance, no swap) — execution path not yet wired`
          : "no supplied USDC (aUSDC) to repay with",
    },
    {
      id: "wallet-usdc",
      capacityUsd: wallet,
      executable: true,
      detail: `$${wallet.toFixed(2)} idle USDC in the wallet — the only wired funding source`,
    },
    {
      id: "collateral-swap",
      capacityUsd: headroomUsd,
      executable: false,
      detail:
        `$${headroomUsd.toFixed(2)} of collateral headroom could fund a defense via a ` +
        "flash-loan repay (ParaSwapRepayAdapter) — not implemented; this is the gap every incumbent closes",
    },
  ];

  return {
    rungs,
    executableUsd: rungs.filter((r) => r.executable).reduce((a, r) => a + r.capacityUsd, 0),
    potentialUsd: rungs.filter((r) => !r.executable).reduce((a, r) => a + r.capacityUsd, 0),
  };
}
