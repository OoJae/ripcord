import { describe, expect, it } from "vitest";
import { createHeuristicCritic, createLlmCritic } from "../../src/agents/critic.js";
import { THRESHOLDS } from "../../src/config.js";
import type { PlannerProposal } from "../../src/types.js";
import { FakeLlmClient, makeSnapshot } from "../helpers/fakes.js";

const CAPS = { maxTxUsd: 15, dailyCapUsd: 30, minHfImprovement: 0.05 };
const SNAP = makeSnapshot("1.20"); // collateral $30 @ LT 80% → $24 effective, debt $20

function proposal(overrides: Partial<PlannerProposal> = {}): PlannerProposal {
  return {
    action: "repay",
    asset: "USDC",
    amountUsd: 5,
    expectedHfAfter: 1.6,
    rationale: "restore the buffer",
    ...overrides,
  };
}

describe("critic: LLM verdicts", () => {
  it("parses an APPROVE", async () => {
    const llm = new FakeLlmClient(['{"verdict":"APPROVE","reason":"hfAfter 1.60 clears target"}']);
    const { verdict } = await createLlmCritic(llm).critique(SNAP, proposal(), THRESHOLDS, CAPS);
    expect(verdict.verdict).toBe("APPROVE");
    expect(llm.calls).toHaveLength(1);
  });

  it("parses a REJECT", async () => {
    const llm = new FakeLlmClient(['{"verdict":"REJECT","reason":"hfAfter 1.26 misses target"}']);
    const { verdict } = await createLlmCritic(llm).critique(SNAP, proposal(), THRESHOLDS, CAPS);
    expect(verdict.verdict).toBe("REJECT");
  });

  it("rejects a lowercase verdict then accepts the corrected retry", async () => {
    const llm = new FakeLlmClient([
      '{"verdict":"approve","reason":"looks fine"}',
      '{"verdict":"APPROVE","reason":"hfAfter 1.60 clears target"}',
    ]);
    const { verdict } = await createLlmCritic(llm).critique(SNAP, proposal(), THRESHOLDS, CAPS);
    expect(verdict.verdict).toBe("APPROVE");
    expect(llm.calls).toHaveLength(2);
  });

  it("rejects an extra hallucinated field (strict schema)", async () => {
    const llm = new FakeLlmClient([
      '{"verdict":"APPROVE","reason":"ok","override":true}',
      '{"verdict":"APPROVE","reason":"hfAfter 1.60 clears target"}',
    ]);
    await createLlmCritic(llm).critique(SNAP, proposal(), THRESHOLDS, CAPS);
    expect(llm.calls).toHaveLength(2);
  });

  it("FAILS CLOSED: exhausted retries resolve to REJECT rather than throwing", async () => {
    // The single most important agent-layer invariant: a Critic that cannot
    // produce a valid verdict must never be mistaken for "no objection".
    const llm = new FakeLlmClient(["garbage", "{}", "still garbage"]);
    const result = await createLlmCritic(llm).critique(SNAP, proposal(), THRESHOLDS, CAPS);
    expect(result.verdict.verdict).toBe("REJECT");
    expect(result.verdict.reason).toMatch(/failed validation/);
    expect(llm.calls).toHaveLength(3);
  });
});

describe("critic: heuristic verifier recomputes independently", () => {
  const critic = createHeuristicCritic();

  it("APPROVEs a sound repayment that reaches the target", async () => {
    // $24 effective collateral / ($20 − $5) = 1.60 → exactly the target.
    const { verdict } = await critic.critique(SNAP, proposal({ amountUsd: 5 }), THRESHOLDS, CAPS);
    expect(verdict.verdict).toBe("APPROVE");
    expect(verdict.reason).toMatch(/1\.6000/);
  });

  it("REJECTs a repayment that falls short of the target", async () => {
    // $24 / ($20 − $1) = 1.263 — well under 1.60.
    const { verdict } = await critic.critique(SNAP, proposal({ amountUsd: 1 }), THRESHOLDS, CAPS);
    expect(verdict.verdict).toBe("REJECT");
    expect(verdict.reason).toMatch(/1\.2632|falls short/);
  });

  it("ignores an inflated expectedHfAfter and trusts its own arithmetic", async () => {
    // The Planner claims 1.99; the truth is 1.263. Independence is the point.
    const { verdict } = await critic.critique(
      SNAP,
      proposal({ amountUsd: 1, expectedHfAfter: 1.99 }),
      THRESHOLDS,
      CAPS,
    );
    expect(verdict.verdict).toBe("REJECT");
  });

  it("REJECTs an amount above the per-transaction cap", async () => {
    const { verdict } = await critic.critique(SNAP, proposal({ amountUsd: 16 }), THRESHOLDS, CAPS);
    expect(verdict.verdict).toBe("REJECT");
    expect(verdict.reason).toMatch(/per-transaction cap/);
  });

  it("REJECTs an amount beyond the wallet balance", async () => {
    const broke = makeSnapshot("1.20", {
      balances: { usdcRaw: 1_000_000n, usdcUsd: 1, wethRaw: 0n, wethEth: 0 },
    });
    const { verdict } = await critic.critique(broke, proposal({ amountUsd: 5 }), THRESHOLDS, CAPS);
    expect(verdict.verdict).toBe("REJECT");
    expect(verdict.reason).toMatch(/wallet balance/);
  });

  it("REJECTs an invalid action/asset pairing", async () => {
    const { verdict } = await critic.critique(
      SNAP,
      proposal({ asset: "WETH" }),
      THRESHOLDS,
      CAPS,
    );
    expect(verdict.verdict).toBe("REJECT");
    expect(verdict.reason).toMatch(/pairing/);
  });

  it("REJECTs a no-action proposal", async () => {
    const { verdict } = await critic.critique(
      SNAP,
      proposal({ action: "none", amountUsd: 0 }),
      THRESHOLDS,
      CAPS,
    );
    expect(verdict.verdict).toBe("REJECT");
  });
});
