/**
 * The Guard — deterministic final authority over every defense.
 *
 * PURE and synchronous: all I/O-derived facts (spend, idempotency, flags, caps,
 * address book) are injected via GuardInput. The guard never touches db/env.
 *
 * Every rule is evaluated (no short-circuit); every failure lands in
 * violations[]; every evaluated rule lands in checks[] for the audit trail.
 * Money is compared in integer cents (usdToCents converts exactly once), so
 * sub-cent float games cannot slip under a cap. Fail-closed everywhere: a
 * malformed verdict, an unknown asset, a non-finite amount — all block.
 */

import { usdToCents } from "../config.js";
import type {
  AddressBook,
  Chain,
  CriticVerdict,
  GuardCheck,
  GuardResult,
  GuardViolation,
  KnownAddress,
  PlannerProposal,
  Snapshot,
} from "../types.js";

export interface GuardInput {
  proposal: PlannerProposal;
  verdict: CriticVerdict;
  snapshot: Snapshot;
  chain: Chain;
  flags: { dryRun: boolean; armed: boolean };
  capsCents: { maxTxCents: number; dailyCapCents: number };
  minHfImprovement: number;
  addressBook: AddressBook;
  /** Rolling-window spend in integer cents (injected from db). */
  spentTodayCents: number;
  /** True when the db already has an execution for this decision id. */
  alreadyExecuted: boolean;
}

/** Epsilon for the HF-improvement comparison so exact equality passes despite float noise. */
const HF_EPSILON = 1e-9;

/** Defense in depth: any raw EVM address inside LLM output is an instant block. */
const RAW_ADDRESS_RE = /0x[0-9a-fA-F]{40}/;

const ZERO_ADDRESS_RE = /^0x0{40}$/;
const VALID_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function checkGuard(input: GuardInput): GuardResult {
  const { proposal, verdict, snapshot, chain, flags, capsCents } = input;
  const checks: GuardCheck[] = [];
  const violations: GuardViolation[] = [];

  const record = (rule: GuardCheck["rule"], passed: boolean, detail: string): void => {
    checks.push({ rule, passed, detail });
    if (!passed) {
      violations.push({ rule, detail });
    }
  };

  // Exact money boundary: USD → integer cents exactly once. Non-finite amounts
  // become NaN, which fails every cap comparison below (fail-closed).
  const amountCents = Number.isFinite(proposal?.amountUsd)
    ? usdToCents(proposal.amountUsd)
    : Number.NaN;

  // 1. action-none — a "none" proposal is benign but never executable.
  if (proposal?.action === "none") {
    record("action-none", false, "planner proposed no action");
  } else {
    record("action-none", true, `planner proposed action "${String(proposal?.action)}"`);
  }

  // 2. critic-approval — strict equality; undefined/lowercase/anything else fails.
  const criticReason =
    typeof verdict?.reason === "string" && verdict.reason.length > 0
      ? verdict.reason
      : "(no reason provided)";
  if (verdict?.verdict === "APPROVE") {
    record("critic-approval", true, `critic APPROVE — ${criticReason}`);
  } else {
    record(
      "critic-approval",
      false,
      `critic verdict ${JSON.stringify(verdict?.verdict)} is not APPROVE — critic reason: ${criticReason}`,
    );
  }

  // 3. allowlist — asset must resolve through the config address book; the
  // pairing is re-checked; raw addresses anywhere in LLM output are fatal.
  {
    const problems: string[] = [];
    let entry: KnownAddress | undefined;
    let entryLabel = "";

    if (proposal?.asset === "USDC") {
      entry = input.addressBook?.usdc;
      entryLabel = "usdc";
    } else if (proposal?.asset === "WETH") {
      entry = input.addressBook?.weth;
      entryLabel = "weth";
    } else {
      problems.push(`asset ${JSON.stringify(proposal?.asset)} is not on the allowlist`);
    }

    if (entryLabel !== "" && entry === undefined) {
      problems.push(`address book has no "${entryLabel}" entry`);
    }
    if (entry !== undefined) {
      if (!VALID_ADDRESS_RE.test(entry.address) || ZERO_ADDRESS_RE.test(entry.address)) {
        problems.push(`allowlist entry for ${entryLabel} has invalid/zero address ${entry.address}`);
      }
    }

    // Action↔asset pairing (re-checked here; the schema upstream is not trusted).
    const action = proposal?.action;
    if (action === "repay" && proposal.asset !== "USDC") {
      problems.push(`pairing violation: repay requires USDC, got ${JSON.stringify(proposal.asset)}`);
    } else if (action === "supplyCollateral" && proposal.asset !== "WETH") {
      problems.push(
        `pairing violation: supplyCollateral requires WETH, got ${JSON.stringify(proposal.asset)}`,
      );
    } else if (action !== "repay" && action !== "supplyCollateral" && action !== "none") {
      problems.push(`unknown action ${JSON.stringify(action)}`);
    }
    // action "none" skips pairing but the asset was still resolved above.

    // Defense in depth: schema already rejects raw addresses, but the Guard
    // trusts nothing upstream — scan every string field of the proposal.
    for (const [field, value] of [
      ["asset", proposal?.asset],
      ["action", proposal?.action],
      ["rationale", proposal?.rationale],
    ] as const) {
      if (typeof value === "string" && RAW_ADDRESS_RE.test(value)) {
        problems.push(`raw address detected in proposal.${field} — addresses come ONLY from config`);
      }
    }

    const resolved =
      entry !== undefined
        ? `asset ${String(proposal?.asset)} → ${entry.address} (verified=${entry.verified})`
        : `asset ${JSON.stringify(proposal?.asset)} unresolved (verified=false)`;
    if (problems.length === 0) {
      record("allowlist", true, `${resolved}; pairing ok; no raw addresses in planner output`);
    } else {
      record("allowlist", false, `${resolved}; ${problems.join("; ")}`);
    }
  }

  // 4. amount-positive — evaluated even for action "none" (its amount 0 fails; fine).
  if (Number.isFinite(proposal?.amountUsd) && proposal.amountUsd > 0) {
    record("amount-positive", true, `amountUsd ${proposal.amountUsd} is finite and positive`);
  } else {
    record(
      "amount-positive",
      false,
      `amountUsd ${String(proposal?.amountUsd)} is not a positive finite number`,
    );
  }

  // 5. max-tx-usd — integer cents vs integer cents; NaN fails (fail-closed).
  if (amountCents <= capsCents.maxTxCents) {
    record(
      "max-tx-usd",
      true,
      `amount ${amountCents} cents <= per-tx cap ${capsCents.maxTxCents} cents`,
    );
  } else {
    record(
      "max-tx-usd",
      false,
      `amount ${amountCents} cents exceeds per-tx cap ${capsCents.maxTxCents} cents`,
    );
  }

  // 6. daily-cap — rolling spend + this tx must stay within the cap.
  const projectedCents = input.spentTodayCents + amountCents;
  if (projectedCents <= capsCents.dailyCapCents) {
    record(
      "daily-cap",
      true,
      `spent ${input.spentTodayCents} + amount ${amountCents} = ${projectedCents} cents <= daily cap ${capsCents.dailyCapCents} cents`,
    );
  } else {
    record(
      "daily-cap",
      false,
      `spent ${input.spentTodayCents} + amount ${amountCents} = ${projectedCents} cents exceeds daily cap ${capsCents.dailyCapCents} cents`,
    );
  }

  // 7. min-hf-improvement — epsilon tolerance so exact equality passes float noise.
  const requiredHf = snapshot.hf + input.minHfImprovement;
  if (proposal?.expectedHfAfter >= requiredHf - HF_EPSILON) {
    record(
      "min-hf-improvement",
      true,
      `expectedHfAfter ${proposal.expectedHfAfter} >= hf ${snapshot.hf} + minImprovement ${input.minHfImprovement}`,
    );
  } else {
    record(
      "min-hf-improvement",
      false,
      `expectedHfAfter ${String(proposal?.expectedHfAfter)} < hf ${snapshot.hf} + minImprovement ${input.minHfImprovement} (required ${requiredHf})`,
    );
  }

  // 8. idempotency — one decision, one defense, ever.
  if (input.alreadyExecuted) {
    record("idempotency", false, "decision already executed — refusing duplicate defense");
  } else {
    record("idempotency", true, "no prior execution recorded for this decision");
  }

  // 9. arm-flag — mainnet requires an explicit arm; testnet never does.
  if (chain === "base" && !flags.armed) {
    record("arm-flag", false, "mainnet (base) requires explicit arm (RIPCORD_ARM=1) — not armed");
  } else if (chain === "base") {
    record("arm-flag", true, "mainnet (base) explicitly armed");
  } else {
    record("arm-flag", true, `testnet ${chain} needs no arm`);
  }

  // 10. dry-run — evaluated LAST; only decides the outcome when all else passed.
  let dryRunDetail: string;
  if (violations.length > 0) {
    dryRunDetail = `DRY_RUN=${flags.dryRun}; moot — already blocked by ${violations.length} violation(s)`;
  } else if (flags.dryRun) {
    dryRunDetail = "DRY_RUN held fire — all checks passed, no transaction sent";
  } else {
    dryRunDetail = "DRY_RUN disabled — live execution authorized";
  }
  checks.push({ rule: "dry-run", passed: true, detail: dryRunDetail });

  const decision: GuardResult["decision"] =
    violations.length > 0 ? "blocked" : flags.dryRun ? "dry-run" : "execute";

  const first = violations[0];
  const reason =
    first !== undefined
      ? `blocked by ${first.rule}: ${first.detail}`
      : `all ${checks.length} safety checks passed`;

  return { decision, violations, checks, reason };
}
