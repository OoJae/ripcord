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

import type { LlmClient, PlanResult, Planner, PlannerContext } from "../types.js";
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

/** Round up to whole cents — rounding down could land just under the target HF. */
function ceilCents(usd: number): number {
  return Math.ceil(usd * 100) / 100;
}

export function createHeuristicPlanner(): Planner {
  return {
    async plan(ctx: PlannerContext): Promise<PlanResult> {
      const { snapshot, thresholds, caps } = ctx;

      const needed = ceilCents(repayNeededForTarget(snapshot, thresholds.targetHf));
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

      const rounded = ceilCents(amountUsd);
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
