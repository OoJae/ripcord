/**
 * Critic: an independent second agent that must APPROVE before anything executes.
 *
 * FAIL-CLOSED BY CONSTRUCTION: if the LLM Critic cannot produce a valid verdict
 * within its retry budget, it resolves to REJECT rather than throwing. A throw
 * could be caught somewhere upstream and mistaken for "no objection"; an
 * explicit REJECT cannot. There is no code path in which the absence of an
 * approval is treated as an approval.
 */

import type {
  Caps,
  Critic,
  CritiqueResult,
  LlmClient,
  OracleSanityResult,
  PlannerProposal,
  Snapshot,
  Thresholds,
} from "../types.js";
import { hfAfter } from "./hf-math.js";
import { buildCriticPrompt } from "./prompts.js";
import { CriticVerdictSchema, completeWithSchema, SchemaValidationError } from "./schemas.js";

export function createLlmCritic(llm: LlmClient): Critic {
  return {
    async critique(
      snapshot: Snapshot,
      proposal: PlannerProposal,
      thresholds: Thresholds,
      caps: Caps,
      extras?: { oracleSanity?: OracleSanityResult },
    ): Promise<CritiqueResult> {
      try {
        const { value, raw } = await completeWithSchema(
          llm,
          buildCriticPrompt(snapshot, proposal, thresholds, caps, extras),
          CriticVerdictSchema,
        );
        return { verdict: value, raw };
      } catch (err) {
        const attempts = err instanceof SchemaValidationError ? err.attempts : 0;
        const raw =
          err instanceof SchemaValidationError
            ? (err.rawOutputs[err.rawOutputs.length - 1] ?? null)
            : null;
        return {
          verdict: {
            verdict: "REJECT",
            reason: `critic output failed validation after ${attempts} attempts — rejecting fail-closed`,
          },
          raw,
        };
      }
    },
  };
}

/** Tolerance so a defense landing exactly on the target is not rejected by float noise. */
const HF_EPSILON = 1e-9;

export function createHeuristicCritic(): Critic {
  return {
    async critique(
      snapshot: Snapshot,
      proposal: PlannerProposal,
      thresholds: Thresholds,
      caps: Caps,
      extras?: { oracleSanity?: OracleSanityResult },
    ): Promise<CritiqueResult> {
      const reject = (reason: string): CritiqueResult => ({
        verdict: { verdict: "REJECT", reason },
        raw: null,
      });

      // Corrupted pricing corrupts every figure below — refuse before judging.
      if (extras?.oracleSanity?.status === "divergent") {
        return reject(`oracle anomaly: ${extras.oracleSanity.detail}`);
      }

      if (proposal.action === "none") return reject("planner proposed no action");
      if (proposal.action === "repay" && proposal.asset !== "USDC") {
        return reject("invalid pairing: repay requires USDC");
      }
      // The collateral asset is per-chain (WETH on Base, cbETH on Base Sepolia),
      // so the valid pairing comes from the snapshot, never a hardcoded symbol.
      // Must stay in step with the Guard's allowlist rule (guard.ts:152-155).
      const collateralSymbol = snapshot.balances.collateralSymbol;
      if (proposal.action === "supplyCollateral" && proposal.asset !== collateralSymbol) {
        return reject(`invalid pairing: supplyCollateral requires ${collateralSymbol}`);
      }
      if (!(proposal.amountUsd > 0) || !Number.isFinite(proposal.amountUsd)) {
        return reject(`amount ${proposal.amountUsd} is not a positive finite number`);
      }
      if (proposal.amountUsd > caps.maxTxUsd) {
        return reject(
          `amount $${proposal.amountUsd} exceeds the per-transaction cap $${caps.maxTxUsd}`,
        );
      }

      const balance =
        proposal.asset === "USDC" ? snapshot.balances.usdcUsd : snapshot.balances.collateralAmount;
      if (proposal.amountUsd > balance) {
        return reject(`amount $${proposal.amountUsd} exceeds the wallet balance ${balance}`);
      }

      // Recompute independently — the planner's expectedHfAfter is not trusted.
      const recomputed = hfAfter(snapshot, proposal);
      if (!(recomputed >= thresholds.targetHf - HF_EPSILON)) {
        return reject(
          `recomputed health factor ${recomputed.toFixed(4)} falls short of the target ${thresholds.targetHf}`,
        );
      }

      return {
        verdict: {
          verdict: "APPROVE",
          reason: `recomputed health factor ${Number.isFinite(recomputed) ? recomputed.toFixed(4) : "∞"} clears the target ${thresholds.targetHf}`,
        },
        raw: null,
      };
    },
  };
}
