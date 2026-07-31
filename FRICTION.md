# FRICTION.md — onboarding friction log (bounty fuel)

Dated entries of everything that confused us or broke while building on KeeperHub / Aave / tooling, each with a proposed fix.

---

## 2026-07-31 — KeeperHub webhook trigger payload/response shape is undocumented

**What:** The docs confirm Webhook is a trigger type with an auto-generated URL and optional auth headers (`/keepers/overview`, `/keepers/configuration`), and `POST /api/workflows/{workflowId}/webhook` appears on the API page — but nowhere is the accepted POST body schema or the response shape (does it return an execution id?) documented. `/keepers/webhook`, `/keepers/triggers/webhook`, `/workflows/webhook` all 404.
**Impact:** Our `HttpKeeperHubClient.triggerDefense()` parses the response permissively (`executionId | runId | id`) and carries `// VERIFY:` markers; we cannot pre-validate the WF-2 payload contract offline.
**Proposed fix:** Add a "Webhook trigger" docs page with: URL pattern, auth expectations, accepted body, response schema (ideally `{executionId}` to chain into `/executions/{id}/wait`).

## 2026-07-31 — `app.keeperhub.com/api/openapi` is not the REST API spec

**What:** The machine-readable OpenAPI at `/api/openapi` contains only 83 marketplace endpoints of the form `POST /api/mcp/workflows/{slug}/call` — none of the documented REST CRUD/execution endpoints.
**Impact:** Codegen from the spec would produce the wrong client entirely.
**Proposed fix:** Publish the REST API (workflows, executions, `/wait`) in the OpenAPI document, or label the current one "marketplace call catalog".

## 2026-07-31 — Private routing has no documentation page

**What:** Private routing is referenced only negatively ("transactions routed through a private mempool are not sponsored" on the Gas page). `/wallet-management/private-routing` and friends 404. Which chains support it and how to enable it per workflow/tx is unknown.
**Impact:** Our mainnet defense plan (Session 3) depends on private routing; we cannot verify availability on Base offline.
**Proposed fix:** Docs page covering supported chains, how to enable per workflow, and the sponsorship mutual-exclusivity in one place. (Will also ask in builder Discord.)

## 2026-07-31 — Stale Para references (`llms.txt` + Agentic Wallets page)

**What:** Para wallet integration is discontinued (the Wallet Management index labels it "(Discontinued)"; the Gas page names Turnkey only), but `llms.txt` still describes Wallet Management as "Para MPC wallets, gas, address book" and the Agentic Wallets page as "Para MPC wallet model".
**Impact:** LLM-assisted builders consuming `llms.txt` get steered to a dead integration.
**Proposed fix:** Update `llms.txt` and the agentic-wallet page to Turnkey. (Docs-PR candidate for the onboarding bounty.)

## 2026-07-31 — KeeperHub MCP server not connected in this build session

**What:** The master-prompt Session 1 assumed the KeeperHub MCP server was already connected to Claude Code; it wasn't (pre-flight `claude mcp add` + OAuth not run).
**Impact:** MCP tool introspection was substituted with live-docs verification (see the KeeperHub verification report in this file / README). Tool names confirmed from `docs.keeperhub.com/ai-tools/mcp-server`: `execute_transfer`, `execute_contract_call`, `execute_check_and_execute`, `execute_protocol_action`, `create_workflow`, `execute_workflow`, `get_execution`, `deploy_template`, `search_protocol_actions`, `ai_generate_workflow`, marketplace `list_workflow`/`unlist_workflow`/`call_workflow`/`search_workflows`, and more. Gotcha discovered: `list_workflows` (read workflows, plural) and `list_workflow` (marketplace listing verb, singular) are different tools.
**Proposed fix (us):** Connect MCP before Session 2 (`claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp`, then `/mcp` to authenticate) and re-introspect schemas. **Proposed fix (KeeperHub):** none — this one's on us.

## 2026-07-31 — Model deviation from the locked stack (approved)

**What:** The locked stack specified `claude-sonnet-4-6` for Planner/Critic. Live model catalog check showed it is now a legacy snapshot; `claude-sonnet-5` is the current Sonnet at the same list price with intro pricing ($2/$10 per MTok) through Aug 31.
**Decision:** User approved switching to `claude-sonnet-5` (single constant in `src/config.ts`).

## 2026-07-31 — our own bug: graceful degradation became a safety hole

**What:** Ripcord degrades each missing capability to a mock so `pnpm dev` works with zero
secrets. An adversarial review found the capabilities were evaluated *independently*: with
`MONITORED_ADDRESS` blank (as `.env.example` ships it) but `KEEPERHUB_DEFEND_WEBHOOK_URL` set,
`CHAIN=base`, `DRY_RUN=false`, `RIPCORD_ARM=1`, the daemon paired the **mock sensor** with the
**live mainnet executor**. The scripted mock HF descent hit the act band ~35s after boot and
fired real defenses against a fabricated position at the burn address, repeating until the
$30 daily cap was exhausted. Reproduced end to end before fixing.
**Fix applied (two independent layers):** `loadConfig` now refuses to start when a live executor
is paired with mock reads outside DRY_RUN; and the Guard gained a `snapshot-provenance` rule
requiring the snapshot's chain and address to match the configured target (tolerating an
unconfigured target only while the executor is a mock).
**Lesson worth writing down:** "fall back to a mock" is a safe default for *reads* and a
dangerous one for *writes*. Capability flags that degrade independently need a cross-check.

## 2026-07-31 — our own bug: the Guard trusted the LLM's arithmetic

**What:** The Guard's `min-hf-improvement` rule compared the Planner's **self-reported**
`expectedHfAfter` against the threshold. A model that miscalculated — or simply asserted
`"expectedHfAfter": 9.99` on a $0.50 repayment — passed the last deterministic gate.
**Fix applied:** the Guard now recomputes the post-defense health factor itself from the
snapshot and the amount, and a second rule (`hf-claim-honesty`) blocks a Planner whose claim
overstates the recomputed value, since that is evidence of a miscalculating or dishonest model.
**Lesson:** a deterministic gate that validates a number the untrusted party supplied is not a
gate. Recompute, don't verify.

## 2026-07-31 — `biome check` output was being swallowed by a shell wrapper

**What:** `pnpm lint` reported "Lint: No issues found" while `./node_modules/.bin/biome check .`
reported 30 formatter errors. A local shell wrapper was summarising only the lint category and
hiding the formatter diagnostics — a false green that would have turned red in CI.
**Lesson:** verify tooling output against the raw binary at least once per project; a wrapper
that summarises can silently invert a pass/fail signal.

## 2026-07-31 — pnpm 11.1.2 script-runner crash + build-script approvals

**What:** `pnpm test` crashed in `runDepsStatusCheck` (recursive `pnpm install` spawn) because better-sqlite3/esbuild build scripts were unapproved; the `package.json` `pnpm.onlyBuiltDependencies` field was not honored — this pnpm reads `allowBuilds` from `pnpm-workspace.yaml`.
**Fix applied:** `pnpm-workspace.yaml` with `allowBuilds: {better-sqlite3: true, esbuild: true}` + `.npmrc` `verify-deps-before-run=false`. Noting here because any starter-template consumer will hit the same wall.
