# Ripcord architecture

Autonomous MEV-aware liquidation protection for Aave V3 on Base, executed through
KeeperHub. This document explains the trust design; the README covers usage.

## The loop

```
        ┌──────────────────────────────  every 60s  ─────────────────────────────┐
        │                                                                        │
  ┌─────▼─────┐   ┌────────┐   ┌─────────┐   ┌─────────┐   ┌───────┐   ┌─────────▼─────────┐
  │  SENSOR   │──▶│ POLICY │──▶│ PLANNER │──▶│ CRITIC  │──▶│ GUARD │──▶│ EXECUTOR          │
  │ viem read │   │ bands  │   │  (LLM)  │   │  (LLM)  │   │ 15    │   │ KeeperHub WF-2    │
  │ mainnet/  │   │ wad    │   │ proposes│   │ APPROVE │   │ rules │   │ re-reads chain,   │
  │ testnet   │   │ bigint │   │ ONE act │   │ or veto │   │ deter-│   │ gates, repays     │
  └───────────┘   └────────┘   └─────────┘   └─────────┘   │ minist│   └───────────────────┘
                                                           └───────┘        │
                 SQLite (decisions · executions · daemon_lock) ◀── record ──┘
                 Telegram ◀── notify                            one ULID decisionId end to end
```

**Deterministic code computes; agents judge.** Health-factor arithmetic lives in
`src/agents/hf-math.ts` and is quoted to both models as VERIFIED FIGURES. The
Planner proposes, the independent Critic must APPROVE, and the deterministic
Guard re-derives everything it can from raw inputs. Live incidents that shaped
this: a model claimed HF 6.41 against a true 5.01 (blocked by `hf-claim-honesty`),
and our own rounding produced a plan landing at 1.5999 (blocked by the Critic).

## Trust boundaries

| Boundary | Rule | Enforced by |
|---|---|---|
| LLM → transaction | No address, selector, or target from model output, ever | schema regex sweep + Guard allowlist rule + `buildDefensePayload` resolves from `src/config.ts` only |
| Daemon → chain | viem is read-only; ALL writes go through KeeperHub | no signing code exists in the repo |
| Daemon → workflow | Flat 9-field `DefensePayload`, `Idempotency-Key: decisionId` | `HttpKeeperHubClient.triggerDefense` |
| Workflow → chain | WF-2 re-reads the position itself and gates on its OWN rules | gate: chain binding, HF < warn, ≤ 60 USDC — "a limit the daemon cannot talk its way past" |
| Config → startup | Refuse half-armed mainnet, mock-sensor+live-executor, MAX_TX_USD above WF-2's ceiling, second daemon instance | `loadConfig` throws + `daemon_lock` |

## The three-outcome defense contract

A KeeperHub run ending `success` is **not** proof money moved — WF-2's gate can
decline and the run still succeeds, having done nothing. The transaction hash is
the only honest evidence:

| Outcome | run state | txHashes | Recorded as | Latch |
|---|---|---|---|---|
| Defended | `success` | 1 hash | `executed` | opened (re-arms above 1.55) |
| Declined by gate | `success` | `[]` | `blocked` | stays armed |
| Reverted/errored | `error` | `[]` | `failed` | stays armed, cooldown rate-limits the retry |

Both non-landed outcomes leave the hysteresis latch armed — disarming on intent
rather than evidence once left a live position undefendable (FRICTION.md,
2026-08-01) — while `markDefenseAttempted` still anchors the cooldown so a
failing defense retries once per cooldown, not every tick.

## Chain binding

One daemon config points at one workflow URL, and both ends check the pairing:
`loadConfig` refuses caps the workflow would decline, and each defend workflow's
gate requires the payload's `chain` field to match its own chain (`"base" ==
"base-sepolia" → false` was proven live). A daemon pointed at the wrong chain's
workflow produces a declined run recorded honestly as `blocked` — never a
cross-chain transaction.

## MEV posture (the private-routing tradeoff, documented)

The build guide called for private routing on mainnet defenses. **It is not
available on Base, and we can prove it**: KeeperHub's `GET /api/chains` exposes
`usePrivateMempoolRpc` — "whether KeeperHub routes transactions through a private
mempool (Flashbots Protect) by default" — and exactly two chains have it enabled:
Ethereum mainnet (1) and Ethereum Sepolia (11155111). Base (8453) is `false`;
the per-node `usePrivateMempool` field is inert there, so WF-2-mainnet does not
carry it.

Why this is acceptable rather than merely unavoidable:

1. **Base has no public P2P mempool to be front-run from.** Transactions go
   directly to the sequencer over RPC; there is no pre-confirmation gossip layer
   equivalent to Ethereum's, which is exactly the surface Flashbots Protect
   exists to bypass. The threat model private routing addresses is structurally
   diminished on an OP-stack L2.
2. **A defensive self-repay has no extractable surface.** `Pool.repay` moves the
   wallet's own USDC into its own debt at a protocol-fixed rate: no slippage, no
   price impact, nothing to sandwich. The MEV-relevant party is the *liquidator
   racing us* — and the mitigation for that is being early (warn-band
   pre-staging, 60s polling, act at 1.25 vs liquidation at 1.0), not routing.
3. **No private route ⇒ no sponsorship conflict.** KeeperHub sponsorship excludes
   private-mempool transactions; because Base defenses are public-route, the hero
   tx itself was **gas-sponsored** (`executedCall.sponsored: true`, paymaster
   `0x5af5194b…f07d` on the receipt) — a surface Ethereum-routed defenses give up.

On Ethereum mainnet, Ripcord would inherit private routing automatically — it is
a server-side per-chain default, not a code path we lack.

## Single-instance lock

`daemon_lock` (SQLite, one row, pid + heartbeat, transactional acquire) makes a
second daemon die at startup. SQLite serializes writes, but two daemons mint
distinct decisionIds, so per-decision idempotency cannot see across instances —
both could clear the cooldown check and defend the same event twice. Observed in
the wild (four accidental daemons on 2026-08-01), then made impossible. A stale
lock (crashed holder) is taken over after 3 poll intervals.

## Evidence discipline

Every decision carries a ULID threaded through logs → SQLite → webhook payload →
KeeperHub execution → Telegram. The hero tx reconciles three ways on one id:
Basescan receipt ↔ KeeperHub audit trail ↔ SQLite rows
(`01KYZKX5R00C9F8D6G3ZS55CE0` → `deqcbg6pwj968qlvqmri5` → `0x6e314ece…9cd05`).
