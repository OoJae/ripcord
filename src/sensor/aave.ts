/**
 * Sensor: Aave V3 position reads (viem, READ-ONLY — all writes go through KeeperHub).
 *
 * Decimal contract, verified against the Aave V3 deployments on Base:
 *  - healthFactor is a 1e18 wad; Aave returns type(uint256).max when there is no debt.
 *  - totalCollateralBase / totalDebtBase / availableBorrowsBase are in the market's
 *    base currency: USD with 8 decimals on these deployments.
 *  - currentLiquidationThreshold and ltv are basis points (1e4).
 *
 * The raw wad is preserved on the snapshot (`hfWad`) and is the ONLY thing the
 * policy compares — the float `hf` is for display/LLM/velocity, where a 1-wei
 * difference is invisible.
 */

import { createPublicClient, http } from "viem";
import type { AppConfig } from "../config.js";
import { TOKEN_DECIMALS } from "../config.js";
import type { Address, Sensor, Snapshot } from "../types.js";

/** Aave V3 IPool.getUserAccountData — 6 uint256 outputs, in this exact order. */
export const POOL_ACCOUNT_DATA_ABI = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

export const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type AccountDataTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

/** Minimal read seam so tests can inject a stub instead of a live viem client. */
export interface ReadContractClient {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Pure math (fixture-tested independently of I/O)

/** Above this, HF is "no meaningful debt" — covers Aave's type(uint256).max sentinel. */
const HF_INFINITY_WAD = 10n ** 24n;

/**
 * 1e18 wad → float, without ever flooring a huge sentinel through Number().
 * Divides by 1e12 first so the intermediate fits comfortably in a double: the
 * result keeps 6 decimal places exactly, which is far more precision than any
 * display or LLM consumer needs.
 */
export function wadToHf(wad: bigint): number {
  if (wad > HF_INFINITY_WAD) return Number.POSITIVE_INFINITY;
  return Number(wad / 10n ** 12n) / 1e6;
}

/**
 * Aave base currency (8-decimal USD on Base) → float dollars.
 * Exact for values below ~$90,000,000 (2^53 / 1e8), far above anything Ripcord touches.
 */
export function baseUnitsToUsd(x: bigint): number {
  return Number(x) / 1e8;
}

export interface ParsedAccountData {
  hfWad: bigint;
  hf: number;
  hasDebt: boolean;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  liquidationThresholdBps: number;
  ltvBps: number;
}

export function parseAccountData(raw: AccountDataTuple): ParsedAccountData {
  const [collateral, debt, available, liqThreshold, ltv, healthFactor] = raw;
  const hasDebt = debt > 0n;
  return {
    hfWad: healthFactor, // preserved exactly — the policy compares this, not the float
    hf: hasDebt ? wadToHf(healthFactor) : Number.POSITIVE_INFINITY,
    hasDebt,
    totalCollateralUsd: baseUnitsToUsd(collateral),
    totalDebtUsd: baseUnitsToUsd(debt),
    availableBorrowsUsd: baseUnitsToUsd(available),
    liquidationThresholdBps: Number(liqThreshold),
    ltvBps: Number(ltv),
  };
}

export interface HfSample {
  tMs: number;
  hf: number;
}

/**
 * Δ HF per minute across the sample window. Returns null until three samples
 * exist, and ignores non-finite samples (a position that had no debt) so an
 * Infinity never poisons the arithmetic.
 */
export function computeVelocity(samples: ReadonlyArray<HfSample>): number | null {
  if (samples.length < 3) return null;
  const finite = samples.filter((s) => Number.isFinite(s.hf));
  if (finite.length < 3) return null;
  const first = finite[0];
  const last = finite[finite.length - 1];
  if (first === undefined || last === undefined) return null;
  const minutes = (last.tMs - first.tMs) / 60_000;
  if (minutes <= 0) return null;
  return (last.hf - first.hf) / minutes;
}

/** Fixed-size ring buffer of the most recent HF samples (in-memory; not persisted). */
export class SampleWindow {
  private readonly buf: HfSample[] = [];

  constructor(private readonly size = 3) {}

  push(sample: HfSample): void {
    this.buf.push(sample);
    while (this.buf.length > this.size) this.buf.shift();
  }

  get samples(): ReadonlyArray<HfSample> {
    return this.buf;
  }
}

// ---------------------------------------------------------------------------
// Live sensor

/**
 * Reads the monitored position from Aave V3 plus the wallet's USDC/WETH balances.
 * Deliberately thin: no retries here — the daemon owns retry/backoff so a
 * transient RPC blip is one place to reason about.
 */
export function createAaveSensor(cfg: AppConfig, injected?: ReadContractClient): Sensor {
  const monitored = cfg.monitoredAddress;
  if (!monitored) {
    throw new Error("createAaveSensor: MONITORED_ADDRESS is required for live chain reads");
  }
  const client: ReadContractClient =
    injected ??
    (createPublicClient({ transport: http(cfg.rpcUrl) }) as unknown as ReadContractClient);

  return {
    async read(): Promise<Snapshot> {
      const [accountRaw, usdcRaw, wethRaw] = await Promise.all([
        client.readContract({
          address: cfg.addressBook.aavePool.address,
          abi: POOL_ACCOUNT_DATA_ABI,
          functionName: "getUserAccountData",
          args: [monitored],
        }) as Promise<AccountDataTuple>,
        client.readContract({
          address: cfg.addressBook.usdc.address,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [monitored],
        }) as Promise<bigint>,
        client.readContract({
          address: cfg.addressBook.weth.address,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [monitored],
        }) as Promise<bigint>,
      ]);

      const parsed = parseAccountData(accountRaw);
      return {
        timestampMs: Date.now(),
        chain: cfg.chain,
        address: monitored,
        ...parsed,
        balances: {
          usdcRaw,
          usdcUsd: Number(usdcRaw) / 10 ** TOKEN_DECIMALS.USDC, // USDC ≈ $1
          wethRaw,
          wethEth: Number(wethRaw) / 10 ** TOKEN_DECIMALS.WETH,
        },
        hfVelocityPerMin: null, // the daemon fills this from its SampleWindow
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock sensor (zero-secret demo)

export interface MockSensor extends Sensor {
  /** Simulate a landed defense: debt drops, HF visibly recovers, then drifts down again. */
  applyDefense(amountUsd: number): void;
}

const MOCK_COLLATERAL_BASE = 3_000_000_000n; // $30.00
const MOCK_LT_BPS = 8000n; // 80%
const MOCK_DEBT_START = 1_318_681_318n; // $13.19 → HF ≈ 1.82
const MOCK_DEBT_STEP = 110_000_000n; // +$1.10 of debt per read
const MOCK_DEBT_FLOOR = 200_000_000n; // $2.00 — keeps HF finite after big defenses

/**
 * Scripted position for the zero-secret demo. HF is *computed* from a synthetic
 * position each read (never hard-coded), so applyDefense() produces a real,
 * arithmetically consistent recovery: default descent runs
 * 1.82 → 1.68 → 1.56 → 1.46 → 1.37 → 1.28 → 1.21 → … until a defense lands.
 */
export function createMockSensor(scenario?: string[]): MockSensor {
  let debtBase = MOCK_DEBT_START;
  const scripted = [...(scenario ?? [])];

  const effectiveCollateral = (MOCK_COLLATERAL_BASE * MOCK_LT_BPS) / 10_000n;

  return {
    async read(): Promise<Snapshot> {
      let hfWad: bigint;
      let debtForSnapshot = debtBase;

      const next = scripted.shift();
      if (next !== undefined) {
        // Explicit scenario: derive the debt that would produce this HF so the
        // position stays internally consistent for applyDefense().
        const [whole = "0", frac = ""] = next.split(".");
        const hfWadTarget = BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
        debtForSnapshot = hfWadTarget === 0n ? debtBase : (effectiveCollateral * 10n ** 18n) / hfWadTarget;
        debtBase = debtForSnapshot;
        hfWad = hfWadTarget;
      } else {
        hfWad = (effectiveCollateral * 10n ** 18n) / debtBase;
        debtBase += MOCK_DEBT_STEP; // the position keeps deteriorating
      }

      const parsed = parseAccountData([
        MOCK_COLLATERAL_BASE,
        debtForSnapshot,
        0n,
        MOCK_LT_BPS,
        7500n,
        hfWad,
      ]);

      return {
        timestampMs: Date.now(),
        chain: "base-sepolia",
        address: "0x000000000000000000000000000000000000dEaD",
        ...parsed,
        balances: {
          usdcRaw: 25_000_000n,
          usdcUsd: 25,
          wethRaw: 10_000_000_000_000_000n,
          wethEth: 0.01,
        },
        hfVelocityPerMin: null,
      };
    },

    applyDefense(amountUsd: number): void {
      const repaid = BigInt(Math.round(amountUsd * 1e8));
      debtBase = debtBase > repaid + MOCK_DEBT_FLOOR ? debtBase - repaid : MOCK_DEBT_FLOOR;
    },
  };
}
