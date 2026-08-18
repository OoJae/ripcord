# Finalist presentation — runbook

**Call: Wednesday Aug 19 2026, 11:00 AM WAT** (the invite's "12:00 PM CEST sharp" = 11:00 in Lagos).
Google Meet: `meet.google.com/ncp-wyny-bwf`. 5 minutes + judge Q&A. Two breakout rooms after the main call.

## Before the call (in order)

1. **Rotate the KeeperHub org key** — app.keeperhub.com → avatar → API Keys → Organisation.
   You are about to screen-share; the current key is long-lived, uncapped, and can sign for
   the org wallet. Update `.env` after, verify with `pnpm status`.
2. RSVP **Yes** on the calendar invite if you haven't.
3. Quit Telegram, mail, WhatsApp — anything that can pop a notification over the share.
4. Join at **10:50**, camera on, deck already running.

## Running the deck

```bash
cd presentations/finalist-deck
npm run dev        # starts the presenter server (http://localhost:3004)
```

- Open the printed URL. Click the **Present icon** in the bottom-right capsule (or press **P**).
  A second tab opens — that is the **audience** tab; your original tab becomes the
  **presenter view** (current + next slide, editable notes, elapsed timer).
- **In Meet: Share screen → “A tab” → pick the audience tab**, then switch back to your
  presenter tab. Chrome keeps a shared tab rendering in the background.
  Never share “A window” or “Entire screen” — one freezes for viewers, the other shows your notes.
- **→ / Space** advances (fragments first, then the next slide). **←** goes back one slide.
- Notes are editable in the presenter view and persist locally — tweak wording tonight if
  you rehearse; the file stays untouched.

**Fallback:** `ripcord-finalist-deck.pdf` in this folder — all 10 slides, fully revealed.
If the server or Chrome misbehaves mid-call, share the PDF and keep talking; the talk
track below works over it unchanged.

## The 5-minute track (notes are also in the deck)

| # | Slide | Window | The one thing to land |
|---|---|---|---|
| 1 | Title | 0:00–0:20 | Built solo; everything shown is on mainnet and auditable. |
| 2 | The problem | 0:20–1:05 | Slow leaks; Oct 2025 $19B; **watching is not protection**. |
| 3 | Two models argue | 1:05–1:45 | Planner proposes, Critic must APPROVE, the Guard — code, not a model — can veto both. |
| 4 | The save | 1:45–2:20 | **Slow down.** 1.2400 → 1.6028, $6.78, 21 seconds, unattended. |
| 5 | The receipt | 2:20–2:35 | Basescan, unretouched. Let them read for a beat. |
| 6 | The Guard | 2:35–3:20 | Nothing the models say is trusted; oracle-sanity gate (Moonwell, CAPO). |
| 7 | KeeperHub | 3:20–3:50 | The workflow re-reads the chain before it will act; gas sponsored throughout. |
| 8 | Pays for itself | 3:50–4:20 | A zero-ETH agent paid; revenue lands in the defended wallet; verifiable via HTTP 402. |
| 9 | What broke | 4:20–4:50 | The reviews found real bugs; all pinned by regression tests; FRICTION.md is public. |
| 10 | Close | 4:50–5:00 | "Agents decide. Ripcord is how the rescue lands." Stop. Breathe. |

## Q&A crib sheet

**Why only $6.78?** Sized by policy, not by the model: repay exactly enough to lift HF to the
1.6 target, inside MAX_TX_USD ($15) and the daily cap ($30). The Guard re-derives the figure
before it passes.

**What if the LLM hallucinates?** Invalid planner output → fail-safe no-action, recorded as
`planner_invalid`. A Critic that errors is treated as REJECT — there is no path where the
absence of an approval becomes an approval. And neither model can name an address; addresses
exist only in an allowlisted config.

**Why can't judges fire a live write?** The one deployed workflow that could execute directly
bypassed every daemon-side control — DRY_RUN, the arm flag, the caps, all Guard rules. An
adversarial review round caught it and I disabled it, because shipping an un-Guarded mainnet
write would contradict the claim the project is built on. Full story in FRICTION.md.

**What's "MEV-aware" on Base?** Honest version: KeeperHub's private routing is Ethereum-only
today (`/api/chains` proof in the repo). On Base the defense runs public-route with protective
sizing and timing, and gains gas sponsorship in exchange. Documented tradeoff, not a gloss.

**How is this different from DeFi Saver-style automation?** Two things. The trust
architecture — two models argue, deterministic code decides, and the whole decision trail is
published. And the agent economy — the risk engine earns USDC from another agent via x402
into the very wallet it defends. The incumbents' flash-loan repay-from-collateral funding is
the real gap: architected in `src/risk/funding.ts`, deliberately not built in hackathon time.

**What if KeeperHub is down / the run fails?** The daemon polls the run to completion on a
backoff ladder; a failed or unconfirmed run is recorded, alerts via Telegram, and the position
is re-sensed next tick. Fail-closed: no workflow, no write.

**What if the price feed is wrong?** That's the oracle-sanity gate: Aave's oracle is
cross-checked against Chainlink and divergence blocks action. 2026's worst liquidations were
bad prices (Moonwell's $1.12 cbETH print, Aave's $27M CAPO glitch) — no poller out-races a
block, but an agent can refuse to act on an absurd price.

**Who holds the keys?** KeeperHub's org wallet (Turnkey). The daemon holds none — viem is
reads-only, and the only write path is the webhook workflow.

**Is the 21 seconds real?** Log timestamps 22:32:58 (act band) → 22:33:19 (run success),
three-way reconciled: Basescan receipt, KeeperHub execution record (10.7 s inside the
workflow), and the local SQLite decision row. Tx `0x6e314ece…9cd05`.

**Multi-position? Other chains?** Single position, single asset, single chain — by choice.
Portfolio logic and session-key custody are architecture, not sprint work, and I stopped
feature work three days before the deadline rather than destabilize a working system.

**Numbers, memorized:** HF 1.2400 → 1.6028 · $6.78 · 21 s · gas 184,531 sponsored ·
12/12 checks then, 14 rules now · 322 tests · 22 + 31 findings · two paid calls at $0.05
($0.10 revenue, buyer held zero ETH) · listing live today at $0.02/call.
