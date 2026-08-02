/**
 * Single source of truth: env parsing, thresholds, address-book allowlist, capabilities.
 *
 * SAFETY INVARIANTS ENFORCED HERE
 * - DRY_RUN / RIPCORD_ARM are strict enums: a typo fails loudly instead of arming.
 * - Addresses and selectors come ONLY from ADDRESS_BOOK below — never from LLM output.
 * - Refuses to start half-armed on mainnet (CHAIN=base + DRY_RUN=false requires RIPCORD_ARM=1).
 */

import { z } from "zod";
import type { Address, AddressBook, Chain, Thresholds, ThresholdsWad } from "./types.js";

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
/**
 * Aave's permissionless testnet faucet on Base Sepolia (`isPermissioned() == false`).
 * Mint test tokens with `mint(token, to, amount)`. Verified on-chain 2026-08-01.
 */
export const BASE_SEPOLIA_FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc" as const;

export const KEEPERHUB_API_BASE_URL = "https://app.keeperhub.com/api";

/**
 * WF-2's own per-defense ceiling, in USD, mirrored from the deployed workflow —
 * `gate-1` → `rule-amount-hard-cap-60-usdc` in workflows/wf2-defend.json.
 *
 * The workflow enforces this independently of anything Ripcord sends, which is
 * the point: it is a limit the daemon cannot talk its way past. Kept here only
 * so `loadConfig` can refuse a MAX_TX_USD the workflow would silently decline.
 * If you change one, change the other.
 */
export const WF2_AMOUNT_CEILING_USD = 60;

/** Public endpoints (rate-limited; fine for the hackathon, override via env for volume). */
export const DEFAULT_RPC_URLS: Record<Chain, string> = {
  base: "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
};

export const TOKEN_DECIMALS = { USDC: 6, WETH: 18, cbETH: 18 } as const;

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
    collateral: {
      symbol: "WETH",
      decimals: 18,
      address: "0x4200000000000000000000000000000000000006",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3Base.sol @ 2026-07-30 (OP-stack predeploy)",
      // WETH is ETH by definition — a tight ±5% band.
      refRatioMin: 0.95,
      refRatioMax: 1.05,
    },
    chainlinkEthUsd: {
      address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
      verified: true,
      source:
        'Chainlink docs + on-chain description()=="ETH / USD", decimals()==8, live answer 2026-08-02',
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
    // cbETH, not WETH: the Base Sepolia WETH reserve is at its supply cap
    // (997/1000 supplied; even 0.0001 reverts SupplyCapExceeded). cbETH has no
    // cap, LT 84.5%, and is faucet-mintable. Verified on-chain 2026-08-01.
    collateral: {
      symbol: "cbETH",
      decimals: 18,
      address: "0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B",
      verified: true,
      source: "bgd-labs/aave-address-book AaveV3BaseSepolia.sol + live supply 2026-08-01",
      // cbETH carries a legitimate staking premium over ETH and testnet pricing
      // is loose — a wide band that still catches order-of-magnitude anomalies
      // (Moonwell's $1.12 print was ratio ≈ 0.0006, four orders below the floor).
      refRatioMin: 0.8,
      refRatioMax: 1.4,
    },
    chainlinkEthUsd: {
      address: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
      verified: true,
      source:
        'Chainlink docs + on-chain description()=="ETH / USD", decimals()==8, live answer 2026-08-02',
    },
  },
};

// ---------------------------------------------------------------------------
// Env schema

/** Treat empty strings as absent so a copied-but-unfilled .env.example is inert. */
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

const EnvSchema = z.object({
  CHAIN: z.preprocess(emptyToUndefined, z.enum(["base-sepolia", "base"]).default("base-sepolia")),
  BASE_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  BASE_SEPOLIA_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MONITORED_ADDRESS: z.preprocess(emptyToUndefined, addressSchema.optional()),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Point the Anthropic-protocol client at a compatible endpoint (e.g. a
  // self-hosted or third-party gateway). Unset = api.anthropic.com.
  ANTHROPIC_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
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
  anthropicBaseUrl?: string;
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

/**
 * Render an RPC endpoint for logs with the path elided.
 * Provider URLs routinely carry the API key as a path segment
 * (`https://base-mainnet.g.alchemy.com/v2/<KEY>`), so the raw URL is a secret
 * and must never reach a log line, an error string, or the status output.
 */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" && u.search === "" ? u.origin : `${u.origin}/…`;
  } catch {
    return "[unparseable-rpc-url]";
  }
}

/** Scrub an RPC URL (and its key-bearing tail) out of arbitrary error text. */
export function scrubRpcUrl(text: string, rpcUrl: string): string {
  if (rpcUrl === "") return text;
  let out = text.split(rpcUrl).join(redactRpcUrl(rpcUrl));
  try {
    const path = new URL(rpcUrl).pathname;
    if (path.length > 1) out = out.split(path).join("/…");
  } catch {
    /* unparseable — the whole-URL replacement above is the best we can do */
  }
  return out;
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
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;

  const chain: Chain = e.CHAIN;
  const dryRun = e.DRY_RUN === "true";
  const armed = e.RIPCORD_ARM === "1";
  const liveReads = e.MONITORED_ADDRESS !== undefined;
  const liveExecutor = e.KEEPERHUB_DEFEND_WEBHOOK_URL !== undefined;

  // Refuse to even start half-armed on mainnet (belt; the Guard is suspenders).
  if (chain === "base" && !dryRun && !armed) {
    throw new Error(
      "Refusing to start: CHAIN=base with DRY_RUN=false requires RIPCORD_ARM=1. " +
        "Either keep DRY_RUN=true or explicitly arm with RIPCORD_ARM=1.",
    );
  }

  // Refuse to pair the MOCK sensor with a LIVE executor. Missing capabilities
  // degrade to mocks, which is what makes the zero-secret demo work — but a
  // fabricated position must never be able to trigger a real transaction.
  // Concretely: .env.example ships MONITORED_ADDRESS blank, so an operator who
  // fills in the webhook URL and arms the daemon would otherwise have the
  // scripted mock HF descent drive real defenses against a synthetic position.
  if (!dryRun && liveExecutor && !liveReads) {
    throw new Error(
      "Refusing to start: a live KeeperHub executor is configured " +
        "(KEEPERHUB_DEFEND_WEBHOOK_URL) with DRY_RUN=false, but MONITORED_ADDRESS is unset " +
        "so chain reads would come from the MOCK sensor. A simulated position must never " +
        "drive real transactions. Set MONITORED_ADDRESS, or keep DRY_RUN=true.",
    );
  }

  // Refuse a per-transaction cap the defense workflow would reject anyway.
  // WF-2's gate carries its own hard ceiling (rule-amount-hard-cap-60-usdc), so
  // raising MAX_TX_USD above it does not buy a bigger defense — it makes every
  // defense get declined by the workflow instead. That failure is quiet: the
  // run still ends "success", just with no transaction. Fail loudly at startup
  // rather than discover it when a position actually needs defending.
  if (liveExecutor && e.MAX_TX_USD > WF2_AMOUNT_CEILING_USD) {
    throw new Error(
      `Refusing to start: MAX_TX_USD=${e.MAX_TX_USD} exceeds WF-2's own ` +
        `$${WF2_AMOUNT_CEILING_USD} per-defense ceiling, so every defense would be declined ` +
        "by the workflow with no transaction sent. Lower MAX_TX_USD, or raise the ceiling in " +
        "workflows/wf2-defend.json (rule-amount-hard-cap-60-usdc) and redeploy it first.",
    );
  }

  const rpcUrl =
    chain === "base"
      ? (e.BASE_RPC_URL ?? DEFAULT_RPC_URLS.base)
      : (e.BASE_SEPOLIA_RPC_URL ?? DEFAULT_RPC_URLS["base-sepolia"]);

  const capabilities: Capabilities = {
    chainReads: liveReads,
    llm: e.ANTHROPIC_API_KEY !== undefined,
    keeperhub: liveExecutor,
    telegram: e.TELEGRAM_BOT_TOKEN !== undefined && e.TELEGRAM_CHAT_ID !== undefined,
  };

  return {
    chain,
    rpcUrl,
    monitoredAddress: e.MONITORED_ADDRESS as Address | undefined,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicBaseUrl: e.ANTHROPIC_BASE_URL,
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
