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

## 2026-07-31 — pnpm 11.1.2 script-runner crash + build-script approvals

**What:** `pnpm test` crashed in `runDepsStatusCheck` (recursive `pnpm install` spawn) because better-sqlite3/esbuild build scripts were unapproved; the `package.json` `pnpm.onlyBuiltDependencies` field was not honored — this pnpm reads `allowBuilds` from `pnpm-workspace.yaml`.
**Fix applied:** `pnpm-workspace.yaml` with `allowBuilds: {better-sqlite3: true, esbuild: true}` + `.npmrc` `verify-deps-before-run=false`. Noting here because any starter-template consumer will hit the same wall.
