# 🪂 Ripcord

[![ci](https://github.com/OoJae/ripcord/actions/workflows/ci.yml/badge.svg)](https://github.com/OoJae/ripcord/actions/workflows/ci.yml)

**Autonomous, MEV-aware liquidation protection for Aave V3 on Base — decisions by AI agents, execution guaranteed by [KeeperHub](https://keeperhub.com).**

When a DeFi position slides toward liquidation, every second and every mempool snoop matters. Ripcord watches your Aave V3 health factor, plans a defense with a Planner agent, forces an independent Critic agent to approve it, passes a deterministic safety Guard — and then lands the rescue transaction through KeeperHub with retries, smart gas, and private routing, before the liquidators see it coming.

> Incidents like Moonwell's $1.78M bad debt (Feb 2026) and Aave's $27M liquidation event (Mar 2026) were detectable before a single bot ran. Agents can *decide* to save a position; Ripcord is how the rescue actually *lands*.

## Architecture

```
                ┌────────────────────────── Ripcord daemon (Node/TS) ─────────────────────────┐
                │                                                                              │
 Base RPC ──────►  Sensor (viem)          Planner (LLM)        Critic (LLM)      Guard (code)  │
 (reads only)   │  - getUserAccountData    - proposes action    - independent     - hard caps  │
                │  - HF, trend, balances   - JSON schema out     APPROVE/REJECT   - allowlist  │
                │        │                      │                    │            - DRY_RUN /  │
                │        ▼                      ▼                    ▼              ARM flags  │
                │   policy.evaluate() ──► decision ──► critique ──► guard.check() ──► execute  │
                │                                                                      │       │
                └──────────────────────────────────────────────────────────────────────┼───────┘
                                                                                       ▼
                                                              KeeperHub (webhook workflow / API)
                                                              - simulate → private routing (mainnet)
                                                              - smart gas, retries/backoff
                                                              - audit trail (trigger→sim→tx→outcome)
                                                                       │
                                                     ┌─────────────────┼──────────────────┐
                                                     ▼                 ▼                  ▼
                                                Base mainnet      Telegram alert     SQLite + logs
                                                (Aave V3 tx)      (rationale + tx)   (evidence)
```

## KeeperHub surfaces map

| Surface | Where Ripcord uses it | Evidence |
|---|---|---|
| Webhook-triggered workflow (WF-2 `defend`) | The only path by which Ripcord moves money | ✅ [`rk20tp8ucuf3caxjrdpfe`](workflows/wf2-defend.json) |
| Scheduled workflow (WF-1 `hf-monitor`) | Redundant HF monitoring even if the daemon dies | ✅ [`8kcwzx7ycrg1zlqhox6tz`](workflows/wf1-hf-monitor.json) |
| Workflow execution API | Daemon triggers WF-2 via `POST /workflows/{id}/execute` | ✅ `src/executor/keeperhub.ts` |
| Run status API (`/status`, `/wait`) | Executor polls runs to a terminal state | ✅ every defense in [EVIDENCE.md](docs/evidence/EVIDENCE.md) |
| `web3/read-contract` in-workflow | WF-2 re-reads the position before it will write | ✅ [stale-decision refusal](docs/evidence/EVIDENCE.md) |
| `Condition` branching | The on-chain gate that decides whether the repay node runs | ✅ `sourceHandle: "true"` edge only |
| `web3/write-contract` | The defensive `Pool.repay` itself | ✅ [EVIDENCE.md](docs/evidence/EVIDENCE.md) |
| MCP server + Claude Code plugin | Position setup and workflow build/debug | ✅ [4 txs](docs/evidence/EVIDENCE.md) via `execute_contract_call` |
| Direct contract-call execution | Faucet mint, supply/borrow, right-sizing, capped approval | ✅ [`0x4cc001bf…`](https://sepolia.basescan.org/tx/0x4cc001bfaa7d268e73a71cb710f62f8d611c69aa4e8ea9f23ea4d48ba5e64be8) |
| Gas sponsorship | Every setup and defense tx, `sponsored: true` | ✅ all setup txs sponsored |
| Audit trail | `decisionId` threads log → SQLite → payload → execution → tx | ✅ one ULID end to end |
| Private routing (mainnet defenses) | MEV protection for the rescue | ⬜ Phase 2 — `usePrivateMempool` wired, off on testnet |
| Marketplace + x402 (WF-3 `risk-score`) | Paid risk scoring — Ripcord pays for itself | ⬜ Phase 3 |

## Transactions

| # | What | Chain | Tx | KeeperHub run |
|---|---|---|---|---|
| 1 | Hero: private-routed defensive repay | Base mainnet | _(Session 3)_ | |
| 2 | Gas-sponsored setup (capped approval) | Base mainnet | _(Session 3)_ | |
| 3 | Paid x402 call to risk-score workflow | Base | _(Session 4)_ | |

## Quickstart (works in under a minute, zero secrets)

```bash
pnpm install
pnpm dev                  # no .env needed — full decision loop in mock mode, DRY_RUN on
pnpm status               # current HF, recent decisions, recent runs, spend vs cap
pnpm test                 # 185 offline tests
```

With no `.env` at all, Ripcord runs a **mock demo**: a scripted health-factor descent drives the full Sense → Policy → Plan → Critique → Guard → (dry-run) Execute pipeline, every stage logged under one `decisionId`. Real output from `pnpm dev`:

```
🪂 RIPCORD starting — chain: base-sepolia · chain reads: MOCK · brain: HEURISTIC ·
   executor: MOCK · alerts: log-only · DRY_RUN: ON · RIPCORD_ARM: 0 · caps: $15/tx · $30/24h
band=healthy hf=1.82  shouldDefend=false
band=warn    hf=1.4557 shouldDefend=false
band=act     hf=1.2129 shouldDefend=true  "act: armed and cooldown elapsed — defend"
guard=dry-run violations=[] checks=12
DRY_RUN: all safety checks passed — would trigger KeeperHub defense
   repay 4.79 USDC → 0xba50Cd…4D5f  (minHfAfter 1.6)
   critic APPROVE — recomputed health factor 1.6003 clears the target 1.6
band=act     hf=1.1490 shouldDefend=false
   "defense suppressed — unarmed (hysteresis latch open); cooldown active"
```

Capabilities light up independently as you add secrets — each missing one falls back to a mock rather than failing:

| Add to `.env` | Turns on |
|---|---|
| `MONITORED_ADDRESS` | Live Aave V3 reads (public Base Sepolia RPC is the default) |
| `ANTHROPIC_API_KEY` | LLM Planner + Critic instead of the deterministic heuristics |
| `KEEPERHUB_DEFEND_WEBHOOK_URL` + `KEEPERHUB_API_KEY` | Real execution through KeeperHub |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram alerts instead of log-only |

Optional knobs with code defaults: `RIPCORD_POLL_SEC` (60s live / 5s mock), `RIPCORD_DB_PATH` (`data/ripcord.sqlite`), `RIPCORD_MODEL` (`claude-sonnet-5`), `ANTHROPIC_BASE_URL` (point the Planner/Critic at any Anthropic-protocol-compatible endpoint).

### The agents judge; code computes

Both the Planner and the Critic receive a **VERIFIED FIGURES** block — the post-defense health factor and the smallest sufficient repayment, computed deterministically in [`src/agents/hf-math.ts`](src/agents/hf-math.ts). Neither model is asked to do arithmetic the system then relies on.

This is not theoretical tidiness. On the first live run a real model claimed a post-defense health factor of 6.41 where the truth was 5.01, and the Critic vetoed a perfectly good rescue because its own division came out at 1.50 instead of 1.61. The Guard caught every one — it recomputes independently and gates on its own number — but a Critic that randomly vetoes valid rescues is useless even when it is safe. Moving the arithmetic into code and leaving the agents to judge fixed it: the same scenario now sizes defenses to the exact minimum ($4.79 in the act band, $6.99 in panic) and both are approved. Write-up in [FRICTION.md](FRICTION.md).

## Safety design

- **DRY_RUN=true by default.** Mainnet writes additionally require `RIPCORD_ARM=1` — provably: with `RIPCORD_ARM=0` nothing can reach the executor in mainnet mode (wiring-level test).
- **All onchain writes go through KeeperHub.** viem is reads-only.
- **Hard caps** (`MAX_TX_USD`, `DAILY_CAP_USD` over a rolling 24h) enforced in a deterministic Guard, in integer cents — sub-cent float games cannot slip under a cap.
- **Addresses come only from the config allowlist** — LLM output containing any raw address is rejected outright, even inside prose.
- **No Critic APPROVE → no execution. Ever.** A Critic that exhausts its retries resolves to REJECT; a Critic that *throws* is converted to REJECT. There is no path on which the absence of an approval becomes an approval.
- **The Guard recomputes, it does not verify.** The post-defense health factor is derived from the snapshot and the amount — never read from the Planner's self-reported `expectedHfAfter`. A separate rule blocks a Planner whose claim overstates the recomputed value.
- **Snapshot provenance is checked.** A defense can only act on a position whose chain and address match the configured target, so a simulated or stale snapshot can never drive a real transaction. Config independently refuses to pair mock reads with a live executor.
- **Idempotency by decisionId** (ULID), backstopped by a SQLite UNIQUE constraint.
- **Secrets never reach logs.** The Telegram bot token is redacted from every log path, and RPC URLs (which routinely embed a provider API key) are elided in the banner and scrubbed out of error text.
- Capped, revocable USDC approval; kill switch: Ctrl-C stops the daemon while WF-1 monitoring survives.

The safety design was reviewed adversarially: 22 candidate findings across four independent lenses, each then double-verified by a skeptic prompted to refute it. Seven survived and all are fixed — including two the review reproduced end to end (a mock sensor able to drive a live mainnet defense, and the Guard trusting LLM-supplied arithmetic). See [FRICTION.md](FRICTION.md) for the write-ups.

## Chaos matrix

_(populated in Session 3 — scenarios: forced revert, invalid planner JSON, Critic reject, duplicate trigger, RPC timeout, daemon kill/resume, KeeperHub retry visibility)_

## Verified addresses

Every address in [src/config.ts](src/config.ts) was checked against the official [Aave Address Book](https://github.com/bgd-labs/aave-address-book) **and** confirmed on-chain (bytecode present; `Pool.getReservesList()` decoded over the public RPC) on 2026-07-30. Two easy-to-get-wrong entries worth calling out:

- Base mainnet USDC is native `0x8335…2913` — **not** bridged USDbC `0xd9aA…b6CA`.
- Base Sepolia USDC is the Aave market's faucet token `0xba50…4D5f` — **not** Circle's `0x036CbD…`.

The Base Sepolia Aave V3 market is live (6 reserves), so the Anvil-fork fallback in build guide §6.9 is likely unnecessary.

## Development

Spec: [docs/ripcord-build-guide.md](docs/ripcord-build-guide.md) · Strategy: [docs/ripcord-battle-plan.md](docs/ripcord-battle-plan.md) · KeeperHub API verification: [docs/keeperhub-verification.md](docs/keeperhub-verification.md) · Friction log: [FRICTION.md](FRICTION.md) · Evidence: [docs/evidence/EVIDENCE.md](docs/evidence/EVIDENCE.md)

Tests mirror `src/` under `test/`. The load-bearing ones are in [test/daemon/wiring.test.ts](test/daemon/wiring.test.ts): they drive a real daemon tick with a Planner and Critic that always want to spend, and assert the executor spy was never called. Unit-testing the Guard proves it says "no"; those prove the assembled daemon obeys it.
