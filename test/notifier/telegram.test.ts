import { describe, expect, it } from "vitest";
import { createNotifier } from "../../src/notifier/telegram.js";
import type { DecisionNotification } from "../../src/types.js";
import { makeTestConfig } from "../helpers/fakes.js";

// Obviously-fake credentials — never a real secret.
const FAKE_TOKEN = "1234567890:FAKE-test-token-AAAAAAAAAAAAAAAAAAA";
const FAKE_CHAT_ID = "-1001234567890";

const TELEGRAM_ENV = {
  TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
  TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
};

function fakeLogger() {
  const entries: Array<{ level: "info" | "warn" | "debug"; obj: unknown; msg?: string }> = [];
  const mk =
    (level: "info" | "warn" | "debug") =>
    (obj: unknown, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  return {
    entries,
    ofLevel: (level: "info" | "warn" | "debug") => entries.filter((e) => e.level === level),
    logger: { info: mk("info"), warn: mk("warn"), debug: mk("debug") },
  };
}

function capturingFetch(status = 200): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  impl: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response('{"ok":true}', { status });
  };
  return { calls, impl };
}

function defense(partial: Partial<DecisionNotification> = {}): DecisionNotification {
  return {
    kind: "defense",
    chain: "base-sepolia",
    band: "act",
    decisionId: "01JDEC1SIONULID0000000000",
    dryRun: false,
    hf: 1.21,
    action: "repay",
    amountUsd: 12.5,
    expectedHfAfter: 1.64,
    rationale: "HF slid into the act band; a small repay restores the buffer",
    runId: "run-42",
    ...partial,
  };
}

function sentText(calls: Array<{ url: string; init: RequestInit | undefined }>): string {
  const body = JSON.parse(String(calls[0]?.init?.body)) as { text: string };
  return body.text;
}

describe("createNotifier (telegram)", () => {
  it("posts to the exact bot URL with chat_id, HTML parse_mode, and preview disabled", async () => {
    const cfg = makeTestConfig(TELEGRAM_ENV);
    const { calls, impl } = capturingFetch();
    const { logger } = fakeLogger();

    await createNotifier(cfg, logger, impl).notify(defense());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.chat_id).toBe(FAKE_CHAT_ID);
    expect(body.parse_mode).toBe("HTML");
    expect(body.disable_web_page_preview).toBe(true);
  });

  it("defense message carries action, 2dp amount, both HF numbers, rationale, ids", async () => {
    const cfg = makeTestConfig(TELEGRAM_ENV);
    const { calls, impl } = capturingFetch();
    const { logger } = fakeLogger();

    await createNotifier(cfg, logger, impl).notify(defense());

    const text = sentText(calls);
    expect(text).toContain("[act] repay $12.50");
    expect(text).toContain("HF 1.21 → expected 1.64");
    expect(text).toContain("a small repay restores the buffer");
    expect(text).toContain("decision 01JDEC1SIONULID0000000000");
    expect(text).toContain("run run-42");
  });

  it("includes the DRY_RUN marker iff dryRun is set", async () => {
    const cfg = makeTestConfig(TELEGRAM_ENV);
    const { logger } = fakeLogger();

    const wet = capturingFetch();
    await createNotifier(cfg, logger, wet.impl).notify(defense({ dryRun: false }));
    expect(sentText(wet.calls)).not.toContain("DRY_RUN");

    const dry = capturingFetch();
    await createNotifier(cfg, logger, dry.impl).notify(defense({ dryRun: true }));
    expect(sentText(dry.calls)).toContain("⚠️ DRY_RUN — no transaction sent");
  });

  it("links basescan per chain: sepolia host on base-sepolia, bare host on base", async () => {
    const { logger } = fakeLogger();
    const hash = "0xabc123def4560000000000000000000000000000000000000000000000000000";

    const sepolia = capturingFetch();
    await createNotifier(makeTestConfig(TELEGRAM_ENV), logger, sepolia.impl).notify(
      defense({ chain: "base-sepolia", txHash: hash }),
    );
    expect(sentText(sepolia.calls)).toContain(`tx: https://sepolia.basescan.org/tx/${hash}`);

    const mainnet = capturingFetch();
    await createNotifier(
      makeTestConfig({ CHAIN: "base", ...TELEGRAM_ENV }),
      logger,
      mainnet.impl,
    ).notify(defense({ chain: "base", txHash: hash }));
    expect(sentText(mainnet.calls)).toContain(`tx: https://basescan.org/tx/${hash}`);
    expect(sentText(mainnet.calls)).not.toContain("sepolia");
  });

  it("unconfigured → never calls fetch, logger.debug carries the would-send text", async () => {
    const cfg = makeTestConfig(); // no telegram env → capabilities.telegram false
    expect(cfg.capabilities.telegram).toBe(false);
    const { calls, impl } = capturingFetch();
    const { logger, ofLevel } = fakeLogger();

    await createNotifier(cfg, logger, impl).notify(defense());

    expect(calls).toHaveLength(0);
    const debugs = ofLevel("debug");
    expect(debugs.length).toBeGreaterThan(0);
    expect(JSON.stringify(debugs)).toContain("[act] repay $12.50");
  });

  it("fetch throwing → resolves (never throws) and warns WITHOUT the bot token", async () => {
    const cfg = makeTestConfig(TELEGRAM_ENV);
    const { logger, ofLevel } = fakeLogger();
    const throwing: typeof fetch = async () => {
      // Realistic worst case: the error text embeds the full URL (token included).
      throw new Error(`ECONNRESET https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    };

    await expect(createNotifier(cfg, logger, throwing).notify(defense())).resolves.toBeUndefined();

    const warns = ofLevel("warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(JSON.stringify(warns)).not.toContain(FAKE_TOKEN);
  });

  it("non-2xx response → resolves and warns without the bot token", async () => {
    const cfg = makeTestConfig(TELEGRAM_ENV);
    const { impl } = capturingFetch(500);
    const { logger, ofLevel } = fakeLogger();

    await expect(createNotifier(cfg, logger, impl).notify(defense())).resolves.toBeUndefined();

    const warns = ofLevel("warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(JSON.stringify(warns)).not.toContain(FAKE_TOKEN);
  });

  it("HTML-escapes user-influenced strings (rationale with <script> and &)", async () => {
    const cfg = makeTestConfig(TELEGRAM_ENV);
    const { calls, impl } = capturingFetch();
    const { logger } = fakeLogger();

    await createNotifier(cfg, logger, impl).notify(
      defense({ rationale: '<script>alert("x")</script> & profit' }),
    );

    const text = sentText(calls);
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("&lt;/script&gt;");
    expect(text).toContain("&amp; profit");
    expect(text).not.toContain("<script>");
  });
});
