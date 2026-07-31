/**
 * Strict output schemas for the LLM agents + the reject-and-retry loop.
 *
 * The schemas are STRICT (unknown keys are rejected, never stripped): a
 * hallucinated `toAddress` field is evidence of a bad generation, not noise to
 * silently discard. On top of the schema, assertNoAddresses() rejects any raw
 * EVM address anywhere in the output — including inside prose — because
 * addresses come ONLY from the config allowlist.
 */

import { z } from "zod";
import type { LlmClient } from "../types.js";

/** Sanity ceiling at the agent layer; the Guard's MAX_TX_USD is still the authority. */
const AMOUNT_SANITY_MAX = 1000;

export const PlannerProposalSchema = z
  .strictObject({
    action: z.enum(["repay", "supplyCollateral", "none"]),
    asset: z.enum(["USDC", "WETH"]),
    amountUsd: z.number().finite().nonnegative().max(AMOUNT_SANITY_MAX),
    expectedHfAfter: z.number().finite().positive().max(1000),
    rationale: z.string().min(1).max(500),
  })
  .superRefine((p, ctx) => {
    if (p.action === "repay" && p.asset !== "USDC") {
      ctx.addIssue({ code: "custom", message: "action 'repay' requires asset 'USDC'" });
    }
    if (p.action === "supplyCollateral" && p.asset !== "WETH") {
      ctx.addIssue({
        code: "custom",
        message: "action 'supplyCollateral' requires asset 'WETH'",
      });
    }
    if (p.action === "none" && p.amountUsd !== 0) {
      ctx.addIssue({ code: "custom", message: "action 'none' requires amountUsd 0" });
    }
    if (p.action !== "none" && !(p.amountUsd > 0)) {
      ctx.addIssue({ code: "custom", message: "a real action requires amountUsd > 0" });
    }
  });

export const CriticVerdictSchema = z.strictObject({
  verdict: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().min(1).max(500),
});

const RAW_ADDRESS_RE = /0x[0-9a-fA-F]{40}/;

/**
 * Reject any raw EVM address in model output. Addresses NEVER come from an LLM —
 * they are resolved from src/config.ts allowlists — so one appearing even inside
 * a rationale means the model is trying to steer execution and the output is void.
 */
export function assertNoAddresses(value: unknown, path = "output"): void {
  if (typeof value === "string") {
    if (RAW_ADDRESS_RE.test(value)) {
      throw new Error(`raw EVM address found in ${path} — addresses come only from config`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertNoAddresses(v, `${path}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoAddresses(v, `${path}.${k}`);
  }
}

export class SchemaValidationError extends Error {
  constructor(
    readonly attempts: number,
    readonly rawOutputs: string[],
    readonly lastIssue: string,
  ) {
    super(`LLM output failed validation after ${attempts} attempt(s): ${lastIssue}`);
    this.name = "SchemaValidationError";
  }
}

/** Strip a ```json … ``` fence if present. This is the ONLY leniency in the pipeline. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

export interface CompleteWithSchemaResult<T> {
  value: T;
  raw: string;
  attempts: number;
}

/**
 * Ask the model for JSON, validate strictly, and retry with the validation
 * failure fed back into the prompt. Throws SchemaValidationError once attempts
 * are exhausted — callers decide the fail-safe posture (the Planner aborts the
 * tick; the Critic resolves to REJECT).
 */
export async function completeWithSchema<T>(
  llm: LlmClient,
  prompt: { system: string; user: string },
  schema: z.ZodType<T>,
  opts: { maxAttempts?: number } = {},
): Promise<CompleteWithSchemaResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const rawOutputs: string[] = [];
  let user = prompt.user;
  let lastIssue = "no attempts made";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await llm.complete({ system: prompt.system, user });
    rawOutputs.push(raw);
    try {
      const parsed = schema.parse(JSON.parse(stripCodeFences(raw)));
      assertNoAddresses(parsed);
      return { value: parsed, raw, attempts: attempt };
    } catch (err) {
      lastIssue =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
          : String(err instanceof Error ? err.message : err);
      user =
        `${prompt.user}\n\nYour previous output failed validation: ${lastIssue}. ` +
        "Respond with only a corrected JSON object — no prose, no markdown, no addresses.";
    }
  }

  throw new SchemaValidationError(maxAttempts, rawOutputs, lastIssue);
}
