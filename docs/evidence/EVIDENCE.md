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

### WF-1 detecting the below-warn condition

Manual fire, execution `67jr69eego2k2f3hmtnwq`, against the position at HF 1.2266:

```
trace: trigger-1 ✅ → read-1 ✅ → gate-1 ✅ → alert-1 ❌
       "Telegram bot token is required. Please configure it in the integration settings."
```

`gate-1` passed and handed off to the alert node, i.e. WF-1 independently read the
chain and **correctly concluded the position is below the 1.50 warn band**. The only
failure is the Telegram integration, a one-time UI step (see `workflows/README.md`).

Its `*/5` schedule, however, has never fired — `[]` executions in 83 minutes with
`enabled: true`. Silent, and only visible by polling the executions list. FRICTION.md.

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

| # | Time | Run | $ | Status | Detail |
|---|---|---|---|---|---|
| 1 | 13:58:04 | `7wnw3uuchs8gpto51vm8u` | 4.20 | **error** | `Contract call failed: Error(ERC20: transfer amount exceeds allowance)` |
| 2 | 14:28:36 | `zfv7imdpw0ucrvv7g2toy` | 4.21 | **success** | [`0xf1f52639…aab176`](https://sepolia.basescan.org/tx/0xf1f526390d4c2bee7cf8bc16fe103f35563d72cc40e92ccfc0b7ded8b8aab176) |
| 3 | 14:59:05 | `ni3gbbfz5q5bwj8s3j9mc` | 4.20 | **success** | [`0xbeccc0d4…a27e`](https://sepolia.basescan.org/tx/0xbeccc0d431f7ebb5b41f80d0f1612de9e63c2197d7f43ef00c75e642ded7a27e) |
| 4 | 15:29:35 | `l9rpksmy73bm4oam7hmkh` | 4.20 | **success** | [`0x49283fc2…6db2`](https://sepolia.basescan.org/tx/0x49283fc255ae69d5731cd3e0124e5a789e4bfcafbd4233f552695260311f6db2) |

## Phase 1 — AC-1: three consecutive hands-off defenses ✅

Defenses #2, #3 and #4 each ran the complete loop with no human in it: sensor read →
act band → LLM Planner → independent LLM Critic APPROVE → Guard `execute` (12/12
checks) → WF-2 re-verified on-chain → `Pool.repay` → confirm read → HF restored to
1.60 → hysteresis latch re-armed on the next tick. Each cycle was spaced by the real
1800-second cooldown — no overrides, no config tuning for the demo. The only manual
steps between cycles were the deliberate re-stress borrows
(`kiypnfqnlar9l2f1kp7dm`, `jh5yxdz80pvqvg1527xh4`), which push HF back down; the
defenses themselves were fully autonomous.

Defense #4 additionally ran on the post-review code: it is the first defense where
the latch was opened *by the landed transaction* (markDefenseFired on txHash
evidence) rather than at trigger time.

Total spend across the run: $12.61 of the $30 rolling daily cap. Every transaction
gas-sponsored by KeeperHub.

On run 1 the node trace was `trigger-1 → verify-1 → gate-1 → repay-1(error)` — the gate
**passed** (the position genuinely was below warn) and the write reverted at the token
layer. The daemon recorded `error`, notified, and `markDefenseFired` started the real
1800s cooldown. **The 30-minute gap before the retry is the product's own behaviour, not
a staged pause.**

Remediation inside that window: `approve(Pool, 60000000)` on the Aave test USDC —
execution `m9zygb457ph9822nupfc4`, sponsored. Allowance verified `60000000`.

Run 2, the retry, completed the full path:

```
14:28:46  guard evaluated · execute · violations: [] · checks: 12
          WF-2 trace: trigger-1 ✅ → verify-1 ✅ → gate-1 ✅ → repay-1 ✅ → confirm-1 ✅
          tx 0xf1f526390d4c2bee7cf8bc16fe103f35563d72cc40e92ccfc0b7ded8b8aab176
14:29:55  HF 1.601035 [healthy] — "hysteresis latch re-armed"
```

Position: **HF 1.2266 → 1.6010**, debt $18.00 → $13.79. It cleared the 1.60 target by
0.001 — the deliberate one-cent ceiling, not luck.

## Still to capture

- [ ] Telegram screenshot — `api.telegram.org` is unreachable from the build
      network (times out); the notifier degrades correctly, see FRICTION.md.
      Also configure the KeeperHub Telegram integration (web UI) so WF-1's
      alert node stops erroring.
- [ ] **Hero tx:** private-routed mainnet defensive repay (Phase 2)
- [ ] Chaos matrix, one artifact per scenario (§7.6)
- [ ] x402 paid call on x402scan (Phase 3, stretch)

## Phase 2 — hardening + chaos matrix (2026-08-01, all on testnet)

| What | Evidence |
|---|---|
| Single-instance lock refuses a 2nd daemon (live) | `logs/chaos-single-instance-lock.log` |
| Wrong-chain payload declined by WF-2's own gate | `logs/chaos-wrong-chain-declined.log` — `"base" == "base-sepolia" → false`, no tx |
| Idempotency-Key replay → same executionId | run `lsljnilzwbbl9b9zn01ou` returned twice for one key |
| WF-2-mainnet preflight vs empty wallet | run `jb7kyiqx675tupt1bn7zn` — mainnet Pool read OK, HF = maxUint sentinel, gate declined, no tx |
| Planner garbage-JSON chaos (incl. panic band) | `logs/chaos-planner-invalid-json.log` |
| RPC unreachable chaos | `logs/chaos-rpc-unreachable.log` |
| SIGKILL / orphan / stale-takeover chaos | `logs/chaos-sigkill-restart.log` |

Full chaos table with per-scenario links: README § Chaos matrix.

## Phase 2 — mainnet position opened (2026-08-01, Base 8453, REAL FUNDS)

User funded the Turnkey wallet with 0.03353 ETH (~$61.68). All five setup calls
were simulated first (`simulate:true`, `wouldRevert:false`), executed with
idempotency keys, and **gas-sponsored — `from` is a Gas Station relayer via the
same paymaster `0x5af5194b…f07d` as testnet, even for the value-bearing wrap**:

| # | Call | Tx | KeeperHub execution |
|---|---|---|---|
| 1 | `WETH.deposit()` value 0.024465 ETH (~$45.00) | [`0x1d43a6bc…1a29`](https://basescan.org/tx/0x1d43a6bc19684d7e68f045a88a4a390c539df9acdc90b3a4f17b197f8a8b1a29) | `847u9qi44vbz29ra9700t` |
| 2 | `WETH.approve(Pool, 0.024465)` | [`0xa6fa6297…2f31`](https://basescan.org/tx/0xa6fa6297173ae3c43aeb254bfd9bf9c94979182016f2594e94114f843dd82f31) | `bwgra93adyl72ntyrwm2a` |
| 3 | `Pool.supply(WETH, 0.024465)` | [`0x7b903962…c87c`](https://basescan.org/tx/0x7b90396287d0d00f7cb250dec16b799101d18fa2aab316773342782ed9c6c87c) | `jm6ajcebuowb7j747an5y` |
| 4 | `Pool.borrow(USDC, 26.68, variable)` | [`0x73234b9d…e6a6`](https://basescan.org/tx/0x73234b9d4f27bc99f9ff6c29175466ce23f6d2ed24d622c56da120489aa5e6a6) | `4998mg6mfil8cj6b8hnp3` |
| 5 | `USDC.approve(Pool, 60)` — capped, revocable | [`0xee860f7c…26ef`](https://basescan.org/tx/0xee860f7cb7c1ef0559208d8e2e0b4b4acdc33ddb98cc8368e4a64e11c13026ef) | `qe6i0y8bkrm5ubeo7wktq` |

Resulting live position (design target HF 1.400):

```
collateral $45.0001 (0.024465 WETH) · debt $26.6766 USDC · LT 83% · HF 1.4001
wallet: 26.68 USDC (repay budget) · 0.00907 ETH (buffer)
```

Supervised mainnet DRY_RUN: banner `chain: base · DRY_RUN: ON · ARM: 0`, first
tick `band=warn hf=1.400106 shouldDefend=false` — the warn band is real, and the
daemon correctly holds. Mainnet history lives in its own DB
(`data/ripcord-mainnet.sqlite`) so testnet spend/cooldown never leak into
mainnet accounting.
