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

import { hfAfter } from "../agents/hf-math.js";
import { usdToCents } from "../config.js";
import type {
  Address,
  AddressBook,
  Chain,
  CriticVerdict,
  GuardCheck,
  GuardResult,
  GuardViolation,
  KnownAddress,
  OracleSanityResult,
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
  /**
   * The address the operator configured for monitoring. When set, the snapshot
   * must match it — otherwise we would be defending a position we never read.
   */
  monitoredAddress?: Address;
  /**
   * True when a real KeeperHub executor is wired up. With no configured
   * monitored address the snapshot's provenance cannot be established at all,
   * which is only tolerable while the executor is a mock (the zero-secret demo).
   */
  liveExecutor?: boolean;
  /**
   * Oracle-sanity verdict (Aave oracle vs independent Chainlink reference).
   * undefined = not checked (mock mode); "divergent" is a hard block.
   */
  oracleSanity?: OracleSanityResult;
}

/** Epsilon for the HF-improvement comparison so exact equality passes despite float noise. */
const HF_EPSILON = 1e-9;

/**
 * How far the Planner's claimed hfAfter may exceed the Guard's recomputed value
 * before the claim is treated as evidence of a broken model.
 *
 * Deliberately generous. Safety does NOT rest on this rule — `min-hf-improvement`
 * already gates on the Guard's own recomputation, so an inflated claim cannot buy
 * an unsafe execution. This rule only catches a Planner that is grossly wrong.
 * Live testing showed real models drift by ~0.02–0.08 on this arithmetic; blocking
 * a valid rescue over that would trade a real liquidation risk for a cosmetic one.
 */
const HF_CLAIM_ABS_TOLERANCE = 0.25;
const HF_CLAIM_REL_TOLERANCE = 0.1; // 10% of the recomputed value

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

    const collateralSymbol = input.addressBook?.collateral?.symbol;
    if (proposal?.asset === "USDC") {
      entry = input.addressBook?.usdc;
      entryLabel = "usdc";
    } else if (proposal?.asset === collateralSymbol) {
      entry = input.addressBook?.collateral;
      entryLabel = "collateral";
    } else {
      problems.push(`asset ${JSON.stringify(proposal?.asset)} is not on the allowlist`);
    }

    if (entryLabel !== "" && entry === undefined) {
      problems.push(`address book has no "${entryLabel}" entry`);
    }
    if (entry !== undefined) {
      if (!VALID_ADDRESS_RE.test(entry.address) || ZERO_ADDRESS_RE.test(entry.address)) {
        problems.push(
          `allowlist entry for ${entryLabel} has invalid/zero address ${entry.address}`,
        );
      }
    }

    // Action↔asset pairing (re-checked here; the schema upstream is not trusted).
    const action = proposal?.action;
    if (action === "repay" && proposal.asset !== "USDC") {
      problems.push(
        `pairing violation: repay requires USDC, got ${JSON.stringify(proposal.asset)}`,
      );
    } else if (action === "supplyCollateral" && proposal.asset !== collateralSymbol) {
      problems.push(
        `pairing violation: supplyCollateral on ${chain} requires ${String(collateralSymbol)}, got ${JSON.stringify(proposal.asset)}`,
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
        problems.push(
          `raw address detected in proposal.${field} — addresses come ONLY from config`,
        );
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

  // 7. min-hf-improvement — gated on the Guard's OWN recomputation, never on the
  // Planner's claimed expectedHfAfter. A model that miscalculates or inflates its
  // claim must not be able to talk its way past the last deterministic check.
  // (NaN from a malformed proposal fails the comparison → fail-closed.)
  const recomputedHfAfter = hfAfter(snapshot, proposal);
  const requiredHf = snapshot.hf + input.minHfImprovement;
  if (recomputedHfAfter >= requiredHf - HF_EPSILON) {
    record(
      "min-hf-improvement",
      true,
      `recomputed hfAfter ${recomputedHfAfter} >= hf ${snapshot.hf} + minImprovement ${input.minHfImprovement}`,
    );
  } else {
    record(
      "min-hf-improvement",
      false,
      `recomputed hfAfter ${String(recomputedHfAfter)} < hf ${snapshot.hf} + minImprovement ${input.minHfImprovement} (required ${requiredHf}); planner claimed ${String(proposal?.expectedHfAfter)}`,
    );
  }

  // 7b. hf-claim-honesty — the Planner overstating its own outcome is evidence of
  // a miscalculating or dishonest model, so it blocks even when 7 would pass.
  const claimed = proposal?.expectedHfAfter;
  const claimAllowance = Math.max(
    HF_CLAIM_ABS_TOLERANCE,
    Math.abs(recomputedHfAfter) * HF_CLAIM_REL_TOLERANCE,
  );
  const claimOverstates =
    Number.isFinite(claimed) &&
    Number.isFinite(recomputedHfAfter) &&
    claimed > recomputedHfAfter + claimAllowance;
  record(
    "hf-claim-honesty",
    !claimOverstates,
    claimOverstates
      ? `planner claimed hfAfter ${claimed} but the recomputed value is ${recomputedHfAfter} — overstated beyond the ${claimAllowance.toFixed(3)} allowance`
      : `planner claim ${String(claimed)} is within the ${claimAllowance.toFixed(3)} allowance of the recomputed ${recomputedHfAfter}`,
  );

  // 8. snapshot-provenance — the position we are about to defend must be the
  // position we actually read. Catches a mock/synthetic snapshot reaching a
  // live executor, a stale snapshot from the other chain, and any drift between
  // the configured monitored address and the one the sensor reported.
  {
    const problems: string[] = [];
    if (input.monitoredAddress === undefined) {
      // No configured target. Tolerable only while the executor is a mock — the
      // zero-secret demo runs here. With a live executor this is exactly the
      // "fabricated position triggers a real transaction" hole.
      if (input.liveExecutor === true) {
        problems.push(
          "no MONITORED_ADDRESS configured but a live executor is wired — snapshot provenance cannot be established",
        );
      }
    } else if (snapshot.address?.toLowerCase() !== input.monitoredAddress.toLowerCase()) {
      problems.push(
        `snapshot address ${String(snapshot.address)} does not match the monitored address ${input.monitoredAddress}`,
      );
    }
    if (snapshot.chain !== chain) {
      problems.push(
        `snapshot chain ${String(snapshot.chain)} does not match the active chain ${chain}`,
      );
    }
    record(
      "snapshot-provenance",
      problems.length === 0,
      problems.length === 0
        ? input.monitoredAddress === undefined
          ? `snapshot is from ${chain}:${String(snapshot.address)} (no configured target; executor is a mock)`
          : `snapshot is from ${chain}:${String(snapshot.address)}, matching the configured target`
        : problems.join("; "),
    );
  }

  // 8b. oracle-sanity — refuse to act on corrupted pricing. The 2026 headline
  // liquidations were single-block oracle mispricings; a defense sized from a
  // corrupted price can be the disaster rather than the rescue. "unavailable"
  // passes (the reference feed must never brick a rescue); "divergent" blocks.
  const sanity = input.oracleSanity;
  if (sanity === undefined) {
    record(
      "oracle-sanity",
      true,
      "not checked (no live reads in this mode) — Aave oracle taken as-is",
    );
  } else if (sanity.status === "divergent") {
    record("oracle-sanity", false, sanity.detail);
  } else {
    record("oracle-sanity", true, sanity.detail);
  }

  // 9. idempotency — one decision, one defense, ever.
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
