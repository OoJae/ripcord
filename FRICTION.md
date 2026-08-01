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

## 2026-08-01 — the Aave Base Sepolia WETH reserve is capped out (blocks the documented setup)

**What:** Build guide §6 assumes a WETH-collateral / USDC-debt position on Base
Sepolia. `Pool.supply(WETH, …)` reverts with `SupplyCapExceeded()` (`0xf58f733a`)
for **any** amount — 0.02 WETH and 0.0001 WETH alike. The reserve shows 997.21 of a
1000 WETH cap, so the ~2.79 apparent headroom is misleading: Aave's cap check
includes `accruedToTreasury` and the scaled supply at the current liquidity index,
and on this market that leaves no room at all. WBTC is in the same state (100/100).

**Why it is worth logging:** a newcomer following any "supply WETH on a testnet"
tutorial hits a bare custom-error selector with no decoded reason. Nothing in the
Aave UI or the address book signals that the flagship testnet reserve is unusable,
and the error surfaces only at transaction time.

**Fix applied (ours):** the collateral asset is now **per-chain** — WETH on Base
mainnet, **cbETH on Base Sepolia** (no supply cap, LT 84.5%, faucet-mintable). The
debt asset stays USDC, so `repay USDC` — Ripcord's primary defense — is untouched.
`AddressBook.collateral` carries the symbol and decimals, the sensor reads whichever
token the chain declares, and the Guard's `supplyCollateral` pairing rule checks
against that chain's symbol (with tests for both accepting cbETH on Sepolia and
rejecting mainnet's WETH there). This kept us off the Anvil-fork fallback in §6.9,
so KeeperHub still executes every transaction — criterion #1 intact.

**Proposed fix (Aave/KeeperHub):** surface reserve caps and remaining headroom in
the faucet/testnet UI, and decode Aave custom errors in KeeperHub's execution error
string — `execution reverted (unknown custom error) data="0xf58f733a"` cost real
debugging time that `SupplyCapExceeded()` would not have.

## 2026-08-01 — getting Aave test tokens on Base Sepolia is undocumented but trivial

**What:** No docs page explains how to obtain the Aave Base Sepolia test assets. The
answer, found by reading the token's `owner()`: a permissionless Aave **Faucet** at
`0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc` with `isPermissioned() == false`, so
anyone can call `mint(token, to, amount)` for any listed reserve. It is recorded as
`BASE_SEPOLIA_FAUCET` in `src/config.ts`.

**Proposed fix:** name the faucet address in the Aave testnet docs, or link it from
the market page. Also note the market's USDC is the faucet token
`0xba50Cd…4D5f`, **not** Circle's `0x036CbD…` — a trap that silently yields
zero-balance reads.

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

## 2026-08-01 — Aave V3 protocol actions silently exclude Base Sepolia

**What:** Every `aave-v3/*` action rejects chain 84532 at save time:
`{"code":"INVALID_FIELD_TYPE","field":"network","expected":"1 | 10 | 8453 | 42161 | 11155111","received":"84532"}`.
Nothing in `search_protocol_actions`, `list_action_schemas`, or the action docs states a
supported-chain list — the `network` field is described only as "chain ID string", and
`get_plugin("triggers").chains` separately advertises Base Sepolia as `status: "stable"`.
So the platform tells you the chain is stable and the action takes a chain id, and you only
discover the intersection is empty by trying to save a workflow.

**Impact:** The obvious way to build an Aave keeper on a testnet — the purpose-built
`aave-v3/repay` and `aave-v3/get-user-account-data` nodes — is unavailable exactly where
you would rehearse it. We rebuilt both workflows on `web3/read-contract` and
`web3/write-contract` with the Pool address pinned from our own allowlist. That turned out
better for us (explicit addresses, `usePrivateMempool` is only available on
`web3/write-contract` anyway), but it was an hour of rework driven by a discoverable fact.

**Proposed fix:** Publish `supportedChains` per protocol action in `list_action_schemas`
and in `search_protocol_actions` output, and grey out unsupported chains in the builder.
Failing that, make the error name the action's supported set *and* suggest the
`web3/*` fallback.

## 2026-08-01 — the webhook trigger's `{"input": …}` envelope fails open, not closed

**What:** `POST /api/workflows/{id}/execute` accepts a bare JSON body with `200 OK` and a
real `executionId`, but the fields never reach the trigger node. `execution.input` is `{}`
and the first templated action dies with `Unresolved template reference(s)`. The payload is
only delivered when wrapped as `{"input": {...}}`. `{"triggerData": …}` and `{"data": …}`
fail the same silent way.

**Impact:** The failure looks like a workflow-definition bug, not a request-shape bug — we
spent a probe cycle rewriting template references before realising the body was being
dropped. An agent that trusts the 200 would record the defense as triggered and never
notice nothing ran.

**Proposed fix:** Reject a body with no recognised envelope with `400`, naming the expected
shape. Or accept a bare body as the input. Either is fine; returning `200` for a request
whose payload was discarded is the problem.

## 2026-08-01 — `kh_` org keys cannot call the webhook endpoint, and the docs do not say so

**What:** `POST /api/workflows/{id}/webhook` requires a **user webhook key** (`wfb_*`);
the org API key (`kh_*`) returns 401 `wrong_key_type`. The API docs page names the webhook
endpoint without mentioning that a second, differently-provisioned key class is required,
and there is no MCP tool to mint one — it is a web-UI-only step.

**Credit where due:** the 401 body is genuinely excellent — it names the expected prefix,
explains what the presented key *is* for, and gives the exact UI path to generate the right
one. More errors should look like this.

**Impact:** Automated setup stalls at a manual step. We used `/api/workflows/{id}/execute`
with the org key instead, which is documented and works.

**Proposed fix:** Note the `wfb_*` requirement on the webhook docs page, and expose webhook
key creation over the API/MCP so a workflow can be provisioned end-to-end headlessly.

## 2026-08-01 — `telegram/send-message` claims `requiresCredentials: false` but needs an integration

**What:** The action schema reports `requiresCredentials: false` for
`telegram/send-message` (identical to `discord/send-message` and `slack/send-message`), and
the node exposes no token field. At runtime it fails with *"Telegram bot token is required.
Please configure it in the integration settings."*

**Second-order impact, and the reason this matters:** a failing notify node marks the
**entire execution** `error`. Wire notification into a workflow that also writes on-chain
and a landed transaction gets reported as a failed run — the caller's status polling then
records a successful defense as a failure. We removed the notify node from WF-2 entirely and
let the daemon own notification.

**Proposed fix:** Make `requiresCredentials` accurate for the messaging actions, and
surface missing-integration as a validation error at save time rather than a runtime one.
Separately: consider letting a workflow mark a node non-fatal, so notification failures
cannot misreport the outcome of a write.

## 2026-08-01 — `code/run-code` is a paid-plan feature, discovered at save time

**What:** `code/run-code` appears in `list_action_schemas` with full field documentation and
no plan annotation, and it is used by public templates the search surface returns. Saving a
workflow that contains it fails with `402 upgrade_required`,
`featureId: "action.code"`, `requiredPlan: "pro"`.

**Impact:** We had designed WF-2's health-factor gate around a `run-code` node to normalise
the raw 1e18 health factor before comparing. Rebuilt it as a direct wad comparison in a
`Condition` — which is simpler and turned out fine — but the design was chosen from a
catalogue that did not disclose the gate.

**Proposed fix:** Include a `requiredPlan` field in `list_action_schemas` output and flag
plan-gated actions in template listings.

## 2026-08-01 — our own bug: the verified figure was rounded the wrong way

**What:** `repayNeededForTarget` returned the mathematically exact repayment ($4.2295) and
`prompts.ts` rendered it into the VERIFIED FIGURES block with `.toFixed(2)`. The Planner
proposed the rounded number, the deterministic recompute landed at HF **1.5999**, and the
Critic correctly REJECTed it for missing the 1.60 target. Every tick would have done the
same: a permanently stalled agent, failing safe but never defending.

**Why it is interesting:** this is the second time our own arithmetic — not the model — was
the defect, and the second time an independent checker caught it. The layered design worked;
the bug was in the layer we trusted most.

**Fix:** ceil to whole cents in the shared arithmetic. Provably sufficient: with
E = effective collateral, D = debt, T = target, the requirement is `r >= D - E/T`, so any
`r` above it yields `E/(D-r) >= T`. Also guarded against binary-float error, because
`Math.ceil(x*100)/100` is **not idempotent** — `4.23 * 100 === 423.00000000000006` ceils to
4.24 and would silently over-repay a cent. Pinned by `test/agents/hf-math.test.ts`.

## 2026-08-01 — known gap: the Guard bounds damage, it does not second-guess sizing

**What:** During the first armed run the LLM Critic REJECTed a proposal landing at HF 1.5999
on one tick, then APPROVEd one landing at ~1.5965 on the next. Only the Critic enforces
"reaches the target health factor" — the Guard's twelve rules enforce the allowlist, caps,
daily spend, idempotency, arming, provenance and a *minimum improvement*, but not the target.

**Why we did not simply add a thirteenth rule:** a hard `hfAfter >= targetHf` would break the
legitimate capped defense. When `MAX_TX_USD` or the wallet balance binds, the Planner
correctly proposes the largest affordable repayment even though it falls short of 1.60 — and
blocking that would leave a position undefended in exactly the situation that matters most.
The honest description of the current design is: **the Guard bounds the blast radius, the
Critic judges sufficiency.** An inconsistent Critic can therefore cause a defense that is
smaller than ideal, but never one that is unsafe, unaffordable, or off-allowlist.

**Proposed follow-up (post-hackathon):** a rule of the form
`hfAfter >= targetHf OR amountUsd is at a binding limit`, which keeps the capped case legal
while closing the inconsistency window.

## 2026-08-01 — environment: api.telegram.org unreachable from the build network

**What:** `curl https://api.telegram.org/bot…/getMe` times out after 15s from this machine,
though the same bot and chat id resolved successfully earlier in the project.

**Impact:** None on correctness — the notifier is explicitly built never to throw into the
loop, and the daemon logged `telegram sendMessage threw; continuing` and carried on. It does
mean local Telegram screenshots must be captured from a different network. KeeperHub's own
`telegram/send-message` runs server-side and is unaffected by this.

**Not a KeeperHub or Ripcord defect** — recorded so the empty Telegram evidence slot is not
mistaken for a broken notifier.

## 2026-08-01 — a Schedule-triggered workflow created with `enabled: true` never fires

**What:** WF-1 `hf-monitor` (`8kcwzx7ycrg1zlqhox6tz`) was created through
`create_workflow` with `enabled: true` and
`{"triggerType":"Schedule","scheduleCron":"*/5 * * * *","scheduleTimezone":"UTC"}` —
field-for-field identical in shape to the org's own seeded "Aave Health Factor Monitor"
(`zz5f7urg15v83k9kiugww`, cron `0 * * * *`). `create_workflow`'s own description says
*"pass enabled=true to make schedule/event/block/webhook triggers fire immediately."*

**83 minutes later, `GET /api/workflows/{id}/executions` returned `[]`** — roughly 16
missed firings. A manual `POST /execute` of the same workflow succeeds immediately and
runs the full body (`read-1` ✅ → `gate-1` ✅ → alert), so the definition is valid, the
chain reads work, and the condition evaluates. Only the scheduler never ran it.

`validate_workflow` reports `valid: true` and says nothing about the schedule. No error,
no warning, no `nextRunAt` field anywhere on the workflow object to check against — the
failure is completely silent, and the only way to notice is to poll the executions list
and find it empty.

**Impact:** A monitoring workflow that never runs is worse than no monitoring workflow,
because the dashboard shows it enabled. In Ripcord's case WF-1 is deliberately redundant
— the daemon does its own sensing — so nothing was missed, but an operator relying on it
as the backstop would have silent, invisible coverage loss.

**Proposed fix:** Expose `nextRunAt` / `lastRunAt` on the workflow object so a schedule
can be verified without waiting a full period. Surface a validation error (or at minimum
a `validate_workflow` warning) when a Schedule trigger cannot be registered, and state
plainly in the docs whether scheduled execution requires a plan tier — the same
undisclosed-gating pattern already bit us with `code/run-code`.

## 2026-08-01 — known gap: the daemon has no single-instance lock

**What:** During the live run we found **four** `pnpm dev` daemons alive at once — three
from restarts earlier the same afternoon plus one left over from the previous day. The
tell was `pnpm status`: three `observed` decisions per minute against a 60-second poll.

They survived because `pkill -f "tsx src/index.ts"` matches the *zsh wrapper* but not the
real process, which `ps` reports as
`node .../tsx/dist/cli.mjs src/index.ts`. The kill reported success and killed nothing.

**Why it matters beyond the operator error:** every instance shares one SQLite file, so
cooldown and the rolling daily cap do serialize them *once a row is written* — but each
daemon mints its own ULID `decisionId`, so the Guard's idempotency rule cannot dedupe
across instances. Two daemons ticking in the same second can both pass the cooldown check
before either inserts an execution, and both fire. The blast radius is still bounded by
MAX_TX_USD, the daily cap and the allowlist — the Guard does its job — but the position
could be defended twice for the same event.

**Not exploited here:** only one execution row exists per event, and we killed the extras
before the next defense window.

**Proposed fix (Phase 2):** take an exclusive advisory lock at startup — a `daemon_lock`
row carrying pid + heartbeat, or an O_EXCL pidfile — and refuse to start when another
live instance holds it, the same fail-closed posture as the half-armed mainnet check in
`loadConfig`. Cheap, and it turns a silent double-spend window into a startup error.

## 2026-08-01 — our own bug: a workflow that succeeds is not a workflow that acted

**What:** WF-2 re-reads the position on-chain and, if it no longer needs defending, takes
the false branch of its gate and finishes. The run ends **`success`** — correctly, nothing
went wrong — with `transactionHashes: []`. The daemon branched on `run.state === "success"`
alone, so it recorded the decision as `executed`, called `onDefenseSuccess`, and sent an
alert announcing a rescue that never happened, while burning a 30-minute cooldown and
charging the daily cap for zero spend.

**Why we missed it:** we had reasoned carefully about the *opposite* direction — an earlier
entry in this log records removing WF-2's notify node precisely because a failing notify
would mark a landed repay as `error`. Having thought hard about "success misreported as
failure", we never asked about "did-nothing misreported as success". The asymmetry is the
lesson: a terminal state describes the *workflow's* outcome, not the *world's*.

**Fix:** require the transaction hash. `landed = state === "success" && txHash !== undefined`.
A declined run is recorded `blocked`, notified as a decline, and leaves the hysteresis latch
armed so the next tick can retry.

**Generalisable to anyone building on KeeperHub:** if your workflow has a conditional write,
the run state cannot tell you whether the write happened. Check `transactionHashes`.

## 2026-08-01 — our own bug: disarming before knowing the defense landed

**What:** `markDefenseFired` ran *before* `triggerDefense` and set `armed = false`. When the
transaction reverted, the health factor was unchanged and still in the act band — and the
only branch that re-arms the latch requires `hf > rearm` (1.55), which an undefended
act-band position can never reach. The position would then be defended again only after
decaying past `panic` (1.10): protection silently resumes one tick from liquidation.

**How close this came to shipping unnoticed:** it fired for real. The first live defense
reverted on the missing allowance at 13:58 and left the latch open. The retry at 14:28
succeeded — but only because the daemon happened to be restarted in between, which resets
`armed` in memory. The acceptance criterion passed by accident, and the green result hid
the bug. Without that restart the position would have sat undefended.

**Fix:** split the two things the function was conflating. `markDefenseAttempted` anchors
the cooldown at trigger time and leaves the latch armed; `markDefenseFired` also disarms,
and is now called only once a defense has actually landed. Retries stay rate-limited by the
cooldown rather than blocked forever by the latch.

**Lesson:** an irreversible state change made in anticipation of success is a bet. Both of
today's daemon bugs were the same mistake in different clothes — treating an intention to
act, or a workflow's own success, as evidence that the world changed.

## 2026-08-01 — Idempotency-Key works on workflow execute, but only direct-execution documents it

**What:** The docs describe the `Idempotency-Key` header only for `/api/execute/*`
(direct execution); `/api/workflows/{id}/execute` documents no headers beyond auth. We
probed it live: two POSTs to the workflow-execute endpoint with the same key returned the
**same executionId** — replay dedup works there too, it just isn't written down anywhere.

Also newly verified while here: **`PATCH /api/workflows/{id}`** accepts a partial
`{nodes, edges}` update with the org `kh_` key (PUT is 405), and
**`GET /api/workflows/executions/{id}/logs`** returns full per-node logs — both used by
this project, neither on the API docs page.

**Impact:** Positive surprise, adopted: Ripcord now sends `Idempotency-Key: decisionId`
on every defense trigger, so a network-layer retry of the same decision returns the
original execution instead of firing a second defense. But we are now depending on
undocumented behaviour, which the project's own truth policy discourages — hence this
entry. The daemon-side Guard idempotency + DB UNIQUE remain the real protection if the
header ever stops working.

**Proposed fix:** Document Idempotency-Key on the workflow-execute endpoint (plus the
PATCH and logs routes). One line each; all three already work.
