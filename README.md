# 🪂 Ripcord

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
| Webhook-triggered workflow (WF-2 `defend`) | Daemon triggers the defense tx | _(Session 2)_ |
| Scheduled workflow (WF-1 `hf-monitor`) | Redundant HF monitoring even if the daemon dies | _(Session 2)_ |
| Run status API (`/wait`, `/status`) | Executor polls runs to terminal state | implemented in `src/executor/keeperhub.ts` |
| MCP server + Claude Code plugin | Workflow build/debug during development | _(Session 2)_ |
| Smart gas + retries | Defense tx reliability | _(Session 2)_ |
| Private routing (mainnet defenses) | MEV protection for the rescue | _(Session 3)_ |
| Gas sponsorship (setup txs) | Public-mempool setup txs | _(Session 3)_ |
| Audit trail | Proof: trigger → simulation → tx → outcome | _(Session 2)_ |
| Marketplace + x402 (WF-3 `risk-score`) | Paid risk scoring — Ripcord pays for itself | _(Session 4)_ |

## Transactions

| # | What | Chain | Tx | KeeperHub run |
|---|---|---|---|---|
| 1 | Hero: private-routed defensive repay | Base mainnet | _(Session 3)_ | |
| 2 | Gas-sponsored setup (capped approval) | Base mainnet | _(Session 3)_ | |
| 3 | Paid x402 call to risk-score workflow | Base | _(Session 4)_ | |

## Quickstart (testnet, <10 min)

```bash
pnpm install
cp .env.example .env      # fill in what you have — everything is optional for mock mode
pnpm dev                  # zero secrets → full decision loop in mock mode, DRY_RUN on
pnpm status               # current HF, recent decisions, recent runs
pnpm test                 # offline test suite
```

With no `.env` at all, Ripcord runs a **mock demo**: a scripted health-factor descent triggers the full Sense → Plan → Critique → Guard → (dry-run) Execute pipeline, with every stage logged under one `decisionId`. Add `MONITORED_ADDRESS` (public Base Sepolia RPC is the default) for live Aave reads; add `ANTHROPIC_API_KEY` for LLM planning; add `KEEPERHUB_DEFEND_WEBHOOK_URL` + `KEEPERHUB_API_KEY` for real execution.

## Safety design

- **DRY_RUN=true by default.** Mainnet writes additionally require `RIPCORD_ARM=1` — provably: with `RIPCORD_ARM=0` nothing can reach the executor in mainnet mode (wiring-level test).
- **All onchain writes go through KeeperHub.** viem is reads-only.
- **Hard caps** (`MAX_TX_USD`, `DAILY_CAP_USD` over a rolling 24h) enforced in a deterministic Guard, in integer cents.
- **Addresses come only from the config allowlist** — LLM output containing any raw address is rejected outright.
- **No Critic APPROVE → no execution. Ever.** The Guard overrides both LLM agents.
- **Idempotency by decisionId** (ULID), backstopped by a SQLite UNIQUE constraint.
- Capped, revocable USDC approval; kill switch: Ctrl-C stops the daemon while WF-1 monitoring survives.

## Chaos matrix

_(populated in Session 3 — scenarios: forced revert, invalid planner JSON, Critic reject, duplicate trigger, RPC timeout, daemon kill/resume, KeeperHub retry visibility)_

## Development

Spec: [docs/ripcord-build-guide.md](docs/ripcord-build-guide.md) · Strategy: [docs/ripcord-battle-plan.md](docs/ripcord-battle-plan.md) · Friction log: [FRICTION.md](FRICTION.md) · Evidence: [docs/evidence/EVIDENCE.md](docs/evidence/EVIDENCE.md)
