# KeeperHub verification report — 2026-07-31

> **Update, later the same day: the MCP server is now authenticated and the
> introspection below has been done live.** See §0 — it supersedes the
> "MCP not connected" caveat that follows. The docs-based findings in §1–§6 all
> held up; §0 adds the workflow node schema, which they could not give us.

---

## 0. Live MCP introspection — VERIFIED against the org

### Org wallet (the signer for every Ripcord transaction)

`list_integrations` returns **exactly one** integration:

```
id:      06gumjr8215bj2z8jacgt
type:    web3
address: 0x30C8A36e99f0708c3e3301b1Ed99cf418BDCf27a
```

That is the **Turnkey EOA (EVM Compatible)** wallet. The org also has a Turnkey
EOA (SVM Compatible) `J4RkjA…4LJj` for Solana, but it is **not registered as an
integration at all** — so it cannot be selected for a web3 write action even by
mistake. Ripcord is EVM-only; this is the wallet, and `integrationId
06gumjr8215bj2z8jacgt` is what WF-2's contract-call node will reference.

### Workflow node schema — the biggest Session-2 unknown, now answered

The org ships three seeded starter workflows (all `enabled: false`, all with
placeholder blanks). One is **"Aave Health Factor Monitor"**
(`zz5f7urg15v83k9kiugww`) — effectively a first draft of our WF-1. Reading its
graph gives us the exact node shapes:

**Schedule trigger:**
```json
{ "triggerType": "Schedule", "scheduleCron": "0 * * * *", "scheduleTimezone": "UTC" }
```

**Aave read — a first-class protocol action, not a raw contract call:**
```json
{ "actionType": "aave-v3/get-user-account-data",
  "network": "1",
  "user": "",
  "_protocolMeta": "{\"protocolSlug\":\"aave-v3\",\"contractKey\":\"pool\",
                     \"functionName\":\"getUserAccountData\",\"actionType\":\"read\"}" }
```
`network` is a **chain-id string** — `"8453"` for Base, `"84532"` for Base Sepolia.
`user` is the monitored address. Note KeeperHub resolves the Pool address itself
from `contractKey: "pool"`, so WF-1 does not need our address book for the read.

**Condition node:**
```json
{ "actionType": "Condition",
  "group": { "logic": "AND", "rules": [
    { "operator": "<",
      "leftOperand": "{{@step-1:Get Aave Health Factor.healthFactor}}",
      "rightOperand": "1500000000000000000" } ] } }
```

Two things worth calling out:
- **The health factor is compared as a raw 1e18 wad string** —
  `"1500000000000000000"` is literally our `THRESHOLDS_WAD.warn`. KeeperHub and
  Ripcord agree on the representation, which is a nice independent confirmation
  of the decision to do band comparisons in bigint wads rather than floats.
- **Reference syntax** is `{{@nodeId:Label.field}}`, matching the battle plan.

**Other confirmed fields:** `workflowType: "read"` (WF-2 will be the write
variant), and the marketplace fields we need in Session 4 already exist on the
object — `visibility`, `isListed`, `listedSlug`, `priceUsdcPerCall`, `inputSchema`,
`outputMapping`.

### Plan adjustment for Session 2

Rather than building WF-1 from scratch, **adapt `zz5f7urg15v83k9kiugww`**: point
`user` at `0x30C8…f27a`, switch `network` from `"1"` to `"84532"`, and replace the
Discord/SendGrid branches with Telegram. Then build WF-2 `defend` as the write
workflow using the same node vocabulary.

---

Session 1 was supposed to introspect the KeeperHub MCP server directly. The MCP
server was **not connected** in this environment (pre-flight `claude mcp add` +
OAuth had not been run), so this report substitutes live-documentation
verification against `docs.keeperhub.com`. Everything below is either VERIFIED
against a live source or explicitly flagged as an assumption carrying a
`// VERIFY:` marker in the code.

Re-run the real MCP introspection at the start of Session 2 and diff against this.

---

## 1. MCP tool names — VERIFIED

Source: <https://docs.keeperhub.com/ai-tools/mcp-server>. Endpoint
`https://app.keeperhub.com/mcp`; per-workflow servers at
`https://app.keeperhub.com/mcp/w/<slug>`. Auth: OAuth 2.1 (1-hour access tokens,
30-day refresh) or a `kh_` API key as Bearer.

Setup line, verbatim from the docs — matches the pre-flight step:

```
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp
```

Tools relevant to Ripcord, all confirmed present:

| Purpose | Tool |
|---|---|
| Direct transfer | `execute_transfer` |
| Direct contract call | `execute_contract_call` |
| Read → evaluate → act atomically (WF-2's core pattern) | `execute_check_and_execute` |
| Protocol action (e.g. `aave-v3/supply`) | `execute_protocol_action`, `search_protocol_actions` |
| Workflow lifecycle | `create_workflow`, `update_workflow`, `validate_workflow`, `execute_workflow`, `delete_workflow`, `get_workflow`, `list_workflows` |
| Run inspection | `get_execution`, `get_direct_execution_status` |
| Templates | `search_templates`, `deploy_template` |
| Marketplace (Session 4) | `list_workflow`, `unlist_workflow`, `update_workflow_listing`, `search_workflows`, `call_workflow` |
| Misc | `ai_generate_workflow`, `list_action_schemas`, `get_plugin`, `search_plugins`, `list_integrations`, `get_wallet_integration`, `tools_documentation` |

⚠️ **Naming trap:** `list_workflows` (plural — *read* your workflows) and
`list_workflow` (singular — the marketplace *listing* verb, paired with
`unlist_workflow`) are different tools. Easy to conflate in Session 4.

Also available: the Claude Code plugin marketplace at
<https://github.com/KeeperHub/claude-plugins>.

## 2. REST API and run polling — VERIFIED, and adopted in code

Source: <https://docs.keeperhub.com/api> and `/api/executions`. Base URL
`https://app.keeperhub.com/api`; `kh_` key as Bearer; responses wrapped in a
`{ "data": { … } }` envelope; 100 req/min authenticated.

| Endpoint | Status |
|---|---|
| `POST /api/workflows/{workflowId}/execute` → `{executionId, status}` | VERIFIED |
| `GET /api/workflows/executions/{executionId}/status` | VERIFIED — **used by `HttpKeeperHubClient.getRun`** |
| `GET /api/workflows/executions/{executionId}/wait?timeoutMs=` (blocking, default 25s, max 60s) | VERIFIED — docs prefer it over client polling; noted as a Session-2 optimization |
| `POST /api/workflows/create` | VERIFIED |

Execution object fields: `id`, `workflowId`, `status`, `input`, `output`,
`startedAt`, `completedAt`, `transactionHashes[]` (`hash`, `nodeId`, `nodeName`,
`chainId`, `network`), `progress`.

**Status enum (VERIFIED):** `pending | running | success | error | cancelled`.
Note it is `error`, **not** `failed` — `src/types.ts` `RunState` matches this
exactly, and `TERMINAL_RUN_STATES` is `{success, error, cancelled}`.

## 3. Webhook trigger — RESOLVED 2026-08-01 by direct probing

Previously the one remaining unknown. Settled empirically with two throwaway
probe workflows (`c59sy9julvftyzeyz8gdi`, `lemzd7pw3pxo9ddw08fa0`, both since
disabled) rather than guessed. Every point below was observed on the live API.

### The trigger endpoint Ripcord actually uses

```
POST https://app.keeperhub.com/api/workflows/{workflowId}/execute
Authorization: Bearer kh_…
Content-Type: application/json

{"input": { …payload fields… }}
→ 200 {"executionId": "...", "status": "running"}
```

**The `{"input": …}` envelope is mandatory and silently load-bearing.** A bare
body returns `200` with an `executionId` — it *looks* fine — but the fields never
reach the trigger node, `execution.input` is `{}`, and the first action fails
with `Unresolved template reference(s)`. Two other envelopes were tried and also
fail: `{"triggerData": …}` and `{"data": …}`.

### `/webhook` needs a different key class

`POST /api/workflows/{id}/webhook` exists, but the org `kh_` key is rejected:

```json
{"error":"Wrong API key type. This endpoint requires a user webhook key (wfb_*).
  The kh_* prefix is an org API key for /api/execute/* and /mcp.",
 "code":"wrong_key_type","expected":"wfb_*","received":"kh_*"}
```

`x-api-key` is not accepted on either endpoint — the server answers `Missing
Authorization header`. So: **auth is `Authorization: Bearer`, and the key class
selects the endpoint.** Ripcord uses `/execute` with the org key it already has;
a `wfb_` key would have to be minted by hand in the web UI.

### Template reference form — the docs/templates conflict was moot

All four candidate forms resolve to the same value:

| Form | Resolved |
|---|---|
| `{{@trigger-1:Trigger.decisionId}}` | ✅ |
| `{{@trigger-1:Trigger.data.decisionId}}` | ✅ |
| `{{@trigger-1:Manual.decisionId}}` | ✅ |
| `{{@trigger-1:Manual.data.decisionId}}` | ✅ |

The resolver keys off the **nodeId** and tolerates both the label segment and an
optional `data.` hop. We use the documented `{{@nodeId:Trigger.field}}`.

Trigger output shape is `{success: true, data: {…payload…, timestamp, triggered,
triggeredAt}}` — the posted fields are spread at the top level of `data`.

### Unresolved references abort the action (a good default)

> *"The action was aborted to prevent silently writing empty or literal values."*

A missing field kills the node rather than sending `"undefined"` on-chain. This is
fail-closed behaviour we get for free and should not be worked around.

### Conditions compare numerically

`950000000000000000 < 1500000000000000000` evaluates **true**, so raw 1e18 wads
can be compared directly against literal thresholds — the 18-vs-19-digit
lexicographic hazard does not exist. Confirmed again in WF-2 with a real read:
`"1988482751559923150" < 1500000000000000000` → `false`.

### Response parsing in code

`src/executor/keeperhub.ts` still parses permissively (`executionId | runId | id`,
with or without a `data` envelope) and **fails closed** — a 2xx with no
extractable run id throws rather than reporting an untrackable trigger.

## 4. Gas sponsorship and private routing

**Gas sponsorship — VERIFIED** (<https://docs.keeperhub.com/wallet-management/gas>):
Turnkey Gas Station, per-organization, metered in USD against a monthly credit
cap (mainnet counts, testnet does not). Sponsorship covers the **fee only** —
"The native value a transaction sends … is always debited from your own wallet."
Conditions: supported network (Ethereum, Base, Polygon, Arbitrum + testnets),
**direct wallet sender** (not Safe), **public mempool routing**, credits remaining.

**Private routing — NOT DOCUMENTED.** No page exists
(`/wallet-management/private-routing` and siblings all 404), and
`/plugins/web3` documents no private-relay/MEV option. The only reference
anywhere is the negative constraint on the gas page: *"transactions routed
through a private mempool are not sponsored."*

⚠️ **Consequence for the Phase-2 plan, confirmed:** private routing and gas
sponsorship are **mutually exclusive**. The build guide's decision table stands —
sponsorship on setup txs (public mempool), private routing self-paid on mainnet
defenses. Availability of private routing *on Base* still needs confirming in
Session 2 via MCP/Discord; it is the one open risk to the hero-tx plan.

## 5. Para vs Turnkey — a docs bug worth a PR

- The Gas Management page names **Turnkey** only. Correct.
- The Wallet Management index lists "Para Wallet Integration (**Discontinued**)".
- But `llms.txt` still describes Wallet Management as *"Para MPC wallets, gas,
  address book"*, and the Agentic Wallets page still describes the
  *"Para MPC wallet model for autonomous agents"*.

LLM-assisted builders consuming `llms.txt` are steered to a dead integration.
This is the concrete, mergeable docs fix earmarked for the onboarding bounty
(build guide §12, bounty deliverable 3).

## 6. Do not codegen from the published OpenAPI

`https://app.keeperhub.com/api/openapi` contains **83 paths, all of the form
`POST /api/mcp/workflows/{slug}/call`** — it is a catalog of published
marketplace workflow endpoints, not the REST API. None of the workflow or
execution endpoints above appear in it. A generated client would be wrong.

---

## Corrections this report applied to the code

1. `RunState` uses the verified enum including `error` (not the assumed `failed`).
2. `getRun` targets the verified `/workflows/executions/{id}/status` endpoint and
   handles the `{data:…}` envelope, rather than a guessed path.
3. `transactionHashes[]` is mapped to `RunStatus.txHashes` with `chainId`/`network`,
   with the first hash surfaced as `txHash` for notifications.
4. Base Sepolia is a live Aave V3 market (6 reserves, verified on-chain), so the
   Anvil-fork fallback from build guide §6.9 is very likely unnecessary.
5. The Base Sepolia USDC in the address book is the Aave market's faucet token
   `0xba50Cd…`, **not** Circle's `0x036CbD…` — a trap that would have produced
   silently wrong balance reads.
