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

## 2026-07-31 — two template-reference syntaxes in the same seeded workflow

**What:** The seeded "Aave Health Factor Monitor" workflow uses **two different**
reference syntaxes for the same value. The Condition node uses the fully-qualified
form `{{@step-1:Get Aave Health Factor.healthFactor}}`, while the Discord and
SendGrid nodes downstream use a short form `{{step-1.healthFactor}}`. The docs
describe only the `{{@nodeId:Label.field}}` form.
**Impact:** A builder copying the seeded workflow cannot tell which form is
canonical, whether the short form is a supported alias or a latent bug in the
seed, or whether the short form silently renders empty at runtime. Since the seed
ships disabled with blank integration IDs, nobody finds out until they wire it up.
**Proposed fix:** Make the seeds internally consistent (use the documented form
everywhere), and if the short form *is* a supported alias, document it.

## 2026-07-31 — seeded workflows ship with blank required fields and no validation hint

**What:** All three seeded workflows have empty required fields — `user: ""` on the
Aave read, `integrationId: ""` on the Discord node, `emailTo: ""` on the SendGrid
node — and are `enabled: false`. Nothing in the workflow object flags *which*
fields still need filling.
**Impact:** A new builder's first instinct is to hit Enable/Run; they get a runtime
failure rather than an upfront "3 fields required" prompt.
**Proposed fix:** Surface required-but-blank fields in the UI before enabling
(and ideally in `validate_workflow`'s output), so the seeds are a guided setup
rather than a puzzle. Good onboarding-bounty material.

## 2026-07-31 — our own bug: we asked an LLM to be a calculator

**What:** The first live run with a real model (Mimo v2.5 Pro over the Anthropic
protocol) exposed that *both* agents' arithmetic is unreliable. The Planner claimed
`expectedHfAfter: 6.41` when the true value was 5.01; on the next tick it claimed
1.97 against a true 4.08. The Critic was worse in the direction that matters — it
computed 1.50 for a proposal whose real outcome was 1.61 and **rejected a valid
rescue**. Separately, the Planner maxed out `MAX_TX_USD` ($15) when ~$5 would clear
the target, which would burn the daily cap 3× faster than necessary.

**Why it mattered less than it looks:** the Guard recomputes the health factor
itself, so no unsafe transaction was ever possible — every one of these was caught.
But a system whose Critic randomly vetoes good rescues is useless even when it is
safe: a missed defense can lose the position.

**Fix applied — deterministic code computes, the agents judge:**
1. Both prompts now receive a **VERIFIED FIGURES** block: the exact post-defense
   health factor and the smallest repayment that clears the target, computed by
   `src/agents/hf-math.ts`. Neither model is asked to divide.
2. The Critic is told explicitly it is *not* the calculator, and that the verified
   figures — not the Planner's claim — are authoritative. It keeps its veto, which
   is what the safety property actually requires.
3. `hf-claim-honesty` was recalibrated. At a 0.01 tolerance it blocked every real
   defense, because genuine models drift ~0.02–0.08. Since `min-hf-improvement`
   already gates on the Guard's own number, an inflated claim can never buy an
   unsafe execution — so honesty is a *signal*, not the safety gate. Allowance is
   now max(0.25 absolute, 10% relative), which still catches a grossly broken model.
4. Telegram alerts and the audit trail now report the **Guard's** recomputed health
   factor, never the model's self-reported one, so the human is never shown a number
   the system didn't actually gate on.

**Result:** the same scenario now sizes both defenses to the exact minimum ($4.79 in
the act band, $6.99 in panic — both landing on 1.6003) and the Critic approves both.

**Lesson:** an LLM's job in a financial control loop is judgement, not float
division. Any number the system gates on must come from code. This was already the
Guard's design; the mistake was asking the *agents* to reproduce the arithmetic and
then treating their answer as meaningful.

## 2026-07-31 — a Claude Code OAuth token is not an API key

**What:** Tried the `sk-ant-oat01-…` token from `claude setup-token` as
`ANTHROPIC_API_KEY`. It fails with `401 invalid x-api-key` — OAuth tokens go on
`Authorization: Bearer` with an `anthropic-beta: oauth-2025-04-20` header, not on
`x-api-key`. Sent correctly it authenticates (429 rather than 401), but it draws on
the interactive Claude Code subscription quota, which is the wrong bucket for a
daemon polling on a timer.
**Resolution:** added `ANTHROPIC_BASE_URL` so any Anthropic-protocol-compatible
endpoint can back the Planner/Critic with no code change, and pointed it at Mimo
v2.5 Pro. Swapping to a first-party `sk-ant-…` key later is three lines of `.env`.

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
