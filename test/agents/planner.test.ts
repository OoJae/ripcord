import { describe, expect, it } from "vitest";
import { createHeuristicPlanner, createLlmPlanner } from "../../src/agents/planner.js";
import { buildPlannerPrompt } from "../../src/agents/prompts.js";
import { SchemaValidationError } from "../../src/agents/schemas.js";
import { THRESHOLDS } from "../../src/config.js";
import type { PlannerContext } from "../../src/types.js";
import { FakeLlmClient, makeSnapshot } from "../helpers/fakes.js";

const CAPS = { maxTxUsd: 15, dailyCapUsd: 30, minHfImprovement: 0.05 };

function ctx(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    snapshot: makeSnapshot("1.20"),
    thresholds: THRESHOLDS,
    caps: CAPS,
    recentDecisions: [],
    ...overrides,
  };
}

const VALID = JSON.stringify({
  action: "repay",
  asset: "USDC",
  amountUsd: 5,
  expectedHfAfter: 1.6,
  rationale: "reduce debt to restore the safety buffer",
});

describe("planner: accepted outputs", () => {
  it("accepts valid JSON on the first attempt", async () => {
    const llm = new FakeLlmClient([VALID]);
    const { proposal, raw } = await createLlmPlanner(llm).plan(ctx());
    expect(proposal.action).toBe("repay");
    expect(proposal.amountUsd).toBe(5);
    expect(raw).toBe(VALID);
    expect(llm.calls).toHaveLength(1);
  });

  it("accepts a ```json fenced object (the only leniency)", async () => {
    const llm = new FakeLlmClient(["```json\n" + VALID + "\n```"]);
    const { proposal } = await createLlmPlanner(llm).plan(ctx());
    expect(proposal.action).toBe("repay");
    expect(llm.calls).toHaveLength(1);
  });

  it("retries after prose and feeds the failure back into the prompt", async () => {
    const llm = new FakeLlmClient(["I think we should repay about $10 of USDC.", VALID]);
    const { proposal } = await createLlmPlanner(llm).plan(ctx());
    expect(proposal.amountUsd).toBe(5);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.user).toMatch(/failed validation/);
  });
});

describe("planner: rejected outputs (each retries, never silently passes)", () => {
  const bad: Array<[string, string]> = [
    [
      "missing amountUsd",
      '{"action":"repay","asset":"USDC","expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "unknown action enum",
      '{"action":"swap","asset":"USDC","amountUsd":5,"expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "negative amount",
      '{"action":"repay","asset":"USDC","amountUsd":-50,"expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "zero amount for a real action",
      '{"action":"repay","asset":"USDC","amountUsd":0,"expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "amount as a string (no coercion)",
      '{"action":"repay","asset":"USDC","amountUsd":"12","expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "absurd amount above the sanity ceiling",
      '{"action":"repay","asset":"USDC","amountUsd":1000000000,"expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "hallucinated extra field (strict, not stripped)",
      '{"action":"repay","asset":"USDC","amountUsd":5,"expectedHfAfter":1.6,"rationale":"x","toAddress":"0xdeadbeef"}',
    ],
    [
      "asset that is really an address",
      '{"action":"repay","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","amountUsd":5,"expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "mismatched action/asset pairing",
      '{"action":"repay","asset":"WETH","amountUsd":5,"expectedHfAfter":1.6,"rationale":"x"}',
    ],
    [
      "address smuggled into the rationale prose",
      '{"action":"repay","asset":"USDC","amountUsd":5,"expectedHfAfter":1.6,"rationale":"send to 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}',
    ],
  ];

  for (const [label, payload] of bad) {
    it(`rejects ${label} and retries`, async () => {
      const llm = new FakeLlmClient([payload, VALID]);
      const { proposal } = await createLlmPlanner(llm).plan(ctx());
      expect(proposal.amountUsd).toBe(5); // the good second answer won
      expect(llm.calls).toHaveLength(2);
    });
  }

  it("throws SchemaValidationError once the retry budget is exhausted", async () => {
    const llm = new FakeLlmClient(["nope", "{}", "still not json"]);
    await expect(createLlmPlanner(llm).plan(ctx())).rejects.toBeInstanceOf(SchemaValidationError);
    expect(llm.calls).toHaveLength(3);
  });

  it("carries the attempt count and every raw output on the error", async () => {
    const llm = new FakeLlmClient(["a", "b", "c"]);
    await createLlmPlanner(llm)
      .plan(ctx())
      .catch((err: unknown) => {
        const e = err as SchemaValidationError;
        expect(e.attempts).toBe(3);
        expect(e.rawOutputs).toEqual(["a", "b", "c"]);
      });
  });
});

describe("planner: prompt hygiene", () => {
  it("includes caps and thresholds, and renders no-debt without the raw sentinel", () => {
    const snapshot = makeSnapshot("1.20", {
      hasDebt: false,
      hf: Number.POSITIVE_INFINITY,
      hfWad: 2n ** 256n - 1n,
    });
    const { system, user } = buildPlannerPrompt(ctx({ snapshot }));
    expect(user).toContain("MAX_TX_USD: $15.00");
    expect(user).toContain("DAILY_CAP_USD: $30.00");
    expect(user).toContain("no debt");
    expect(user).not.toContain(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
    expect(user).not.toContain("Infinity");
    expect(system).toMatch(/never output a contract address/i);
  });

  it("tells the Planner to size minimally and warns that its claim is recomputed", () => {
    // Both learned from a live run: Mimo maxed out MAX_TX_USD when ~a third of it
    // would do, and overstated expectedHfAfter (6.41 vs a true 5.01).
    const { system } = buildPlannerPrompt(ctx());
    expect(system).toMatch(/SMALLEST amount/);
    expect(system).toMatch(/Do NOT max out MAX_TX_USD/);
    expect(system).toMatch(/deterministic guard\s+recomputes it/i);
    // the deterministic minimum is supplied, not left to model arithmetic
    expect(buildPlannerPrompt(ctx()).user).toMatch(
      /smallest repayment that clears the target: \$5\.00/,
    );
  });
});

describe("planner: heuristic (zero-secret demo brain)", () => {
  it("sizes a repayment that reaches the target and respects caps and balances", async () => {
    // collateral $30 @ LT 80% → $24 effective; debt $20; target 1.6 → repay $5.
    const { proposal, raw } = await createHeuristicPlanner().plan(ctx());
    expect(proposal.action).toBe("repay");
    expect(proposal.asset).toBe("USDC");
    expect(proposal.amountUsd).toBeCloseTo(5, 2);
    expect(proposal.amountUsd).toBeLessThanOrEqual(CAPS.maxTxUsd);
    expect(proposal.amountUsd).toBeLessThanOrEqual(25 * 0.9);
    expect(proposal.expectedHfAfter).toBeGreaterThanOrEqual(THRESHOLDS.targetHf);
    expect(raw).toBeNull();
  });

  it("proposes no action when the position already clears the target", async () => {
    const { proposal } = await createHeuristicPlanner().plan(
      ctx({ snapshot: makeSnapshot("2.00", { totalDebtUsd: 5 }) }),
    );
    expect(proposal.action).toBe("none");
    expect(proposal.amountUsd).toBe(0);
  });

  it("proposes no action when no USDC is available to repay with", async () => {
    const snapshot = makeSnapshot("1.20", {
      balances: { usdcRaw: 0n, usdcUsd: 0, wethRaw: 0n, wethEth: 0 },
    });
    const { proposal } = await createHeuristicPlanner().plan(ctx({ snapshot }));
    expect(proposal.action).toBe("none");
  });
});
