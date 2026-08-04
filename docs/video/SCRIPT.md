# Ripcord — demo film script

**Format** 16:9 · **Target length** ~2:30 · **Delivery** measured, dry, unhurried.
Not hype-read. The numbers do the selling; the voice stays calm.

**Angle:** the site's own dramaturgy — freefall, the pull, under canopy.
**Rule followed throughout:** every figure is sourced (`web/src/data/telemetry.ts`).
The hero run logged **12/12** checks against the Guard *as it stood that day*;
the Guard is **14 rules** today. The VO never conflates the two.

---

## Paste-ready voice-over (Clipchamp)

Numerals are spelled the way they should be *spoken* — paste as-is so the TTS
doesn't mangle them. Blank lines are section breaks; let each land before the
next begins.

> **Pronunciation:** "Aave" = *AH-vay*. "x402" = *x four-oh-two*.
> If your voice model stumbles on either, swap in the phonetic spelling.

```
Every DeFi loan has one number that matters. Health factor. When it touches
one point zero, your collateral gets sold — by a stranger, at a discount,
automatically.

Most liquidations aren't lightning strikes. They're slow leaks. A position
drifting for hours while its owner sleeps. And in October twenty twenty-five,
when nineteen billion dollars liquidated in a single cascade, plenty of owners
were wide awake — locked out of the infrastructure they needed to save
themselves.

Watching is not protection.

Ripcord is the part that acts. Autonomous liquidation protection for Aave V3
on Base.

On the first of August, a real position on Base mainnet slid to one point two
four. No human was involved in what happened next.

Ripcord read the chain. Drafted a defense. Made a second model argue with the
first. Cleared the Guard — zero violations. Then repaid six dollars and
seventy-eight cents of debt through a KeeperHub workflow.

Twenty-one seconds, from sensing the danger to the transaction landing. Gas
sponsored. Health factor: one point six oh.

That transaction is on Base. Go and read it.

Here's how it works. A sensor reads the position, then cross-checks Aave's own
oracle against Chainlink. Because the worst liquidations of twenty twenty-six
weren't drift. They were bad prices. Ripcord refuses to act on one.

A planner proposes exactly one action. An independent critic has to approve it.
Neither model is trusted with anything — they can't so much as name an address.

Then the Guard. Fourteen deterministic rules that re-derive every number the
models claimed. It can veto them both. Nothing vetoes the Guard.

And you choose how much rope it gets. Advisory only recommends. Co-pilot waits
for your yes. And autopilot acts on its own — but give it a cancel window and it
announces the defense first, then waits for you to stop it.

Except in panic. An unreachable owner shouldn't become a liquidation.

Ripcord also sells its own risk engine on the KeeperHub marketplace. Another
agent paid for it in USDC — settling into the same wallet Ripcord defends.

Three hundred and twenty-two tests. Every write behind the Guard. One real save
on record.

Ripcord. Pull before the drop.
```

---

## Timed breakdown + shot list

Durations assume ~150 wpm. Treat the timecodes as targets — once you send the
real audio I retime every scene to the actual waveform, not to this table.

| # | T (est.) | Dur | Line (opening words) | On screen |
|---|---|---|---|---|
| 01 | 0:00 | 0:13 | "Every DeFi loan has one number…" | Black. The altimeter alone, mono, ticking down. Type-only. No UI yet. |
| 02 | 0:13 | 0:22 | "Most liquidations aren't lightning strikes…" | Live site hero — the streamer falling. Slow push. "$19B / Oct 2025" as a mono stat, quiet. |
| 03 | 0:35 | 0:04 | "Watching is not protection." | Hard cut to black. One line of display type. Full stop. |
| 04 | 0:39 | 0:08 | "Ripcord is the part that acts…" | Wordmark resolve — the rip closing. Then hero headline. |
| 05 | 0:47 | 0:12 | "On the first of August…" | Site scroll: the descent, 1.60 → 1.50 → 1.25. Altimeter in frame. |
| 06 | 0:59 | 0:20 | "Ripcord read the chain…" | **THE PULL.** Canopy blooms. Then the receipt card builds row by row. |
| 07 | 1:19 | 0:09 | "Twenty-one seconds…" | Three stat hits, staggered: 21s sense→landed · sponsored · 1.6028 (phosphor). |
| 08 | 1:28 | 0:05 | "That transaction is on Base…" | Real Basescan page for `0x6e314ece…9cd05`. Success + tx hash highlighted. |
| 09 | 1:33 | 0:18 | "Here's how it works. A sensor reads…" | Terminal: live `pnpm dev` decision loop. Oracle cross-check line called out. |
| 10 | 1:51 | 0:13 | "A planner proposes exactly one action…" | Planner JSON → Critic APPROVE, side by side. Two voices arguing. |
| 11 | 2:04 | 0:13 | "Then the Guard…" | The 14 rule chips stamping in, staggered. Then a real BLOCKED line in red. |
| 12 | 2:17 | 0:16 | "And you choose how much rope…" | The three mode cards. Cancel-window notice ticking. |
| 13 | 2:33 | 0:06 | "Except in panic…" | Panic band. Orange floods. Overrides everything. |
| 14 | 2:39 | 0:11 | "Ripcord also sells its own risk engine…" | Marketplace listing + the paid x402 tx. |
| 15 | 2:50 | 0:12 | "Three hundred and twenty-two tests…" | Three closing facts, quiet. Then wordmark + live URL. |

> Running long at ~3:00 with beats. **Trim levers, in order:** drop scene 13's
> separate beat (fold panic into 12) → tighten 02 by one sentence → cut "Go and
> read it." If you want a hard 2:00, say so and I'll cut scenes 10 and 14.

---

## Direction notes

- **One loud moment.** Scene 06 is the film's pull — everything before it is
  restrained so it can hit. Nothing after it competes.
- **No scattered motion.** Each scene gets one gesture. If a scene has two
  ideas, it becomes two scenes or loses one.
- **Type carries it.** Clash Display for statements, Space Mono for every
  measurement. Same rule as the site: if it's a number, it's mono.
- **Real footage only.** Captured from the live URL, a real terminal, and real
  Basescan — no mocked-up screens, no invented numbers.
- **Silence is allowed.** Scenes 03 and 08 should breathe with no VO under them.

## Numbers used, and where they come from

| Claim | Source |
|---|---|
| HF 1.2400 → 1.6028, $6.78 repay, gas sponsored | `docs/evidence/EVIDENCE.md:226-261` |
| **21s sense→landed** (tick 22:32:58 → run success 22:33:19). NOT 10.7s — that is the KeeperHub run's internal repay→confirm time (EVIDENCE.md:254) and mislabelling it was a real QA finding | `EVIDENCE.md:233,242,254` |
| Guard cleared with zero violations on that run (12/12 that day) | same |
| 14 deterministic Guard rules today | `src/guard/guard.ts` |
| Bands 1.50 / 1.25 / 1.10, target 1.60 | `src/config.ts:17-24` |
| Mode behaviour. NB: the cancel window is opt-in (`RIPCORD_CANCEL_WINDOW_SEC` defaults to 0), so the VO says "give it a cancel window" rather than claiming it always announces | `src/approval/gate.ts:10-19`, `src/config.ts` |
| Paid x402 calls into the defended wallet | `docs/evidence/EVIDENCE.md:263-304` |
| 322 tests | `pnpm test` |
| Oct 2025 $19B cascade | `README.md:9` |
