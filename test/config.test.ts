import { describe, expect, it } from "vitest";
import { ADDRESS_BOOK, loadConfig, THRESHOLDS_WAD, usdToCents } from "../src/config.js";

const base = { CHAIN: "base-sepolia" } as NodeJS.ProcessEnv;

describe("config: defaults", () => {
  it("applies safe defaults with an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.chain).toBe("base-sepolia");
    expect(cfg.dryRun).toBe(true);
    expect(cfg.armed).toBe(false);
    expect(cfg.caps).toEqual({ maxTxUsd: 15, dailyCapUsd: 30, minHfImprovement: 0.05 });
    expect(cfg.capsCents).toEqual({ maxTxCents: 1500, dailyCapCents: 3000 });
    expect(cfg.rpcUrl).toBe("https://sepolia.base.org");
    expect(cfg.model).toBe("claude-sonnet-5");
    expect(cfg.thresholds.cooldownSec).toBe(1800);
  });

  it("selects the mainnet public RPC for CHAIN=base", () => {
    const cfg = loadConfig({ CHAIN: "base" });
    expect(cfg.rpcUrl).toBe("https://mainnet.base.org");
    expect(cfg.addressBook.aavePool.address).toBe(ADDRESS_BOOK.base.aavePool.address);
  });

  it("env RPC overrides the public default", () => {
    const cfg = loadConfig({ ...base, BASE_SEPOLIA_RPC_URL: "https://example.com/rpc" });
    expect(cfg.rpcUrl).toBe("https://example.com/rpc");
  });
});

describe("config: safety-critical strictness", () => {
  it("rejects a DRY_RUN typo instead of coercing", () => {
    expect(() => loadConfig({ ...base, DRY_RUN: "flase" })).toThrow(/DRY_RUN/);
    expect(() => loadConfig({ ...base, DRY_RUN: "TRUE" })).toThrow(/DRY_RUN/);
    expect(() => loadConfig({ ...base, DRY_RUN: "yes" })).toThrow(/DRY_RUN/);
  });

  it("rejects a RIPCORD_ARM typo instead of coercing", () => {
    expect(() => loadConfig({ ...base, RIPCORD_ARM: "true" })).toThrow(/RIPCORD_ARM/);
    expect(() => loadConfig({ ...base, RIPCORD_ARM: "2" })).toThrow(/RIPCORD_ARM/);
  });

  it("refuses to start half-armed on mainnet (DRY_RUN=false without ARM)", () => {
    expect(() => loadConfig({ CHAIN: "base", DRY_RUN: "false" })).toThrow(/RIPCORD_ARM=1/);
  });

  it("allows mainnet when explicitly armed, and testnet live without arming", () => {
    expect(loadConfig({ CHAIN: "base", DRY_RUN: "false", RIPCORD_ARM: "1" }).armed).toBe(true);
    expect(loadConfig({ ...base, DRY_RUN: "false" }).dryRun).toBe(false);
  });

  it("refuses to pair the MOCK sensor with a LIVE executor", () => {
    // The critical case: .env.example ships MONITORED_ADDRESS blank. An operator
    // who fills in the webhook URL and disables DRY_RUN would otherwise have the
    // scripted mock HF descent drive real transactions against a fake position.
    const dangerous = {
      CHAIN: "base",
      DRY_RUN: "false",
      RIPCORD_ARM: "1",
      KEEPERHUB_DEFEND_WEBHOOK_URL: "https://app.keeperhub.com/hook/wf2",
      MONITORED_ADDRESS: "",
    };
    expect(() => loadConfig(dangerous)).toThrow(/MOCK sensor/);
    // …and the same combination on testnet is refused too.
    expect(() => loadConfig({ ...dangerous, CHAIN: "base-sepolia", RIPCORD_ARM: "0" })).toThrow(
      /MOCK sensor/,
    );
  });

  it("allows a live executor once a monitored address is configured", () => {
    const cfg = loadConfig({
      CHAIN: "base",
      DRY_RUN: "false",
      RIPCORD_ARM: "1",
      KEEPERHUB_DEFEND_WEBHOOK_URL: "https://app.keeperhub.com/hook/wf2",
      MONITORED_ADDRESS: "0x1111111111111111111111111111111111111111",
    });
    expect(cfg.capabilities).toMatchObject({ chainReads: true, keeperhub: true });
  });

  it("still allows a live executor in DRY_RUN without a monitored address", () => {
    // Harmless: DRY_RUN holds fire, so the mock position cannot cause a transaction.
    expect(() =>
      loadConfig({
        KEEPERHUB_DEFEND_WEBHOOK_URL: "https://app.keeperhub.com/hook/wf2",
      }),
    ).not.toThrow();
  });

  it("refuses a MAX_TX_USD above WF-2's own ceiling, which would decline every defense", () => {
    // WF-2's gate carries a hard 60-USDC rule. Above it the workflow declines
    // and the run still ends "success" with no transaction — a silent no-op
    // exactly when a position needs defending. Fail at startup instead.
    const live = {
      ...base,
      MONITORED_ADDRESS: "0x1111111111111111111111111111111111111111",
      KEEPERHUB_DEFEND_WEBHOOK_URL: "https://app.keeperhub.com/api/workflows/wf2/execute",
    };
    expect(() => loadConfig({ ...live, MAX_TX_USD: "61" })).toThrow(/exceeds WF-2/);
    expect(() => loadConfig({ ...live, MAX_TX_USD: "60" })).not.toThrow();

    // Only relevant when a live executor is wired — the mock has no ceiling.
    expect(() => loadConfig({ ...base, MAX_TX_USD: "500" })).not.toThrow();
  });

  it("rejects a malformed MONITORED_ADDRESS", () => {
    expect(() => loadConfig({ ...base, MONITORED_ADDRESS: "0x123" })).toThrow(/address/);
  });

  it("rejects a KeeperHub key without the kh_ prefix", () => {
    expect(() => loadConfig({ ...base, KEEPERHUB_API_KEY: "sk_wrong" })).toThrow(
      /KEEPERHUB_API_KEY/,
    );
  });
});

describe("config: empty strings behave like absent vars", () => {
  it("treats copied-but-unfilled .env.example values as absent", () => {
    const cfg = loadConfig({
      CHAIN: "",
      BASE_RPC_URL: "",
      MONITORED_ADDRESS: "",
      ANTHROPIC_API_KEY: "",
      DRY_RUN: "",
      RIPCORD_ARM: "",
      MAX_TX_USD: "",
    });
    expect(cfg.chain).toBe("base-sepolia");
    expect(cfg.dryRun).toBe(true);
    expect(cfg.caps.maxTxUsd).toBe(15);
    expect(cfg.capabilities.chainReads).toBe(false);
  });
});

describe("config: capability matrix", () => {
  it("zero secrets → everything mocked", () => {
    expect(loadConfig({}).capabilities).toEqual({
      chainReads: false,
      llm: false,
      keeperhub: false,
      telegram: false,
    });
  });

  it("each capability flips on its own env vars", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    expect(loadConfig({ ...base, MONITORED_ADDRESS: addr }).capabilities.chainReads).toBe(true);
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-x" }).capabilities.llm).toBe(true);
    expect(
      loadConfig({ ...base, KEEPERHUB_DEFEND_WEBHOOK_URL: "https://x.com/hook" }).capabilities
        .keeperhub,
    ).toBe(true);
    // Telegram needs BOTH token and chat id
    expect(loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "t" }).capabilities.telegram).toBe(false);
    expect(
      loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" }).capabilities.telegram,
    ).toBe(true);
  });
});

describe("config: wad thresholds and cents", () => {
  it("wad thresholds encode the spec values exactly", () => {
    expect(THRESHOLDS_WAD.warn).toBe(1_500_000_000_000_000_000n);
    expect(THRESHOLDS_WAD.act).toBe(1_250_000_000_000_000_000n);
    expect(THRESHOLDS_WAD.panic).toBe(1_100_000_000_000_000_000n);
    expect(THRESHOLDS_WAD.rearm).toBe(1_550_000_000_000_000_000n);
  });

  it("usdToCents is exact and rejects non-finite input", () => {
    expect(usdToCents(15)).toBe(1500);
    expect(usdToCents(0.1 + 0.2)).toBe(30); // float artifact dies at the boundary
    expect(usdToCents(12.345)).toBe(1235); // Math.round pinned
    expect(() => usdToCents(Number.NaN)).toThrow();
    expect(() => usdToCents(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("all allowlist addresses are verified and non-zero", () => {
    for (const book of Object.values(ADDRESS_BOOK)) {
      for (const entry of [book.aavePool, book.usdc, book.collateral]) {
        expect(entry.verified).toBe(true);
        expect(entry.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(entry.address).not.toBe("0x0000000000000000000000000000000000000000");
      }
    }
  });
});
