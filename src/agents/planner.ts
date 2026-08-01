/**
 * Planner: proposes ONE defensive action.
 *
 * Two implementations behind the same interface:
 *  - createLlmPlanner — the real brain (strict JSON, reject-and-retry).
 *  - createHeuristicPlanner — deterministic, used when no ANTHROPIC_API_KEY is
 *    present so `pnpm dev` demonstrates the full pipeline with zero secrets.
 *
 * Neither may emit an address: the executor resolves those from the config
 * allowlist, and the schema plus the Guard both reject any that appear.
 */

import type { LlmClient, Planner, PlannerContext, PlanResult } from "../types.js";
import { hfAfterRepay, repayNeededForTarget } from "./hf-math.js";
import { buildPlannerPrompt } from "./prompts.js";
import { completeWithSchema, PlannerProposalSchema } from "./schemas.js";

export function createLlmPlanner(llm: LlmClient): Planner {
  return {
    async plan(ctx: PlannerContext): Promise<PlanResult> {
      const { value, raw } = await completeWithSchema(
        llm,
        buildPlannerPrompt(ctx),
        PlannerProposalSchema,
      );
      return { proposal: value, raw };
    },
  };
}

export function createHeuristicPlanner(): Planner {
  return {
    async plan(ctx: PlannerContext): Promise<PlanResult> {
      const { snapshot, thresholds, caps } = ctx;

      // Already rounded up to whole cents by repayNeededForTarget — rounding
      // down would land just under the target and be refused by the Critic.
      const needed = repayNeededForTarget(snapshot, thresholds.targetHf);
      const affordable = Math.min(
        caps.maxTxUsd,
        snapshot.balances.usdcUsd * 0.9, // leave a buffer; never drain the wallet
        snapshot.totalDebtUsd,
      );
      const amountUsd = Math.min(needed, Math.max(affordable, 0));

      if (!(amountUsd > 0) || !Number.isFinite(amountUsd)) {
        return {
          proposal: {
            action: "none",
            asset: "USDC",
            amountUsd: 0,
            expectedHfAfter: snapshot.hf,
            rationale:
              needed <= 0
                ? "position already clears the target health factor"
                : "no affordable repayment available within caps and balances",
          },
          raw: null,
        };
      }

      // Round in whichever direction stays safe. When the requirement drives the
      // amount it is already ceiled to the cent and clears the target. When a cap
      // or the wallet balance drives it, round DOWN — rounding up there could
      // push the proposal past MAX_TX_USD or past what we actually hold.
      const rounded = amountUsd === needed ? needed : Math.floor(amountUsd * 100) / 100;
      return {
        proposal: {
          action: "repay",
          asset: "USDC",
          amountUsd: rounded,
          expectedHfAfter: hfAfterRepay(snapshot, rounded),
          rationale: `repay $${rounded.toFixed(2)} USDC to restore the health factor above ${thresholds.targetHf}`,
        },
        raw: null,
      };
    },
  };
}
