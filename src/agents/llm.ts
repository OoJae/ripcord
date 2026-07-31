/**
 * Anthropic-backed LlmClient.
 *
 * Model notes (claude-sonnet-5): sampling parameters (temperature/top_p/top_k)
 * are rejected by the API, so behaviour is steered entirely by the prompt.
 * Thinking is explicitly disabled — these are short, schema-constrained JSON
 * calls where reasoning tokens buy nothing and cost latency on every tick.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "../types.js";

export function createAnthropicLlm(apiKey: string, model: string, baseURL?: string): LlmClient {
  // baseURL lets an Anthropic-protocol-compatible endpoint stand in for
  // api.anthropic.com; the request/response shape is identical either way.
  const client = new Anthropic(baseURL === undefined ? { apiKey } : { apiKey, baseURL });

  return {
    async complete(req): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 1024,
        thinking: { type: "disabled" },
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      });
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    },
  };
}
