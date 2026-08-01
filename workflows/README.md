# KeeperHub workflows

Exported definitions of the two live workflows, both built and verified against the
KeeperHub API on **2026-08-01**. Re-export after any change:

```bash
curl -sS "https://app.keeperhub.com/api/workflows/<id>" \
  -H "authorization: Bearer $KEEPERHUB_API_KEY"
```

| File | Workflow | ID | Trigger |
|---|---|---|---|
| `wf1-hf-monitor.json` | Ripcord WF-1 `hf-monitor` | `8kcwzx7ycrg1zlqhox6tz` | Schedule, `*/5 * * * *` UTC |
| `wf2-defend.json` | Ripcord WF-2 `defend` | `rk20tp8ucuf3caxjrdpfe` | Webhook |

Both run on **Base Sepolia (84532)** against Aave V3 Pool
`0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27`, signing from the org's single Turnkey
wallet `0x30C8A36e99f0708c3e3301b1Ed99cf418BDCf27a`.

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

### Design notes

- **`web3/write-contract`, not `aave-v3/repay`.** The Aave protocol actions reject
  chain 84532 outright (`expected: 1 | 10 | 8453 | 42161 | 11155111`), so they are
  unusable on Base Sepolia. Pinning `contractAddress` ourselves also keeps the Pool
  address sourced from Ripcord's own allowlist rather than an opaque registry, and it
  is the only node type on which `usePrivateMempool` has been observed — which is how
  Phase 2 turns on private routing without a rebuild.
- **No notify node in WF-2.** A failing `telegram/send-message` marks the *entire
  execution* `error`, which would report a landed repay as a failure and corrupt the
  daemon's run tracking. The daemon owns notification.
- **`confirm-1`** re-reads the position after the repay so the post-defense health
  factor is captured in the execution record as evidence.
- Comparisons are **numeric**, verified explicitly: `950000000000000000 <
  1500000000000000000` evaluates `true`, so the 18-vs-19-digit lexicographic hazard
  does not exist.

## WF-3 `risk-score` (stretch, Phase 3)

Input `{chain, address}` → reads → scoring → JSON out. Listed on the Marketplace at
$0.05/call. Note `code/run-code` requires a **paid plan**, so the scoring step needs a
different shape or an upgrade.
