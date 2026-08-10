# DoraHacks submission — Ripcord

Ready to paste. Every link below was checked live on 2026-08-10.

---

## Links

| | |
|---|---|
| **Live site** | <https://oojae.github.io/ripcord/> |
| **Repo** | <https://github.com/OoJae/ripcord> |
| **Demo film** (2:20) | [`docs/video/ripcord-demo.mp4`](video/ripcord-demo.mp4) |
| **The save, on-chain** | [`0x6e314ece…9cd05`](https://basescan.org/tx/0x6e314ece3f28df705ce60d62bdcb130b46013aa1b919f6b5efb91dd335e9cd05) |
| **Paid marketplace listing** | `ripcord-risk-score` — verify with the curl below |
| **Evidence trail** | [EVIDENCE.md](evidence/EVIDENCE.md) · [FRICTION.md](../FRICTION.md) |

---

## One-paragraph pitch

Ripcord is an autonomous, MEV-aware liquidation-protection agent for Aave V3 on
Base. It watches a position's health factor, drafts a defense with one model,
forces an independent second model to approve it, clears fourteen deterministic
Guard rules that re-derive every number the models claimed, and lands the rescue
through a KeeperHub workflow that re-reads the chain before it will write. On
1 August 2026 it did exactly that, unattended, on mainnet: health factor 1.2400
→ 1.6028, $6.78 repaid, gas sponsored, twenty-one seconds from sensing the
danger to the transaction landing. Agents *decide*; Ripcord is how the rescue
actually *lands*.

---

## For judges — three ways in, no setup required

**1. Watch it (0 min).** The [demo film](video/ripcord-demo.mp4), or scroll the
[live site](https://oojae.github.io/ripcord/) — the page is the descent, and the
altimeter replays the real telemetry from the mainnet save.

**2. Run it (1 min, zero secrets, no keys, no wallet).**

```bash
git clone https://github.com/OoJae/ripcord.git && cd ripcord
pnpm install
pnpm dev     # full decision loop in mock mode, DRY_RUN on
pnpm test    # 322 offline tests
```

With no `.env` at all, `pnpm dev` drives a scripted health-factor descent through
the entire Sense → Policy → Plan → Critique → Guard → Execute pipeline, every
stage logged under one ULID. You will watch it reach the act band, pass all 15
safety checks, and hold fire because DRY_RUN is on. Set `CHAIN=base` and the same
run is *blocked* by `arm-flag` instead — including in the panic band, because
panic overrides the cooldown and the latch but never the arm.

**3. Verify the paid listing (no account needed).** An unpaid call returns the
x402 challenge:

```bash
curl -s -X POST https://app.keeperhub.com/api/mcp/workflows/ripcord-risk-score/call \
  -H 'content-type: application/json' \
  -d '{"address":"0x30C8A36e99f0708c3e3301b1Ed99cf418BDCf27a"}' | jq .accepts
```

HTTP **402**, `maxAmountRequired: "20000"` ($0.02 USDC), `network: eip155:8453`,
and `payTo: 0x30c8a36e…f27a` — **the same wallet the daemon defends**. That one
field is the "pays for itself" claim, verifiable in a single command.
(The catalog is paginated across 114 listings, so query the slug directly rather
than browsing for it.)

---

## KeeperHub surfaces used

Webhook-triggered workflow (the only path that moves money) · workflow execution
API · run-status polling with a backoff ladder · `web3/read-contract` for the
in-workflow re-read · `Condition` branching as the on-chain gate ·
`web3/write-contract` for the repay · gas sponsorship on every transaction ·
direct contract-call execution for position setup · MCP server + Claude Code
plugin · the marketplace with x402 payments. Full table with evidence links in
the [README](../README.md).

---

## What makes it different

**Two models argue; deterministic code decides.** The Planner proposes one action
with one amount; an independent Critic must return an explicit APPROVE; then the
Guard re-derives everything and can veto them both. Neither model can name an
address — addresses exist only in an allowlisted config.

**An oracle-sanity gate.** 2026's worst liquidations were not slow drift, they
were bad prices (Moonwell's $1.12 cbETH print, Aave's $27M CAPO glitch). No
poller out-races a block, but an agent can *refuse to act on an absurd price*.
Ripcord cross-checks Aave's oracle against Chainlink and blocks on divergence.

**Interruptibility.** Three modes — advisory recommends, co-pilot waits for your
yes, autopilot acts but can announce a cancel window. Their failure postures are
opposite on purpose: consent fails closed, autonomy fails open. Panic overrides
all three.

**It pays for itself.** The risk engine is listed on the marketplace; another
agent — holding zero ETH — paid for two calls in USDC that settled into the
position Ripcord defends.

---

## Honest limitations (stated up front)

- **Defenses are funded from wallet USDC**, not from the position. The
  flash-loan repay-from-collateral path every incumbent uses is architected and
  documented in `src/risk/funding.ts`, not built — the funding ladder reports
  what it can see but cannot spend, so the daemon never overstates its capacity.
- **Private transaction routing is Ethereum-only** on KeeperHub today
  (`/api/chains` proof in the repo), so the Base defense runs public-route and
  gains gas sponsorship in exchange. Analysed in `docs/architecture.md`.
- **Judges cannot trigger a live write.** The execution workflow is deliberately
  disabled: it bypassed the daemon's Guard, and shipping an un-Guarded mainnet
  write would contradict the safety claim this project is built on. You can see
  the full evidence of an autonomous defense; you cannot fire one.
- **WF-1's scheduled monitor has never fired platform-side** — recorded in
  FRICTION.md rather than quietly dropped.

---

## The thing I'd most like read

[FRICTION.md](../FRICTION.md) — a dated log of everything that broke, including
our own bugs. Two adversarial review rounds (22 and 31 candidate findings, each
independently refuted before it counted) found real defects in this codebase:
a mock sensor that could drive a live mainnet defense, a Guard trusting
LLM-supplied arithmetic, an RPC key leaking into a third-party prompt, a human
veto that lasted exactly one tick, and a back button that left the site under a
full-screen orange rectangle. All fixed, each pinned by a regression test that
fails against the pre-fix code.

The safety architecture is the product. The record of it catching its own
mistakes is the evidence that it works.
