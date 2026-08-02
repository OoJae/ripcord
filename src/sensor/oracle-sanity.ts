/**
 * Oracle-sanity gate — the agent-native defense no deterministic trigger has.
 *
 * The 2026 headline liquidations (Moonwell's $1.12 cbETH print, Aave's $27M
 * CAPO glitch) were single-block oracle mispricings. No poller outraces the
 * block — but nothing forces Ripcord to ACT on an absurd price either. Before
 * any defense, we compare the Aave oracle's collateral price against an
 * independent Chainlink ETH/USD reference. A ratio outside the collateral's
 * configured band means one of the two oracles is lying; acting on corrupted
 * data is strictly worse than waiting, so the Guard blocks and the operator is
 * alerted loudly.
 *
 * Failure posture (deliberate, pinned by tests):
 *  - DIVERGENT   → block the defense (Guard violation). A defense sized from a
 *    corrupted price can itself be the disaster.
 *  - UNAVAILABLE → proceed with a warning. The reference feed's availability
 *    must never brick the actual rescue; the Aave oracle is still the
 *    protocol's own settlement truth.
 *
 * READ-ONLY (invariant 1): viem reads, resolved via the allowlisted Pool.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { type AppConfig, scrubRpcUrl } from "../config.js";
import type { OracleSanityResult } from "../types.js";

const POOL_PROVIDER_ABI = [
  {
    type: "function",
    name: "ADDRESSES_PROVIDER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const PROVIDER_ABI = [
  {
    type: "function",
    name: "getPriceOracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AAVE_ORACLE_ABI = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const CHAINLINK_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** Reference answers older than this are treated as unavailable, not as truth. */
export const REFERENCE_MAX_STALENESS_MS = 3_600_000; // 1h — Chainlink ETH/USD heartbeat is minutes

/**
 * Pure verdict from the two prices. Exported for exhaustive unit testing.
 */
export function evaluateOracleSanity(args: {
  aaveCollateralUsd: number;
  referenceEthUsd: number;
  referenceUpdatedAtMs: number;
  nowMs: number;
  refRatioMin: number;
  refRatioMax: number;
}): OracleSanityResult {
  const { aaveCollateralUsd, referenceEthUsd, referenceUpdatedAtMs, nowMs } = args;

  if (
    !Number.isFinite(referenceEthUsd) ||
    referenceEthUsd <= 0 ||
    nowMs - referenceUpdatedAtMs > REFERENCE_MAX_STALENESS_MS
  ) {
    return {
      status: "unavailable",
      detail: `reference feed unusable (price ${referenceEthUsd}, age ${Math.round((nowMs - referenceUpdatedAtMs) / 1000)}s) — proceeding on the Aave oracle alone`,
    };
  }
  if (!Number.isFinite(aaveCollateralUsd) || aaveCollateralUsd <= 0) {
    // The Aave oracle returning garbage IS the anomaly.
    return {
      status: "divergent",
      aaveCollateralUsd,
      referenceEthUsd,
      ratio: 0,
      detail: `Aave oracle returned a non-positive collateral price (${aaveCollateralUsd})`,
    };
  }

  const ratio = aaveCollateralUsd / referenceEthUsd;
  if (ratio < args.refRatioMin || ratio > args.refRatioMax) {
    return {
      status: "divergent",
      aaveCollateralUsd,
      referenceEthUsd,
      ratio,
      detail:
        `ORACLE ANOMALY: Aave prices collateral at $${aaveCollateralUsd.toFixed(2)} vs ` +
        `Chainlink ETH $${referenceEthUsd.toFixed(2)} — ratio ${ratio.toFixed(4)} outside ` +
        `[${args.refRatioMin}, ${args.refRatioMax}]. Refusing to act on corrupted pricing.`,
    };
  }
  return {
    status: "ok",
    aaveCollateralUsd,
    referenceEthUsd,
    ratio,
    detail: `Aave $${aaveCollateralUsd.toFixed(2)} / Chainlink ETH $${referenceEthUsd.toFixed(2)} — ratio ${ratio.toFixed(4)} within [${args.refRatioMin}, ${args.refRatioMax}]`,
  };
}

export interface OracleSanityChecker {
  check(): Promise<OracleSanityResult>;
}

/**
 * Live checker. The Aave price oracle is resolved THROUGH the allowlisted Pool
 * (Pool → ADDRESSES_PROVIDER → getPriceOracle) rather than hardcoded, so the
 * only trusted inputs remain the allowlist entries. Any read failure degrades
 * to "unavailable" — never to a false "ok" and never to a crash.
 */
export function createOracleSanityChecker(
  cfg: AppConfig,
  client?: PublicClient,
  clock: () => number = () => Date.now(),
): OracleSanityChecker {
  const c = client ?? createPublicClient({ transport: http(cfg.rpcUrl) });
  const book = cfg.addressBook;

  return {
    async check(): Promise<OracleSanityResult> {
      try {
        const provider = await c.readContract({
          address: book.aavePool.address,
          abi: POOL_PROVIDER_ABI,
          functionName: "ADDRESSES_PROVIDER",
        });
        const oracle = await c.readContract({
          address: provider,
          abi: PROVIDER_ABI,
          functionName: "getPriceOracle",
        });
        const [aaveRaw, round] = await Promise.all([
          c.readContract({
            address: oracle,
            abi: AAVE_ORACLE_ABI,
            functionName: "getAssetPrice",
            args: [book.collateral.address],
          }),
          c.readContract({
            address: book.chainlinkEthUsd.address,
            abi: CHAINLINK_ABI,
            functionName: "latestRoundData",
          }),
        ]);
        return evaluateOracleSanity({
          aaveCollateralUsd: Number(aaveRaw) / 1e8,
          referenceEthUsd: Number(round[1]) / 1e8,
          referenceUpdatedAtMs: Number(round[3]) * 1000,
          nowMs: clock(),
          refRatioMin: book.collateral.refRatioMin,
          refRatioMax: book.collateral.refRatioMax,
        });
      } catch (err) {
        return {
          status: "unavailable",
          // Scrub BEFORE slicing: viem puts the full RPC URL (which routinely
          // embeds a provider API key) at ~char 57 of its error, and this
          // string reaches logs, SQLite and the Critic prompt. Truncating
          // first would leave a half-URL the scrubber no longer matches.
          detail: `oracle sanity reads failed (${scrubRpcUrl(String(err), cfg.rpcUrl).slice(0, 120)}) — proceeding on the Aave oracle alone`,
        };
      }
    },
  };
}
