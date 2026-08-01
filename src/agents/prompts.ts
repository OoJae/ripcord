/**
 * Prompt construction for the Planner and the Critic.
 *
 * Two rules govern every string here:
 *  1. No secrets. Prompts are built from snapshot/threshold/cap values only.
 *  2. No raw sentinels. A no-debt position renders as "no debt" — the raw
 *     type(uint256).max health factor must never reach a model.
 */

import type { Caps, PlannerContext, PlannerProposal, Snapshot, Thresholds } from "../types.js";
import { hfAfter, repayNeededForTarget } from "./hf-math.js";

export interface BuiltPrompt {
  system: string;
  user: string;
}

/** Format a computed HF for a prompt; "unbounded" once debt is fully cleared. */
function fmtHf(v: number): string {
  return Number.isFinite(v) ? v.toFixed(4) : "unbounded (debt fully cleared)";
}

/** Render HF for a model: finite value to 4dp, or the words "no debt". */
export function renderHf(snapshot: Pick<Snapshot, "hf" | "hasDebt">): string {
  if (!snapshot.hasDebt || !Number.isFinite(snapshot.hf)) return "no debt";
  return snapshot.hf.toFixed(4);
}

function renderPosition(s: Snapshot): string {
  return [
    `health factor: ${renderHf(s)}`,
    `collateral: $${s.totalCollateralUsd.toFixed(2)}`,
    `debt: $${s.totalDebtUsd.toFixed(2)}`,
    `liquidation threshold: ${(s.liquidationThresholdBps / 100).toFixed(2)}%`,
    `hf velocity: ${s.hfVelocityPerMin === null ? "unknown (warming up)" : `${s.hfVelocityPerMin.toFixed(4)}/min`}`,
    `wallet USDC: $${s.balances.usdcUsd.toFixed(2)}`,
    `wallet ${s.balances.collateralSymbol} (collateral): ${s.balances.collateralAmount}`,
  ].join("\n");
}

function renderCaps(caps: Caps, t: Thresholds): string {
  return [
    `MAX_TX_USD: $${caps.maxTxUsd.toFixed(2)} (hard per-transaction cap)`,
    `DAILY_CAP_USD: $${caps.dailyCapUsd.toFixed(2)} (hard rolling-24h cap)`,
    `MIN_HF_IMPROVEMENT: ${caps.minHfImprovement}`,
    `target health factor after the defense: ${t.targetHf}`,
  ].join("\n");
}

const PLANNER_SYSTEM = `You are the Planner for Ripcord, an autonomous liquidation-protection agent for an Aave V3 position.

Your job: given a position snapshot, propose ONE defensive action that restores the health factor to at least the target.

Allowed actions (nothing else exists):
- "repay" — repay borrowed USDC. asset MUST be "USDC".
- "supplyCollateral" — supply more of the chain's collateral asset. Its symbol is shown in the POSITION block as "wallet <SYMBOL> (collateral)"; use exactly that symbol.
- "none" — no defense is warranted or possible. amountUsd MUST be 0.

Hard constraints:
- amountUsd must not exceed MAX_TX_USD, and must not exceed the wallet balance of the asset you choose.
- The resulting health factor must reach the stated target.
- Propose the smallest amount that REACHES the target — which is exactly the verified figure below, no less. Do NOT max out MAX_TX_USD: that is a per-transaction ceiling, not a suggestion. Over-repaying spends the user's stablecoins and burns the daily budget, leaving less for the next defense. Under-repaying is worse: it spends money and still leaves the position undefended.
- Prefer "repay" when USDC is available: it reduces debt directly and is a single fast transaction.
- Never output a contract address, a token address, or any 0x-prefixed hex string. Addresses are resolved by the executor from a fixed allowlist; any address you emit voids the whole proposal.

You are NOT the calculator. The VERIFIED FIGURES block below gives you the smallest
repayment that clears the target, already computed deterministically from the raw
position and already rounded to whole cents in the safe direction.

Copy that number into amountUsd verbatim. Do not re-derive it, do not round it, do
not shave it down to a neater figure. It is already the smallest amount that works:
anything below it fails to reach the target and will be rejected, and the defense
will not happen. The ONLY reason to send a smaller number is that MAX_TX_USD or your
wallet balance makes the verified figure impossible — in that case send the largest
amount you can afford and say so in the rationale.

For reference, the underlying relationship (LT = liquidation threshold as a fraction):
- repay:            hfAfter = (collateral x LT) / (debt - amountUsd)
- supplyCollateral: hfAfter = ((collateral + amountUsd) x LT) / debt

Report expectedHfAfter as your honest estimate of the result. A deterministic guard
recomputes it independently before anything executes and rejects a proposal whose
claim is inflated, so an accurate modest number always beats an optimistic one.

Respond with ONLY a JSON object, no prose and no markdown fences:
{"action": "repay"|"supplyCollateral"|"none", "asset": "USDC"|"<collateral symbol>", "amountUsd": <number>, "expectedHfAfter": <number>, "rationale": "<one short sentence>"}`;

export function buildPlannerPrompt(ctx: PlannerContext): BuiltPrompt {
  const history =
    ctx.recentDecisions.length === 0
      ? "(none)"
      : ctx.recentDecisions
          .map(
            (d) =>
              `- ${new Date(d.createdAtMs).toISOString()} band=${d.band} status=${d.status}` +
              (d.action ? ` action=${d.action} $${d.amountUsd ?? 0}` : ""),
          )
          .join("\n");

  const user = [
    "POSITION",
    renderPosition(ctx.snapshot),
    "",
    "THRESHOLDS",
    `warn ${ctx.thresholds.warn} / act ${ctx.thresholds.act} / panic ${ctx.thresholds.panic}`,
    "",
    "CAPS",
    renderCaps(ctx.caps, ctx.thresholds),
    "",
    "VERIFIED FIGURES (deterministically computed — use these, do not re-derive)",
    `smallest repayment that clears the target: $${repayNeededForTarget(ctx.snapshot, ctx.thresholds.targetHf).toFixed(2)}`,
    "",
    "RECENT DECISIONS",
    history,
    "",
    "Propose the defense now.",
  ].join("\n");

  return { system: PLANNER_SYSTEM, user };
}

const CRITIC_SYSTEM = `You are the Critic for Ripcord, an autonomous liquidation-protection agent. A separate Planner agent has proposed a defensive action, and nothing executes without your approval.

You are NOT the calculator. A deterministic verifier has already recomputed the
outcome from the raw position — its VERIFIED FIGURES are given to you below and are
authoritative. Do not re-derive them, and do not defer to the Planner's own claim,
which is frequently wrong. Your job is judgement on top of trustworthy arithmetic.

APPROVE only if ALL of these hold:
1. VERIFIED hfAfter is at least the target health factor.
2. amountUsd is within MAX_TX_USD.
3. amountUsd is within the wallet balance of that asset.
4. The action/asset pairing is valid: repay uses USDC; supplyCollateral uses the chain's collateral asset shown in the POSITION block.
5. The action actually improves the position, and the size is sensible — not
   drastically more than needed to clear the target.

Otherwise REJECT, naming the specific figure that failed. When genuinely in doubt,
REJECT: a missed defense is recoverable, a wrong transaction is not. But do not
reject a proposal that satisfies every condition above — an unnecessary rejection
leaves a real position undefended.

Never output a contract address or any 0x-prefixed hex string.

Respond with ONLY a JSON object, no prose and no markdown fences:
{"verdict": "APPROVE"|"REJECT", "reason": "<one short sentence naming the deciding number>"}`;

export function buildCriticPrompt(
  snapshot: Snapshot,
  proposal: PlannerProposal,
  thresholds: Thresholds,
  caps: Caps,
): BuiltPrompt {
  const user = [
    "POSITION",
    renderPosition(snapshot),
    "",
    "CAPS",
    renderCaps(caps, thresholds),
    "",
    "PROPOSED DEFENSE",
    `action: ${proposal.action}`,
    `asset: ${proposal.asset}`,
    `amountUsd: $${proposal.amountUsd}`,
    `planner rationale: ${proposal.rationale}`,
    `planner's own claimed hfAfter: ${proposal.expectedHfAfter} (UNTRUSTED — for comparison only)`,
    "",
    "VERIFIED FIGURES (deterministically recomputed — authoritative)",
    `health factor now:            ${renderHf(snapshot)}`,
    `health factor after this defense: ${fmtHf(hfAfter(snapshot, proposal))}`,
    `target to clear:              ${thresholds.targetHf}`,
    `smallest repayment that would clear the target: $${repayNeededForTarget(snapshot, thresholds.targetHf).toFixed(2)}`,
    "",
    "Judge the proposal against the verified figures and return your verdict.",
  ].join("\n");

  return { system: CRITIC_SYSTEM, user };
}
