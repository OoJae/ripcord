import { describe, expect, it } from "vitest";
import { ADDRESS_BOOK } from "../../src/config.js";
import { checkGuard, type GuardInput } from "../../src/guard/guard.js";
import type { CriticVerdict, GuardResult, GuardRuleId, PlannerProposal } from "../../src/types.js";
import { makeSnapshot } from "../helpers/fakes.js";

/** A fully valid testnet input: repay 10 USDC at HF 1.20, APPROVE, within caps. */
function baseInput(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    proposal: {
      action: "repay",
      asset: "USDC",
      amountUsd: 10,
      expectedHfAfter: 1.45,
      rationale: "HF 1.20 in act band; repay USDC to move toward target 1.6",
    },
    verdict: { verdict: "APPROVE", reason: "proposal is sane and within caps" },
    snapshot: makeSnapshot("1.20"),
    chain: "base-sepolia",
    flags: { dryRun: false, armed: false },
    capsCents: { maxTxCents: 1500, dailyCapCents: 3000 },
    minHfImprovement: 0.05,
    addressBook: ADDRESS_BOOK["base-sepolia"],
    spentTodayCents: 0,
    alreadyExecuted: false,
    ...overrides,
  };
}

function withProposal(
  p: Partial<PlannerProposal>,
  overrides: Partial<GuardInput> = {},
): GuardInput {
  const base = baseInput(overrides);
  return { ...base, proposal: { ...base.proposal, ...p } };
}

function check(res: GuardResult, rule: GuardRuleId) {
  const c = res.checks.find((x) => x.rule === rule);
  expect(c, `check ${rule} missing from trail`).toBeDefined();
  return c as NonNullable<typeof c>;
}

function violation(res: GuardResult, rule: GuardRuleId) {
  const v = res.violations.find((x) => x.rule === rule);
  expect(v, `violation ${rule} not reported`).toBeDefined();
  return v as NonNullable<typeof v>;
}

describe("checkGuard — golden paths", () => {
  it("executes a valid testnet repay (armed irrelevant on sepolia, dryRun=false)", () => {
    const res = checkGuard(baseInput());
    expect(res.decision).toBe("execute");
    expect(res.violations).toEqual([]);
    expect(res.checks).toHaveLength(10);
    expect(res.checks.every((c) => c.passed)).toBe(true);
    expect(res.reason).toBe("all 10 safety checks passed");
  });

  it("returns dry-run when everything passes but DRY_RUN holds fire", () => {
    const res = checkGuard(baseInput({ flags: { dryRun: true, armed: false } }));
    expect(res.decision).toBe("dry-run");
    expect(res.violations).toEqual([]);
    expect(res.checks).toHaveLength(10);
    expect(res.checks.every((c) => c.passed)).toBe(true);
    expect(check(res, "dry-run").detail).toContain("held fire");
  });
});

describe("action-none", () => {
  it("blocks a 'none' proposal (and its zero amount also fails amount-positive)", () => {
    const res = checkGuard(
      withProposal({ action: "none", amountUsd: 0, expectedHfAfter: 1.2 }),
    );
    expect(res.decision).toBe("blocked");
    expect(violation(res, "action-none").detail).toBe("planner proposed no action");
    // Both violations report — no short-circuit between rules.
    violation(res, "amount-positive");
  });
});

describe("critic-approval (strict equality — fail-closed)", () => {
  it("blocks on REJECT and carries the critic reason in the detail", () => {
    const res = checkGuard(
      baseInput({ verdict: { verdict: "REJECT", reason: "amount exceeds prudent size" } }),
    );
    expect(res.decision).toBe("blocked");
    expect(violation(res, "critic-approval").detail).toContain("amount exceeds prudent size");
  });

  it("blocks a lowercase 'approve' — anything but exactly APPROVE fails", () => {
    const res = checkGuard(
      baseInput({ verdict: { verdict: "approve" as never, reason: "case drift" } }),
    );
    expect(res.decision).toBe("blocked");
    violation(res, "critic-approval");
  });

  it("blocks when the verdict field is absent entirely", () => {
    const res = checkGuard(
      baseInput({ verdict: { reason: "shape drifted upstream" } as unknown as CriticVerdict }),
    );
    expect(res.decision).toBe("blocked");
    expect(violation(res, "critic-approval").detail).toContain("shape drifted upstream");
  });
});

describe("allowlist", () => {
  it("passes a correct repay⇒USDC pairing and reports verified=true", () => {
    const res = checkGuard(baseInput());
    const c = check(res, "allowlist");
    expect(c.passed).toBe(true);
    expect(c.detail).toContain("verified=true");
    expect(c.detail).toContain(ADDRESS_BOOK["base-sepolia"].usdc.address);
  });

  it("blocks a repay+WETH pairing mismatch", () => {
    const res = checkGuard(withProposal({ asset: "WETH" }));
    expect(res.decision).toBe("blocked");
    expect(violation(res, "allowlist").detail).toContain("pairing");
  });

  it("blocks any raw 0x address inside LLM output (defense in depth)", () => {
    const res = checkGuard(
      withProposal({
        rationale: "repay via pool 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 immediately",
      }),
    );
    expect(res.decision).toBe("blocked");
    expect(violation(res, "allowlist").detail).toContain("raw address");
  });
});

describe("amount-positive", () => {
  it("blocks a zero amount", () => {
    const res = checkGuard(withProposal({ amountUsd: 0 }));
    expect(res.decision).toBe("blocked");
    violation(res, "amount-positive");
  });
});

describe("max-tx-usd (integer cents)", () => {
  it("passes an amount exactly at the $15.00 cap", () => {
    const res = checkGuard(withProposal({ amountUsd: 15 }));
    expect(check(res, "max-tx-usd").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });

  it("blocks $15.01 — one cent over", () => {
    const res = checkGuard(withProposal({ amountUsd: 15.01 }));
    expect(res.decision).toBe("blocked");
    violation(res, "max-tx-usd");
  });

  it("PASSES 15.000000001 — the cents boundary kills sub-cent float games", () => {
    // usdToCents rounds exactly once: 15.000000001 → 1500 cents == the cap.
    // Comparing in integer cents means sub-cent float noise can neither sneak
    // over the cap nor spuriously block a legal amount; $15.000000001 IS $15.00.
    const res = checkGuard(withProposal({ amountUsd: 15.000000001 }));
    expect(check(res, "max-tx-usd").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });
});

describe("daily-cap (integer cents)", () => {
  it("passes when spent + amount lands exactly on the cap (1500 + 1500 = 3000)", () => {
    const res = checkGuard(withProposal({ amountUsd: 15 }, { spentTodayCents: 1500 }));
    expect(check(res, "daily-cap").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });

  it("blocks when spent + amount exceeds the cap (1600 + 1500 > 3000)", () => {
    const res = checkGuard(withProposal({ amountUsd: 15 }, { spentTodayCents: 1600 }));
    expect(res.decision).toBe("blocked");
    violation(res, "daily-cap");
  });
});

describe("min-hf-improvement", () => {
  it("passes exact equality: hf 1.20 + 0.05 → expected 1.25 (epsilon tolerance)", () => {
    // Without the 1e-9 epsilon, 1.2 + 0.05 = 1.2500000000000002 in floats would
    // spuriously block an exactly-sufficient improvement.
    const res = checkGuard(withProposal({ expectedHfAfter: 1.25 }));
    expect(check(res, "min-hf-improvement").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });

  it("blocks an improvement just under the floor (1.2499)", () => {
    const res = checkGuard(withProposal({ expectedHfAfter: 1.2499 }));
    expect(res.decision).toBe("blocked");
    violation(res, "min-hf-improvement");
  });

  it("blocks a proposal whose expected HF is below the current HF", () => {
    const res = checkGuard(withProposal({ expectedHfAfter: 1.1 }));
    expect(res.decision).toBe("blocked");
    violation(res, "min-hf-improvement");
  });
});

describe("idempotency", () => {
  it("blocks a decision that already executed", () => {
    const res = checkGuard(baseInput({ alreadyExecuted: true }));
    expect(res.decision).toBe("blocked");
    violation(res, "idempotency");
  });
});

describe("arm-flag", () => {
  it("blocks mainnet unarmed EVEN with dryRun=false", () => {
    const res = checkGuard(
      baseInput({
        chain: "base",
        addressBook: ADDRESS_BOOK.base,
        flags: { dryRun: false, armed: false },
      }),
    );
    expect(res.decision).toBe("blocked");
    violation(res, "arm-flag");
  });

  it("passes the arm rule on mainnet when explicitly armed", () => {
    const res = checkGuard(
      baseInput({
        chain: "base",
        addressBook: ADDRESS_BOOK.base,
        flags: { dryRun: false, armed: true },
      }),
    );
    expect(check(res, "arm-flag").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });

  it("passes the arm rule on testnet without arming", () => {
    const res = checkGuard(baseInput({ flags: { dryRun: false, armed: false } }));
    expect(check(res, "arm-flag").passed).toBe(true);
  });
});

describe("multi-violation — every rule is evaluated, nothing short-circuits", () => {
  it("reports REJECT + over-cap + alreadyExecuted all at once", () => {
    const res = checkGuard(
      withProposal(
        { amountUsd: 20 }, // 2000 cents > 1500-cent tx cap
        {
          verdict: { verdict: "REJECT", reason: "too risky" },
          alreadyExecuted: true,
        },
      ),
    );
    expect(res.decision).toBe("blocked");
    const rules = res.violations.map((v) => v.rule);
    expect(rules).toContain("critic-approval");
    expect(rules).toContain("max-tx-usd");
    expect(rules).toContain("idempotency");
    expect(res.violations).toHaveLength(3);
    // reason is the FIRST violation in rule order
    expect(res.reason).toContain("critic-approval");
    // full audit trail is still 10 entries
    expect(res.checks).toHaveLength(10);
  });
});
