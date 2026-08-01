# EVIDENCE.md — demo-worthy output index

Append-only index of screenshots, tx hashes, run IDs, and log captures.

## Phase 0 — first transactions through KeeperHub ✅

All executed on **Base Sepolia (84532)** from the Turnkey EOA
`0x30C8A36e99f0708c3e3301b1Ed99cf418BDCf27a`, via the KeeperHub MCP
`execute_contract_call` surface. **Every one was gas-sponsored** (`sponsored: true`).

| Date | What | Tx | KeeperHub execution | Gas |
|---|---|---|---|---|
| 2026-08-01 | **Tracer bullet** — mint 1000 test USDC from the Aave faucet | [`0xcb32c35b…a03ef`](https://sepolia.basescan.org/tx/0xcb32c35b07c7f9faf21fdd6eca168193d86c29dea4b08b605dae132faf7a03ef) | `1loczpn5cny9i6u9ub2cx` | 137,311 · sponsored |
| 2026-08-01 | Mint 1 cbETH from the Aave faucet | — | `n0lbfj20bvbxhv8zsedqe` | sponsored |
| 2026-08-01 | Approve cbETH → Aave Pool | — | `7o7qd7ejbvxb5gi06b31u` | sponsored |
| 2026-08-01 | **Open position** — supply 0.02 cbETH collateral | [`0x4cc001bf…4be8`](https://sepolia.basescan.org/tx/0x4cc001bfaa7d268e73a71cb710f62f8d611c69aa4e8ea9f23ea4d48ba5e64be8) | `wr1fcslluapllwzxar0dq` | 216,534 · sponsored |
| 2026-08-01 | **Open position** — borrow 18 USDC (variable rate) | [`0xc24bd59e…7676`](https://sepolia.basescan.org/tx/0xc24bd59e88091bee511886dcdd0b8138384cdcd750b6ad784128a07767537676) | `gwetedawj8h4f68o5dzho` | 282,541 · sponsored |

**Resulting live position** (read back by Ripcord's own sensor):

```
collateral $42.35 (0.02 cbETH) · debt $18.00 USDC · LT 84.5% · HEALTH FACTOR 1.9885
wallet: 1018 USDC · 0.98 cbETH
```

Two KeeperHub surfaces proven here, both worth citing in the surfaces map:
**direct contract-call execution** and **gas sponsorship** (Turnkey Gas Station —
note `topLevelTo` is the paymaster `0x5af5194b…f07d`, not the Pool).

## Ripcord reading the live position

`pnpm status` against the real Base Sepolia position:

```
🪂 RIPCORD status
  chain: base-sepolia · DRY_RUN: ON · ARM: 0 · caps $15/tx $30/24h
  reads: LIVE · brain: mimo-v2.5-pro · executor: mock
  current HF: 1.9885 · collateral $42.35 · debt $18.00
  last observed: HF 1.9885 [healthy] at 2026-08-01 12:01:41
```

## Full decision pipeline with real LLM agents (DRY_RUN)

Mock sensor driving the descent, real Planner + Critic, real Guard:

| band | HF | minimum needed | Planner proposed | true HF after | Critic | Guard |
|---|---|---|---|---|---|---|
| act | 1.2129 | $4.79 | **$4.79** | 1.6003 | APPROVE | dry-run, 12/12 checks |
| panic | 1.0916 | $6.99 | **$6.99** | 1.6003 | APPROVE | dry-run, 12/12 checks |

Critic verbatim: *"All conditions satisfied: hfAfter 1.6003 ≥ target 1.6, amountUsd
$4.79 ≤ MAX_TX_USD $15, ≤ wallet USDC $25, valid pairing."*

## Safety rails firing on real model output

Before the arithmetic was moved into deterministic code, the live LLM produced a
Planner claim of `hfAfter 6.41` against a true 5.01 — **blocked by the Guard's
`hf-claim-honesty` rule**. Captured in [FRICTION.md](../../FRICTION.md); this is the
clearest available proof that the deterministic Guard is load-bearing, not decorative.

## Phase 1 — the two KeeperHub workflows

| Workflow | ID | Shape |
|---|---|---|
| WF-1 `hf-monitor` | `8kcwzx7ycrg1zlqhox6tz` | Schedule 5min → read → Condition(HF<1.50) → Telegram |
| WF-2 `defend` | `rk20tp8ucuf3caxjrdpfe` | Webhook → read → Condition → **repay** → confirm read |

Definitions exported to [`workflows/`](../../workflows/). Both pin the Aave Pool
address from Ripcord's own allowlist rather than a protocol registry — the
`aave-v3/*` actions reject chain 84532 outright.

### WF-2 refusing to defend a healthy position

First live fire, execution `x8rb3lbaxyy2b6wvses82`, against the position at HF 1.9885:

```
resolved: "1988482751559923150" < 1500000000000000000 && "10000" <= 60000000  →  false
trace:    trigger-1 → verify-1 → gate-1          (repay-1 never ran)
txHashes: []
```

WF-2 re-read the chain itself and declined. This is the stale-decision guard: the
daemon's decision is a claim about the past, and the workflow will not act on it if
the position has since recovered. **Nothing upstream of the workflow was involved.**

## Phase 1 — the pipeline catching its own bug (AC-3, Critic REJECT)

First armed tick against the live position, decision `01KYYPC60Z0EG9C4AKD7DPM40M`:

```
band: act · hf: 1.226572 · shouldDefend: true
guard evaluated → blocked · 12 checks
  violation: critic-approval
  detail: critic verdict "REJECT" is not APPROVE — critic reason:
          VERIFIED hfAfter 1.5999 is below the target health factor of 1.6
```

Log: [`logs/critic-reject-rounding.log`](logs/critic-reject-rounding.log).

This was a **real defect in our own arithmetic**, not a model error.
`repayNeededForTarget` returned the exact requirement ($4.2295) and the prompt
rendered it at 2dp; the rounded amount lands one ten-thousandth under the 1.60
target, and the Critic refused it. Every tick would have refused — a permanently
stalled agent, failing safe but never defending. Fixed by ceiling to whole cents
(see FRICTION.md); the layered design caught it exactly where it was supposed to.

## Phase 1 — failure → retry → success (AC-2)

**The failure was real, not staged.** The USDC allowance to the Pool was still zero,
so the first defense that cleared Planner + Critic + Guard reverted on-chain.

| # | Decision | Run | Status | Detail |
|---|---|---|---|---|
| 1 | `…KXM0BQBA` | `7wnw3uuchs8gpto51vm8u` | **error** | `Contract call failed: Error(ERC20: transfer amount exceeds allowance)` |

Node trace `trigger-1 → verify-1 → gate-1 → repay-1(error)` — the gate **passed**
(the position genuinely was below warn) and the write reverted at the token layer.
The daemon recorded status `error`, notified, and `markDefenseFired` started the
real 1800s cooldown, which is what spaces the retry.

Remediation inside that window: `approve(Pool, 60000000)` on the Aave test USDC —
execution `m9zygb457ph9822nupfc4`, sponsored. Allowance verified `60000000`.

## Still to capture

- [ ] Retry after the allowance fix landing successfully (AC-2 part 2)
- [ ] 3 consecutive successful defenses (AC-1)
- [ ] Telegram screenshot — `api.telegram.org` is unreachable from the build
      network (times out); the notifier degrades correctly, see FRICTION.md
- [ ] **Hero tx:** private-routed mainnet defensive repay (Phase 2)
- [ ] Chaos matrix, one artifact per scenario (§7.6)
- [ ] x402 paid call on x402scan (Phase 3, stretch)
