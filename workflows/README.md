# KeeperHub workflows

Exported definitions of the live workflows, each built and verified against the
KeeperHub API. Re-export after any change:

```bash
curl -sS "https://app.keeperhub.com/api/workflows/<id>" \
  -H "authorization: Bearer $KEEPERHUB_API_KEY"
```

| File | Workflow | ID | Chain | Trigger |
|---|---|---|---|---|
| `wf1-hf-monitor.json` | WF-1 `hf-monitor` | `8kcwzx7ycrg1zlqhox6tz` | 84532 | Schedule, `*/5 * * * *` UTC |
| `wf2-defend.json` | WF-2 `defend` | `rk20tp8ucuf3caxjrdpfe` | 84532 | Webhook |
| `wf2-defend-mainnet.json` | WF-2 `defend-mainnet` | `wjp3tis90y1nn4e57t817` | 8453 | Webhook (kept **disabled** outside supervised armed sessions) |
| `wf3-risk-score.json` | WF-3 `risk-score` | `70sds40dse7wckofqe7lx` | 8453 | Manual (marketplace `/call`) |

All sign from the org's single Turnkey wallet
`0x30C8A36e99f0708c3e3301b1Ed99cf418BDCf27a`; Pool addresses come from
Ripcord's own allowlist (`src/config.ts`).

---

## WF-1 `hf-monitor`

`Schedule (5 min) → web3/read-contract → Condition (HF < 1.50) → telegram/send-message`

KeeperHub's own watch on the position, independent of the Ripcord daemon: if the
daemon is down, the alerting still fires. It **only reads and notifies** — it can
never move money. That separation is deliberate; WF-2 is the only workflow with a
write node.

> **One-time human step:** `telegram/send-message` reports
> `requiresCredentials: false` in the action schema but fails at runtime with
> *"Telegram bot token is required. Please configure it in the integration
> settings."* Add the bot token under KeeperHub → Integrations. We deliberately do
> **not** inline the token via an `HTTP Request` node to `api.telegram.org`, because
> the workflow definition is committed to this repo and that would publish a secret
> (invariant 7). Until the integration is configured, WF-1's read + condition run
> correctly and only the final alert node errors.

## WF-2 `defend`

`Webhook → web3/read-contract → Condition → web3/write-contract (repay) → web3/read-contract`

The only path by which Ripcord moves money. The daemon POSTs a `DefensePayload` here
**after** its Planner, Critic and Guard have all approved; WF-2 then re-derives the
decision from chain state before writing.

### Trigger contract

```
POST https://app.keeperhub.com/api/workflows/rk20tp8ucuf3caxjrdpfe/execute
Authorization: Bearer kh_…
Content-Type: application/json

{"input": { …the 9 DefensePayload fields… }}
→ 200 {"executionId": "...", "status": "running"}
```

The `{"input": …}` envelope is **load-bearing**. A bare body also returns 200, but its
fields never reach the trigger node and every `{{@trigger-1:Trigger.<field>}}`
reference then fails to resolve. See `src/executor/keeperhub.ts`.

Payload fields (`DefensePayload`, src/types.ts): `decisionId`, `chain`, `action`,
`assetSymbol`, `assetAddress`, `amountBaseUnits`, `amountUsd`, `minHfAfter`,
`monitoredAddress`.

### Why the gate exists

`gate-1` is Ripcord's last line of defence and the reason WF-2 is not just a thin
relay. The daemon's decision is a *claim about the past*; between deciding and
executing, the position can recover, someone can repay manually, or the trigger can
be replayed. So WF-2 re-reads `getUserAccountData` itself and requires **both**:

| Rule | Meaning |
|---|---|
| `healthFactor < 1500000000000000000` | the position is genuinely still below the warn band |
| `amountBaseUnits <= 60000000` | hard 60-USDC ceiling, independent of anything the caller sends |

Only the `sourceHandle: "true"` edge reaches the repay node. If either rule fails the
run ends `success` with `condition: false`, no transaction, empty `transactionHashes`.

Proven live on first fire (execution `x8rb3lbaxyy2b6wvses82`, HF 1.9885): resolved to
`"1988482751559923150" < 1500000000000000000 && "10000" <= 60000000` → `false`, trace
stopped at `gate-1`. A healthy position was **not** repaid.

### A declined run is not a failed run, and it is not a defense

This is the subtlest part of the contract, and it was a live bug before review
caught it. When `gate-1` is false the run ends **`success`** — nothing errored,
the workflow did exactly what it was asked to do — but `transactionHashes` is
empty and no money moved. Three outcomes therefore have to be told apart:

| Outcome | run state | txHashes | Decision recorded |
|---|---|---|---|
| Defended | `success` | 1 hash | `executed` |
| Declined by the gate | `success` | `[]` | `blocked` |
| Reverted / errored | `error` | `[]` | `failed` |

**The transaction hash is the only honest evidence a defense happened**, so
`src/index.ts` requires it rather than trusting `run.state`. A declined run
leaves the hysteresis latch armed and does not call `onDefenseSuccess` — the
position was never rescued, so the next eligible tick must be free to try again.

We deliberately did **not** add a node on `gate-1`'s false branch to make the
decline more visible workflow-side. Any node that succeeds is indistinguishable
from the declined path anyway, and any node that fails would mark the whole
execution `error` — which is exactly the misreporting the missing notify node
was removed to avoid. The daemon-side `txHash` check is the reliable
discriminator and it is the half fully under our control.

### Design notes

- **`web3/write-contract`, not `aave-v3/repay`.** The Aave protocol actions reject
  chain 84532 outright (`expected: 1 | 10 | 8453 | 42161 | 11155111`), so they are
  unusable on Base Sepolia. Pinning `contractAddress` ourselves also keeps the Pool
  address sourced from Ripcord's own allowlist rather than an opaque registry.
  (An earlier revision claimed the node's `usePrivateMempool` field was the Phase-2
  private-routing switch — disproven: routing is a server-side per-chain flag,
  Flashbots Protect, Ethereum-only. See docs/architecture.md § MEV posture.)
- **No notify node in WF-2.** A failing `telegram/send-message` marks the *entire
  execution* `error`, which would report a landed repay as a failure and corrupt the
  daemon's run tracking. The daemon owns notification.
- **`confirm-1`** re-reads the position after the repay so the post-defense health
  factor is captured in the execution record as evidence.
- Comparisons are **numeric**, verified explicitly: `950000000000000000 <
  1500000000000000000` evaluates `true`, so the 18-vs-19-digit lexicographic hazard
  does not exist.

## WF-3 `risk-score` — the paid product ✅

| | |
|---|---|
| Workflow | `70sds40dse7wckofqe7lx` → [`workflows/wf3-risk-score.json`](wf3-risk-score.json) |
| Listing | slug **`ripcord-risk-score`** · **$0.05/call** (the quota-exemption floor) · category defi · chain 8453 |
| Call | `POST https://app.keeperhub.com/api/mcp/workflows/ripcord-risk-score/call` (x402 v2; `payTo` = the org wallet) |

`Manual trigger → read getUserAccountData → belowWarn → belowAct → belowPanic →
noDebt → final position re-read`. The conditions are chained through BOTH handles
so every band always evaluates, and the terminal re-read exists because the
platform stores a listing's `outputMapping` but does not apply it to call
responses (FRICTION.md 2026-08-02) — the last node's output IS the product, so
the last node is deterministically the full figures.

No `code/run-code` node (pro-plan-gated): the workflow sells **verifiable raw
figures + band booleans**, and the score formula is public — reference
implementation `src/risk/engine.ts`, runnable on any paid response via
`tsx scripts/risk-score.ts --json <response.json>`.
