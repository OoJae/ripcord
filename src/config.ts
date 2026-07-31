/**
 * Single source of truth: env parsing, thresholds, address-book allowlist, capabilities.
 *
 * SAFETY INVARIANTS ENFORCED HERE
 * - DRY_RUN / RIPCORD_ARM are strict enums: a typo fails loudly instead of arming.
 * - Addresses and selectors come ONLY from ADDRESS_BOOK below — never from LLM output.
 * - Refuses to start half-armed on mainnet (CHAIN=base + DRY_RUN=false requires RIPCORD_ARM=1).
 */

import { z } from "zod";
import type { AddressBook, Address, Chain, Thresholds, ThresholdsWad } from "./types.js";

// ---------------------------------------------------------------------------
// Constants (not env-driven in Session 1)

export const THRESHOLDS: Thresholds = {
  warn: 1.5,
  act: 1.25,
  panic: 1.1,
  targetHf: 1.6,
  rearm: 1.55,
  cooldownSec: 1800,
};

/** Precomputed wad encodings — policy band comparisons use these, never floats. */
export const THRESHOLDS_WAD: ThresholdsWad = {
  warn: 1_500_000_000_000_000_000n,
  act: 1_250_000_000_000_000_000n,
  panic: 1_100_000_000_000_000_000n,
  targetHf: 1_600_000_000_000_000_000n,
  rearm: 1_550_000_000_000_000_000n,
  cooldownSec: THRESHOLDS.cooldownSec,
};

/**
 * Planner/Critic model. Locked stack said claude-sonnet-4-6; user approved the
 * upgrade to the current Sonnet on 2026-07-31 (see FRICTION.md).
 */
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_POLL_SEC = 60;
export const MOCK_POLL_SEC = 5;
export const DEFAULT_DB_PATH = "data/ripcord.sqlite";
export const KEEPERHUB_API_BASE_URL = "https://app.keeperhub.com/api";

/** Public endpoints (rate-limited; fine for the hackathon, override via env for volume). */
export const DEFAULT_RPC_URLS: Record<Chain, string> = {
  base: "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
};

export const TOKEN_DECIMALS = { USDC: 6, WETH: 18 } as const;

/**
 * Allowlist — the ONLY legal source of contract addresses.
 * Verified 2026-07-30 against bgd-labs/aave-address-book (main) AND on-chain:
 * bytecode present + Pool.getReservesList() decoded via https://sepolia.base.org.
 * Note: Base mainnet native USDC (0x8335…) — NOT bridged USDbC (0xd9aA…).
 * Note: Base Sepolia USDC is the Aave market's faucet token (0xba50…), NOT Circle's 0x036C… .
 */
export const ADDRESS_BOOK: Record<Chain, AddressBook> = {
  base: {
    aavePool: {
      address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3Base.sol @ 2026-07-30",
    },
    usdc: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3Base.sol @ 2026-07-30 (native USDC, 6 dec)",
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3Base.sol @ 2026-07-30 (OP-stack predeploy)",
    },
  },
  "base-sepolia": {
    aavePool: {
      address: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3BaseSepolia.sol @ 2026-07-30 + on-chain bytecode",
    },
    usdc: {
      address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3BaseSepolia.sol @ 2026-07-30 (Aave test USDC)",
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3BaseSepolia.sol @ 2026-07-30 + getReservesList",
    },
  },
};

// ---------------------------------------------------------------------------
// Env schema

/** Treat empty strings as absent so a copied-but-unfilled .env.example is inert. */
const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

const EnvSchema = z.object({
  CHAIN: z.preprocess(emptyToUndefined, z.enum(["base-sepolia", "base"]).default("base-sepolia")),
  BASE_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  BASE_SEPOLIA_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MONITORED_ADDRESS: z.preprocess(emptyToUndefined, addressSchema.optional()),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  KEEPERHUB_API_KEY: z.preprocess(emptyToUndefined, z.string().startsWith("kh_").optional()),
  KEEPERHUB_DEFEND_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  TELEGRAM_CHAT_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // SAFETY-CRITICAL: strict enums — "flase"/"yes"/"TRUE" must fail loudly, never coerce.
  DRY_RUN: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  RIPCORD_ARM: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
  MAX_TX_USD: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(15)),
  DAILY_CAP_USD: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(30)),
  MIN_HF_IMPROVEMENT: z.preprocess(emptyToUndefined, z.coerce.number().nonnegative().default(0.05)),
  // Optional knobs (code defaults; documented in README, intentionally not in .env.example)
  RIPCORD_POLL_SEC: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  RIPCORD_DB_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  RIPCORD_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});

// ---------------------------------------------------------------------------
// AppConfig

export interface Capabilities {
  /** Live Aave reads possible (monitored address present; RPC always has a public default). */
  chainReads: boolean;
  /** LLM planner/critic (vs deterministic heuristics). */
  llm: boolean;
  /** Real KeeperHub execution (vs MockKeeperHubClient). */
  keeperhub: boolean;
  telegram: boolean;
}

export interface AppConfig {
  chain: Chain;
  rpcUrl: string;
  monitoredAddress?: Address;
  anthropicApiKey?: string;
  model: string;
  keeperhubApiKey?: string;
  keeperhubWebhookUrl?: string;
  keeperhubApiBaseUrl: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  dryRun: boolean;
  armed: boolean;
  caps: { maxTxUsd: number; dailyCapUsd: number; minHfImprovement: number };
  capsCents: { maxTxCents: number; dailyCapCents: number };
  thresholds: Thresholds;
  thresholdsWad: ThresholdsWad;
  pollSec: number;
  dbPath: string;
  addressBook: AddressBook;
  capabilities: Capabilities;
}

/** Exact money conversion boundary: USD floats become integer cents exactly once, here. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new Error(`usdToCents: non-finite amount ${usd}`);
  }
  return Math.round(usd * 100);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;

  const chain: Chain = e.CHAIN;
  const dryRun = e.DRY_RUN === "true";
  const armed = e.RIPCORD_ARM === "1";

  // Refuse to even start half-armed on mainnet (belt; the Guard is suspenders).
  if (chain === "base" && !dryRun && !armed) {
    throw new Error(
      "Refusing to start: CHAIN=base with DRY_RUN=false requires RIPCORD_ARM=1. " +
        "Either keep DRY_RUN=true or explicitly arm with RIPCORD_ARM=1.",
    );
  }

  const rpcUrl =
    chain === "base"
      ? (e.BASE_RPC_URL ?? DEFAULT_RPC_URLS.base)
      : (e.BASE_SEPOLIA_RPC_URL ?? DEFAULT_RPC_URLS["base-sepolia"]);

  const capabilities: Capabilities = {
    chainReads: e.MONITORED_ADDRESS !== undefined,
    llm: e.ANTHROPIC_API_KEY !== undefined,
    keeperhub: e.KEEPERHUB_DEFEND_WEBHOOK_URL !== undefined,
    telegram: e.TELEGRAM_BOT_TOKEN !== undefined && e.TELEGRAM_CHAT_ID !== undefined,
  };

  return {
    chain,
    rpcUrl,
    monitoredAddress: e.MONITORED_ADDRESS as Address | undefined,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    model: e.RIPCORD_MODEL ?? DEFAULT_MODEL,
    keeperhubApiKey: e.KEEPERHUB_API_KEY,
    keeperhubWebhookUrl: e.KEEPERHUB_DEFEND_WEBHOOK_URL,
    keeperhubApiBaseUrl: KEEPERHUB_API_BASE_URL,
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
    dryRun,
    armed,
    caps: {
      maxTxUsd: e.MAX_TX_USD,
      dailyCapUsd: e.DAILY_CAP_USD,
      minHfImprovement: e.MIN_HF_IMPROVEMENT,
    },
    capsCents: {
      maxTxCents: usdToCents(e.MAX_TX_USD),
      dailyCapCents: usdToCents(e.DAILY_CAP_USD),
    },
    thresholds: THRESHOLDS,
    thresholdsWad: THRESHOLDS_WAD,
    pollSec: e.RIPCORD_POLL_SEC ?? DEFAULT_POLL_SEC,
    dbPath: e.RIPCORD_DB_PATH ?? DEFAULT_DB_PATH,
    addressBook: ADDRESS_BOOK[chain],
    capabilities,
  };
}

let cached: AppConfig | undefined;

/** Lazy singleton for the daemon/status/scripts. Loads .env once (never in tests). */
export async function getConfig(): Promise<AppConfig> {
  if (!cached) {
    const { config: loadDotenv } = await import("dotenv");
    loadDotenv({ quiet: true });
    cached = loadConfig(process.env);
  }
  return cached;
}
