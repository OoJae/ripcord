/**
 * Prompt construction for the Planner and the Critic.
 *
 * Two rules govern every string here:
 *  1. No secrets. Prompts are built from snapshot/threshold/cap values only.
 *  2. No raw sentinels. A no-debt position renders as "no debt" — the raw
 *     type(uint256).max health factor must never reach a model.
 */

import type { Caps, PlannerContext, PlannerProposal, Snapshot, Thresholds } from "../types.js";

export interface BuiltPrompt {
  system: string;
  user: string;
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
    `wallet WETH: ${s.balances.wethEth} ETH`,
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
- "supplyCollateral" — supply more WETH as collateral. asset MUST be "WETH".
- "none" — no defense is warranted or possible. amountUsd MUST be 0.

Hard constraints:
- amountUsd must not exceed MAX_TX_USD, and must not exceed the wallet balance of the asset you choose.
- The resulting health factor must reach the stated target.
- Prefer "repay" when USDC is available: it reduces debt directly and is a single fast transaction.
- Never output a contract address, a token address, or any 0x-prefixed hex string. Addresses are resolved by the executor from a fixed allowlist; any address you emit voids the whole proposal.

Formulas (LT = liquidation threshold as a fraction):
- repay:            hfAfter = (collateral x LT) / (debt - amountUsd)
- supplyCollateral: hfAfter = ((collateral + amountUsd) x LT) / debt

Respond with ONLY a JSON object, no prose and no markdown fences:
{"action": "repay"|"supplyCollateral"|"none", "asset": "USDC"|"WETH", "amountUsd": <number>, "expectedHfAfter": <number>, "rationale": "<one short sentence>"}`;

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
    "RECENT DECISIONS",
    history,
    "",
    "Propose the defense now.",
  ].join("\n");

  return { system: PLANNER_SYSTEM, user };
}

const CRITIC_SYSTEM = `You are the Critic for Ripcord, an autonomous liquidation-protection agent. A separate Planner agent has proposed a defensive action. You are an INDEPENDENT verifier: do not assume the Planner is correct, and do not trust its stated expectedHfAfter — recompute it yourself.

Recompute the post-defense health factor (LT = liquidation threshold as a fraction):
- repay:            hfAfter = (collateral x LT) / (debt - amountUsd)
- supplyCollateral: hfAfter = ((collateral + amountUsd) x LT) / debt

APPROVE only if ALL of these hold:
1. Your recomputed hfAfter is at least the target health factor.
2. amountUsd is within MAX_TX_USD.
3. amountUsd is within the wallet balance of that asset.
4. The action/asset pairing is valid (repay↔USDC, supplyCollateral↔WETH).
5. The action actually improves the position.

Otherwise REJECT. When in doubt, REJECT: a missed defense is recoverable, a wrong transaction is not.

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
    `amountUsd: ${proposal.amountUsd}`,
    `planner claims expectedHfAfter: ${proposal.expectedHfAfter}`,
    `planner rationale: ${proposal.rationale}`,
    "",
    "Verify independently and return your verdict.",
  ].join("\n");

  return { system: CRITIC_SYSTEM, user };
}
