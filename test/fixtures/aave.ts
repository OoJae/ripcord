/**
 * Hand-computed Aave V3 getUserAccountData fixtures — the single source of truth
 * for sensor/policy/wiring tests. Raw tuple order (all uint256):
 * [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor]
 * Base amounts are 8-decimal USD; liquidationThreshold/ltv are bps; healthFactor is a 1e18 wad.
 * On-chain formula: HF = (totalCollateralBase * LT / 10000) * 1e18 / totalDebtBase
 */

export const WAD = 10n ** 18n;
export const MAX_UINT256 = 2n ** 256n - 1n;

export type AccountDataTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

/** Fixture A — healthy: $50 collateral / $20 debt, LT 80% → HF exactly 2.0 */
export const FIXTURE_A: AccountDataTuple = [
  5_000_000_000n, // $50.00
  2_000_000_000n, // $20.00
  1_500_000_000n, // $15.00 available borrows (illustrative)
  8000n, // LT 80%
  7500n, // LTV 75%
  2_000_000_000_000_000_000n, // 50 * 0.8 / 20 = 2.0
];

/** Fixture B — act band: $30 / $20, LT 80% → HF exactly 1.20 */
export const FIXTURE_B: AccountDataTuple = [
  3_000_000_000n,
  2_000_000_000n,
  250_000_000n,
  8000n,
  7500n,
  1_200_000_000_000_000_000n, // 30 * 0.8 / 20 = 1.2
];

/** Fixture C — no debt: Aave returns type(uint256).max as the health factor */
export const FIXTURE_C: AccountDataTuple = [
  5_000_000_000n,
  0n,
  3_750_000_000n,
  8000n,
  7500n,
  MAX_UINT256,
];

/** Fixture D — empty account */
export const FIXTURE_D: AccountDataTuple = [0n, 0n, 0n, 0n, 0n, MAX_UINT256];

/**
 * Degenerate robustness variant: cannot occur on a live market but must not
 * crash the parser (zero collateral, debt present, HF zero).
 */
export const FIXTURE_DEGENERATE: AccountDataTuple = [0n, 2_000_000_000n, 0n, 0n, 0n, 0n];

// ---------------------------------------------------------------------------
// Band-edge wads (thresholds: warn 1.50 · act 1.25 · panic 1.10 · rearm 1.55)

export const WAD_1_50 = 1_500_000_000_000_000_000n;
export const WAD_1_25 = 1_250_000_000_000_000_000n;
export const WAD_1_10 = 1_100_000_000_000_000_000n;
export const WAD_1_55 = 1_550_000_000_000_000_000n;
export const WAD_1_60 = 1_600_000_000_000_000_000n;

export const ONE_WEI = 1n;

/** Convenience: build a wad from a decimal string like "1.47" (up to 18 dp). */
export function wadOf(decimal: string): bigint {
  const [whole = "0", frac = ""] = decimal.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole) * WAD + BigInt(fracPadded);
}

/** Build a snapshot-shaped account tuple with a specific HF wad (LT 80%, $20 debt). */
export function tupleWithHf(hfWad: bigint): AccountDataTuple {
  // collateral chosen so the tuple stays internally plausible; HF field is authoritative.
  return [3_000_000_000n, 2_000_000_000n, 0n, 8000n, 7500n, hfWad];
}
