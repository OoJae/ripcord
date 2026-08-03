# 🪂 Ripcord

[![ci](https://github.com/OoJae/ripcord/actions/workflows/ci.yml/badge.svg)](https://github.com/OoJae/ripcord/actions/workflows/ci.yml)

**Autonomous, MEV-aware liquidation protection for Aave V3 on Base — decisions by AI agents, execution guaranteed by [KeeperHub](https://keeperhub.com).**

When a DeFi position slides toward liquidation, every second and every mempool snoop matters. Ripcord watches your Aave V3 health factor, plans a defense with a Planner agent, forces an independent Critic agent to approve it, passes a deterministic safety Guard — and then lands the rescue transaction through KeeperHub with retries, smart gas, sponsorship, and a full audit trail — MEV-aware by design (see the routing analysis in docs/architecture.md).

> Most liquidations are slow-motion failures: a position drifts for hours while its owner sleeps — or, as in October 2025's $19B cascade, owners watched helplessly while the infrastructure they needed to defend themselves was down. Ripcord is the actor that stays awake and keeps acting. And for the failure mode that *isn't* slow — single-block oracle mispricings like Moonwell's $1.12 cbETH print (Feb 2026) or Aave's $27M CAPO glitch (Mar 2026) — no poller on earth out-races the block, but an agent with world knowledge can refuse to act on an absurd price and scream: that is Ripcord's oracle-sanity gate. Agents *decide*; Ripcord is how the rescue actually *lands*.

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
                                                              - simulate-first, idempotency keys
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
| Scheduled workflow (WF-1 `hf-monitor`) | Redundant monitoring intent — testnet, alert-only; its schedule trigger has never fired platform-side and its Telegram node needs a one-time integration (both in FRICTION.md) | ⚠️ [`8kcwzx7ycrg1zlqhox6tz`](workflows/wf1-hf-monitor.json) |
| Workflow execution API | Daemon triggers WF-2 via `POST /workflows/{id}/execute` | ✅ `src/executor/keeperhub.ts` |
| Run status API (`/status`, `/wait`) | Executor polls runs to a terminal state | ✅ every defense in [EVIDENCE.md](docs/evidence/EVIDENCE.md) |
| `web3/read-contract` in-workflow | WF-2 re-reads the position before it will write | ✅ [stale-decision refusal](docs/evidence/EVIDENCE.md) |
| `Condition` branching | The on-chain gate that decides whether the repay node runs | ✅ `sourceHandle: "true"` edge only |
| `web3/write-contract` | The defensive `Pool.repay` itself | ✅ [EVIDENCE.md](docs/evidence/EVIDENCE.md) |
| MCP server + Claude Code plugin | Position setup and workflow build/debug | ✅ [4 txs](docs/evidence/EVIDENCE.md) via `execute_contract_call` |
| Direct contract-call execution | Faucet mint, supply/borrow, right-sizing, capped approval | ✅ [`0x4cc001bf…`](https://sepolia.basescan.org/tx/0x4cc001bfaa7d268e73a71cb710f62f8d611c69aa4e8ea9f23ea4d48ba5e64be8) |
| Gas sponsorship | Every setup and defense tx, `sponsored: true` | ✅ all setup txs sponsored |
| Audit trail | `decisionId` threads log → SQLite → payload → execution → tx | ✅ one ULID end to end |
| Private routing | Ethereum-only (`/api/chains` proof); Base tradeoff documented, defense gains sponsorship instead | ✅ [architecture.md](docs/architecture.md) § MEV posture |
| Marketplace + x402 (WF-3 `risk-score`) | Paid risk scoring — **Ripcord pays for itself** | ✅ [`ripcord-risk-score`](https://app.keeperhub.com/api/mcp/workflows) $0.02/call, 2 paid x402 calls settled to the org wallet |

## Transactions

| # | What | Chain | Tx | KeeperHub run |
|---|---|---|---|---|
| 1 | **Hero: autonomous defensive repay — gas-sponsored, full audit trail** | Base mainnet | [`0x6e314ece…9cd05`](https://basescan.org/tx/0x6e314ece3f28df705ce60d62bdcb130b46013aa1b919f6b5efb91dd335e9cd05) | `deqcbg6pwj968qlvqmri5` |
| 2 | Gas-sponsored setup ×5 (wrap → approve → supply → borrow → capped approval) | Base mainnet | [`0x1d43a6bc…1a29`](https://basescan.org/tx/0x1d43a6bc19684d7e68f045a88a4a390c539df9acdc90b3a4f17b197f8a8b1a29) +4 | [EVIDENCE.md](docs/evidence/EVIDENCE.md) |
| 3 | 3 consecutive autonomous testnet defenses | Base Sepolia | [`0xf1f52639…`](https://sepolia.basescan.org/tx/0xf1f526390d4c2bee7cf8bc16fe103f35563d72cc40e92ccfc0b7ded8b8aab176) +2 | [EVIDENCE.md](docs/evidence/EVIDENCE.md) |
| 4 | Paid x402 calls to `ripcord-risk-score` ($0.05 ×2 → our own wallet; the two calls settled at the original $0.05 price, since [repriced to $0.02](workflows/wf3-risk-score.json)) | Base mainnet | [`0xb9ddfd5a…c72e`](https://basescan.org/tx/0xb9ddfd5ab4f1231d834cc2007bfdbd218992723d0ee12dd3581b863590d0c72e), [`0x2850f226…02ca`](https://basescan.org/tx/0x2850f2266a37e92acab6bd645c8bdc922d4df06120f31d4cd71870dcf8f302ca) | `z08itkcc…`, `dr3891lm…` |

Private routing is **not available on Base** (KeeperHub `/api/chains`: Flashbots
Protect on Ethereum only) — the hero tx runs public-route with the tradeoff
analysed in [docs/architecture.md](docs/architecture.md), and gains sponsorship
in exchange (private-mempool txs are never sponsored).

## Quickstart (works in under a minute, zero secrets)

```bash
pnpm install
pnpm dev                  # no .env needed — full decision loop in mock mode, DRY_RUN on
pnpm status               # current HF, recent decisions, recent runs, spend vs cap
pnpm test                 # 322 offline tests
pnpm web:dev              # the brand site (web/ — see docs/brand/BRAND.md)
```

With no `.env` at all, Ripcord runs a **mock demo**: a scripted health-factor descent drives the full Sense → Policy → Plan → Critique → Guard → (dry-run) Execute pipeline, every stage logged under one `decisionId`. Real output from `pnpm dev`:

```
🪂 RIPCORD starting — chain: base-sepolia · chain reads: MOCK · brain: HEURISTIC ·
   executor: MOCK · alerts: log-only · DRY_RUN: ON · RIPCORD_ARM: 0 · caps: $15/tx · $30/24h
band=healthy hf=1.82  shouldDefend=false
band=warn    hf=1.4557 shouldDefend=false
band=act     hf=1.2129 shouldDefend=true  "act: armed and cooldown elapsed — defend"
guard=dry-run violations=[] checks=15
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
| `RIPCORD_MODE` | `advisory` (recommend only) · `copilot` (hold for approval; panic still auto-fires) · `autopilot` (default) |
| `RIPCORD_CANCEL_WINDOW_SEC` | Autopilot act-band cancel window — "defending in Ns unless cancelled". Panic skips it |
| `MIN_WALLET_RESERVE_USD` | Refuse a defense that would leave the wallet below this floor |
| `RIPCORD_WARN_HF` / `RIPCORD_ACT_HF` / `RIPCORD_PANIC_HF` / `RIPCORD_TARGET_HF` / `RIPCORD_REARM_HF` / `RIPCORD_COOLDOWN_SEC` | Per-position policy tuning (defaults 1.5 / 1.25 / 1.1 / 1.6 / 1.55 / 1800s). Ordering is validated at startup — panic < act < warn ≤ rearm < target — because a nonsensical layout silently breaks hysteresis |

`KEEPERHUB_DEFEND_WEBHOOK_URL` is WF-2's trigger endpoint —
`https://app.keeperhub.com/api/workflows/<WF-2 id>/execute`. Use the `/execute`
endpoint with your org `kh_` key; the sibling `/webhook` endpoint requires a
separately-minted user webhook key (`wfb_*`). Details in
[`workflows/README.md`](workflows/README.md).

Even with all four set, `DRY_RUN=true` (the default) still holds fire — the Guard
evaluates every rule and reports the payload it *would* have sent. Turning off
DRY_RUN on Base mainnet additionally requires `RIPCORD_ARM=1`, and the config
refuses to start half-armed.

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
- Capped, revocable USDC approval; kill switch: Ctrl-C stops the daemon cleanly (finishes the in-flight tick, releases the single-instance lock). WF-1 is a redundant-monitoring *intent*, not a live fallback — its schedule trigger has never fired platform-side (see the surfaces table and FRICTION.md), so it does not keep watching after the daemon stops.

The safety design was reviewed adversarially: 22 candidate findings across four independent lenses, each then double-verified by a skeptic prompted to refute it. Seven survived and all are fixed — including two the review reproduced end to end (a mock sensor able to drive a live mainnet defense, and the Guard trusting LLM-supplied arithmetic). See [FRICTION.md](FRICTION.md) for the write-ups.

## Chaos matrix

Every scenario from build guide §7.6, run against the real daemon on Base Sepolia (never rehearsed in prod). Each ✅ links to a captured artifact.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Forced on-chain revert → recorded `error`, later retry succeeds | ✅ real, unstaged | [EVIDENCE.md](docs/evidence/EVIDENCE.md) — allowance revert `7wnw3uuch…` → retry [`0xf1f52639…`](https://sepolia.basescan.org/tx/0xf1f526390d4c2bee7cf8bc16fe103f35563d72cc40e92ccfc0b7ded8b8aab176) |
| 2 | Planner emits invalid JSON → schema reject → **no tx even in panic band** | ✅ | [chaos-planner-invalid-json.log](docs/evidence/logs/chaos-planner-invalid-json.log) — live daemon, stubbed garbage LLM, `planner output invalid — fail-safe no-action` on every eligible tick incl. panic |
| 3 | Critic REJECT → no tx | ✅ real, live | [critic-reject-rounding.log](docs/evidence/logs/critic-reject-rounding.log) — the REJECT that caught our own rounding bug |
| 4 | Duplicate trigger → idempotency holds | ✅ | Replayed POST with the same `Idempotency-Key` returned the **same executionId** (adopted: `triggerDefense` sends `decisionId` as the key); plus the [panic-restart wiring proof](test/daemon/wiring.test.ts) where Guard idempotency is the only remaining barrier |
| 5 | RPC unreachable → 3 retries with backoff → tick skipped cleanly | ✅ | [chaos-rpc-unreachable.log](docs/evidence/logs/chaos-rpc-unreachable.log) |
| 6 | Daemon SIGKILLed mid-cycle → restart resumes from SQLite | ✅ | [chaos-sigkill-restart.log](docs/evidence/logs/chaos-sigkill-restart.log) — bonus: the kill orphaned a live child and the **single-instance lock refused a second daemon** ([chaos-single-instance-lock.log](docs/evidence/logs/chaos-single-instance-lock.log)); stale takeover + cooldown rehydration after |
| 7 | KeeperHub run polling/backoff ladder observable in logs | ✅ | `run poll (backoff ladder)` info lines (2s → ×1.5 → 15s cap), pinned by [keeperhub.test.ts](test/executor/keeperhub.test.ts) and visible in every live defense log |

## Verified addresses

Every address in [src/config.ts](src/config.ts) was checked against the official [Aave Address Book](https://github.com/bgd-labs/aave-address-book) **and** confirmed on-chain (bytecode present; `Pool.getReservesList()` decoded over the public RPC) on 2026-07-30. Two easy-to-get-wrong entries worth calling out:

- Base mainnet USDC is native `0x8335…2913` — **not** bridged USDbC `0xd9aA…b6CA`.
- Base Sepolia USDC is the Aave market's faucet token `0xba50…4D5f` — **not** Circle's `0x036CbD…`.

The Base Sepolia Aave V3 market is live (6 reserves), so the Anvil-fork fallback in build guide §6.9 is likely unnecessary.

## Development

Spec: [docs/ripcord-build-guide.md](docs/ripcord-build-guide.md) · Strategy: [docs/ripcord-battle-plan.md](docs/ripcord-battle-plan.md) · KeeperHub API verification: [docs/keeperhub-verification.md](docs/keeperhub-verification.md) · Friction log: [FRICTION.md](FRICTION.md) · Evidence: [docs/evidence/EVIDENCE.md](docs/evidence/EVIDENCE.md)

Tests mirror `src/` under `test/`. The load-bearing ones are in [test/daemon/wiring.test.ts](test/daemon/wiring.test.ts): they drive a real daemon tick with a Planner and Critic that always want to spend, and assert the executor spy was never called. Unit-testing the Guard proves it says "no"; those prove the assembled daemon obeys it.
