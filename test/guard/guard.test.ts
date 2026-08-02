import { describe, expect, it } from "vitest";
import { ADDRESS_BOOK } from "../../src/config.js";
import { checkGuard, type GuardInput } from "../../src/guard/guard.js";
import type { CriticVerdict, GuardResult, GuardRuleId, PlannerProposal } from "../../src/types.js";
import { makeSnapshot, TEST_ADDRESS } from "../helpers/fakes.js";

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
    monitoredAddress: TEST_ADDRESS,
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
    expect(res.checks).toHaveLength(13);
    expect(res.checks.every((c) => c.passed)).toBe(true);
    expect(res.reason).toBe("all 13 safety checks passed");
  });

  it("returns dry-run when everything passes but DRY_RUN holds fire", () => {
    const res = checkGuard(baseInput({ flags: { dryRun: true, armed: false } }));
    expect(res.decision).toBe("dry-run");
    expect(res.violations).toEqual([]);
    expect(res.checks).toHaveLength(13);
    expect(res.checks.every((c) => c.passed)).toBe(true);
    expect(check(res, "dry-run").detail).toContain("held fire");
  });
});

describe("action-none", () => {
  it("blocks a 'none' proposal (and its zero amount also fails amount-positive)", () => {
    const res = checkGuard(withProposal({ action: "none", amountUsd: 0, expectedHfAfter: 1.2 }));
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

  it("accepts the chain's own collateral symbol for supplyCollateral", () => {
    // Base Sepolia's collateral is cbETH (the WETH reserve is capped out), so
    // cbETH — not WETH — is the symbol the Guard must accept here.
    const res = checkGuard(
      withProposal({ action: "supplyCollateral", asset: "cbETH", amountUsd: 5 }),
    );
    expect(check(res, "allowlist").passed).toBe(true);
    expect(check(res, "allowlist").detail).toContain(
      ADDRESS_BOOK["base-sepolia"].collateral.address,
    );
  });

  it("blocks the OTHER chain's collateral symbol", () => {
    // WETH is mainnet's collateral; naming it on Base Sepolia is a pairing error.
    const res = checkGuard(
      withProposal({ action: "supplyCollateral", asset: "WETH", amountUsd: 5 }),
    );
    expect(res.decision).toBe("blocked");
    expect(violation(res, "allowlist").detail).toMatch(/requires cbETH/);
  });

  it("blocks a repay+collateral pairing mismatch", () => {
    const res = checkGuard(withProposal({ asset: "cbETH" }));
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

describe("min-hf-improvement (recomputed, never taken on trust)", () => {
  // Snapshot: $30 collateral @ LT 80% = $24 effective, $20 debt, HF 1.20.
  // Required after a defense: 1.20 + 0.05 = 1.25.
  // The Guard derives hfAfter from the AMOUNT, so these cases vary the amount —
  // varying only the planner's claimed expectedHfAfter proves nothing.

  it("passes an amount that genuinely reaches the floor", () => {
    // $24 / ($20 − $1) = 1.2632 ≥ 1.25
    const res = checkGuard(withProposal({ amountUsd: 1, expectedHfAfter: 1.2632 }));
    expect(check(res, "min-hf-improvement").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });

  it("blocks an amount that lands just under the floor", () => {
    // $24 / ($20 − $0.50) = 1.2308 < 1.25
    const res = checkGuard(withProposal({ amountUsd: 0.5, expectedHfAfter: 1.2308 }));
    expect(res.decision).toBe("blocked");
    violation(res, "min-hf-improvement");
  });

  it("blocks a repayment too small to move the position at all", () => {
    // $24 / ($20 − $0.01) = 1.2006 — barely above the current 1.20
    const res = checkGuard(withProposal({ amountUsd: 0.01, expectedHfAfter: 1.2006 }));
    expect(res.decision).toBe("blocked");
    violation(res, "min-hf-improvement");
  });

  it("IGNORES an inflated expectedHfAfter — a lying Planner cannot buy a pass", () => {
    // The Planner claims 9.99 on a $0.50 repayment whose real outcome is 1.2308.
    // Before the Guard recomputed, this claim alone would have satisfied the rule.
    const res = checkGuard(withProposal({ amountUsd: 0.5, expectedHfAfter: 9.99 }));
    expect(res.decision).toBe("blocked");
    violation(res, "min-hf-improvement");
    expect(check(res, "min-hf-improvement").detail).toContain("planner claimed 9.99");
  });
});

describe("hf-claim-honesty", () => {
  it("blocks a Planner that overstates its own outcome beyond tolerance", () => {
    // Real outcome of a $10 repayment is 2.4; claiming 5.0 is evidence of a
    // miscalculating or dishonest model, so it blocks even though the
    // recomputed value would comfortably clear min-hf-improvement.
    const res = checkGuard(withProposal({ amountUsd: 10, expectedHfAfter: 5.0 }));
    expect(res.decision).toBe("blocked");
    violation(res, "hf-claim-honesty");
    expect(check(res, "min-hf-improvement").passed).toBe(true); // the other rule is happy
  });

  it("tolerates a conservative (understated) claim", () => {
    const res = checkGuard(withProposal({ amountUsd: 10, expectedHfAfter: 1.45 }));
    expect(check(res, "hf-claim-honesty").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });
});

describe("snapshot-provenance", () => {
  it("blocks when the snapshot is for a different address than the one configured", () => {
    const res = checkGuard(
      baseInput({ monitoredAddress: "0x9999999999999999999999999999999999999999" }),
    );
    expect(res.decision).toBe("blocked");
    violation(res, "snapshot-provenance");
  });

  it("blocks when the snapshot came from a different chain (mock sensor on mainnet)", () => {
    // This is the exact shape of the critical bug the review caught: the mock
    // sensor reports base-sepolia while the daemon is configured for mainnet.
    const res = checkGuard(
      baseInput({
        chain: "base",
        addressBook: ADDRESS_BOOK.base,
        flags: { dryRun: false, armed: true },
      }),
    );
    expect(res.decision).toBe("blocked");
    violation(res, "snapshot-provenance");
  });

  it("blocks an unestablishable provenance when the executor is LIVE", () => {
    // No configured target + a real KeeperHub executor = a fabricated position
    // could trigger a real transaction. This is the critical hole, closed.
    const res = checkGuard(baseInput({ monitoredAddress: undefined, liveExecutor: true }));
    expect(res.decision).toBe("blocked");
    expect(violation(res, "snapshot-provenance").detail).toContain("live executor");
  });

  it("tolerates an unestablishable provenance while the executor is a MOCK", () => {
    // The zero-secret demo: no target configured, but nothing can leave the box.
    const res = checkGuard(baseInput({ monitoredAddress: undefined, liveExecutor: false }));
    expect(check(res, "snapshot-provenance").passed).toBe(true);
    expect(res.decision).toBe("execute");
  });

  it("passes when the snapshot matches the configured chain and address", () => {
    expect(check(checkGuard(baseInput()), "snapshot-provenance").passed).toBe(true);
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
        // The snapshot must come from the same chain, or snapshot-provenance blocks first.
        snapshot: makeSnapshot("1.20", {}, "base"),
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
    expect(res.checks).toHaveLength(13);
  });
});

describe("oracle-sanity", () => {
  it("BLOCKS when the oracles diverge — acting on corrupted pricing is the hazard", () => {
    const res = checkGuard(
      baseInput({
        oracleSanity: {
          status: "divergent",
          aaveCollateralUsd: 1.12,
          referenceEthUsd: 1874.63,
          ratio: 0.0006,
          detail: "ORACLE ANOMALY: Aave prices collateral at $1.12 vs Chainlink ETH $1874.63",
        },
      }),
    );
    expect(res.decision).toBe("blocked");
    expect(res.violations.map((v) => v.rule)).toContain("oracle-sanity");
    expect(res.reason).toMatch(/ORACLE ANOMALY/);
  });

  it("passes on agreement", () => {
    const res = checkGuard(
      baseInput({
        oracleSanity: {
          status: "ok",
          aaveCollateralUsd: 1870.56,
          referenceEthUsd: 1874.63,
          ratio: 0.9978,
          detail: "within band",
        },
      }),
    );
    expect(res.violations.map((v) => v.rule)).not.toContain("oracle-sanity");
  });

  it("passes when the reference is unavailable — the reference must never brick a rescue", () => {
    const res = checkGuard(
      baseInput({
        oracleSanity: { status: "unavailable", detail: "reference feed unusable" },
      }),
    );
    expect(res.violations.map((v) => v.rule)).not.toContain("oracle-sanity");
  });

  it("passes when unchecked (mock mode), with an explicit note in the trail", () => {
    const res = checkGuard(baseInput({}));
    const check = res.checks.find((c) => c.rule === "oracle-sanity");
    expect(check?.passed).toBe(true);
    expect(check?.detail).toMatch(/not checked/);
  });
});
