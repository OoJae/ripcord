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

## Still to capture

- [ ] Hands-off testnet defense actually landing (needs WF-2 `defend` — Session 2)
- [ ] 3 consecutive successful defenses (Phase 1 AC)
- [ ] Critic REJECT on a live run — screenshot (we have several in logs already)
- [ ] One failure → retry → success run
- [ ] **Hero tx:** private-routed mainnet defensive repay (Phase 2)
- [ ] Chaos matrix, one artifact per scenario (§7.6)
- [ ] x402 paid call on x402scan (Phase 3, stretch)
