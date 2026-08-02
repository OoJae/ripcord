/**
 * Shared test doubles. No network, no timers, no real secrets — ever.
 */

import { type AppConfig, loadConfig } from "../../src/config.js";
import type { Address, Band, Chain, Clock, LlmClient, Snapshot } from "../../src/types.js";
import { wadOf } from "../fixtures/aave.js";

/** Queue-scripted LLM double; records every call for prompt assertions. */
export class FakeLlmClient implements LlmClient {
  readonly calls: Array<{ system: string; user: string; maxTokens?: number }> = [];
  private readonly queue: string[];

  constructor(responses: string[]) {
    this.queue = [...responses];
  }

  async complete(req: { system: string; user: string; maxTokens?: number }): Promise<string> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("FakeLlmClient: response queue exhausted");
    }
    return next;
  }
}

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function fixedClock(startMs = 1_753_920_000_000): TestClock {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

/**
 * Build an AppConfig from a synthetic env (never process.env → never real secrets),
 * then apply shallow overrides.
 */
export function makeTestConfig(
  env: Record<string, string> = {},
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const cfg = loadConfig({ CHAIN: "base-sepolia", ...env });
  return { ...cfg, ...overrides };
}

export const TEST_ADDRESS: Address = "0x1111111111111111111111111111111111111111";

/** A plausible snapshot at a given HF (decimal string), defaulting to the act band. */
export function makeSnapshot(
  hfDecimal = "1.20",
  partial: Partial<Snapshot> = {},
  chain: Chain = "base-sepolia",
): Snapshot {
  const hfWad = wadOf(hfDecimal);
  return {
    timestampMs: 1_753_920_000_000,
    chain,
    address: TEST_ADDRESS,
    hfWad,
    hf: Number(hfWad / 10n ** 12n) / 1e6,
    hasDebt: true,
    totalCollateralUsd: 30,
    totalDebtUsd: 20,
    availableBorrowsUsd: 2.5,
    liquidationThresholdBps: 8000,
    ltvBps: 7500,
    balances: {
      usdcRaw: 25_000_000n, // 25 USDC
      usdcUsd: 25,
      collateralRaw: 10_000_000_000_000_000n, // 0.01 collateral token
      collateralAmount: 0.01,
      collateralSymbol: "WETH",
      aUsdcRaw: 0n,
      aUsdcUsd: 0,
    },
    hfVelocityPerMin: null,
    ...partial,
  };
}

export function bandOf(hf: string): Band {
  const wad = wadOf(hf);
  if (wad > wadOf("1.50")) return "healthy";
  if (wad > wadOf("1.25")) return "warn";
  if (wad >= wadOf("1.10")) return "act";
  return "panic";
}
