# Ripcord — Complete Build Guide

Everything to build, in order, with acceptance criteria — from empty folder to submitted BUIDL. Companion documents: `ripcord-battle-plan.md` (strategy/research) and `ripcord-claude-code-master-prompt.md` (paste into Claude Code to start).

**Hard deadline: Aug 13, 2026, 12:00 UTC+2 = 11:00 AM in Lagos (WAT).** Target internal finish: **Aug 11**. Today: Jul 30.

---

## 0. What we're building (one screen)

**Ripcord** is an autonomous, MEV-aware liquidation-protection agent. It watches a DeFi debt position on Aave V3 (Base), and when the health factor (HF) drops into a danger band, it plans a defense (repay debt or add collateral), has a second independent agent critique the plan, passes a deterministic safety guard, then executes the rescue **through KeeperHub** with retries, smart gas, and private routing — and proves it via the audit trail, a Basescan link, and a Telegram alert.

**Core loop:** Sense → Decide (Planner) → Verify (Critic) → Gate (Guard) → Execute (KeeperHub) → Prove (audit trail + alert + evidence).

**The three submission artifacts (non-negotiable):**
1. Public GitHub repo.
2. Demo video (≤3 min) showing the agent executing onchain through KeeperHub.
3. Link to a real transaction the agent executed via KeeperHub (hero tx = a Base **mainnet** defensive action).

**Stackable bounty artifacts:** starter template, 10-minute tutorial, one merged docs PR, onboarding-friction teardown.

**North star:** a judge must be able to click one Basescan link and one KeeperHub audit-trail screenshot and immediately believe "this agent really defended a real position."

---

## 1. Scope: Core / Stretch / Cut lines

**Core (must ship, done by Aug 6):**
- Aave V3 on Base (Sepolia first, then mainnet), single monitored address.
- HF monitoring loop + threshold policy with hysteresis and cooldown.
- Two defenses: `repay` (preferred) and `supplyCollateral`.
- Planner agent + independent Critic agent + deterministic Guard.
- All writes via KeeperHub, with retries and run-status polling.
- Private routing for mainnet defenses; documented gas-sponsorship-vs-private-routing decision.
- Telegram alerts with rationale + tx hash + audit-trail reference.
- Evidence capture (screenshots, tx hashes, run IDs) as you go.

**Stretch (Aug 7–8, only if Core is rock-solid):**
- Risk-scoring engine published as a paid KeeperHub marketplace workflow ($0.05/call); a second agentic wallet pays for it via x402; verified on x402scan.
- Morpho support (second protocol).
- `pnpm status` CLI dashboard (great demo b-roll).

**Cut lines (in order, if behind schedule):** Morpho → status dashboard → x402 marketplace layer. **Never cut:** tests, the mainnet hero tx, the demo video, evidence capture.

---

## 2. Tech stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript, Node 20+, pnpm | Fast iteration; pairs with Claude Code and MCP |
| Agent brain | Plain TS orchestration calling the Anthropic API (Planner + Critic as two separately-prompted calls, `claude-sonnet-4-6`) | A ~200-line explicit loop beats a framework for debuggability and demos; no LangGraph unless you want graph viz |
| Chain reads | `viem` (Base + Base Sepolia) | Reads only — all writes go through KeeperHub (that's the point of the project) |
| Execution | KeeperHub: hosted MCP server (interactive/setup), webhook-triggered workflows + REST/`kh` CLI (programmatic from the daemon) | The judged surface |
| State | `better-sqlite3` (positions, decisions, executions) | Zero-ops persistence |
| Tests | `vitest` (+ optional `fast-check` for policy fuzzing) | Fast, TS-native |
| Logging | `pino` (JSON lines) | Clean audit-style logs for the video |
| Notifications | Telegram bot (BotFather) — direct or via KeeperHub notification node | Fastest to set up; screenshots well |
| Lint/format | `biome` (or eslint+prettier) | One tool, fast |
| CI | GitHub Actions: lint + test on push | Production-seriousness signal for judges |

**Two KeeperHub integration paths (important):**
- **Interactive (Claude Code as operator):** the KeeperHub MCP server + Claude Code plugin, for setup, workflow creation, one-off executions, and debugging runs.
- **Programmatic (the Ripcord daemon):** the daemon must trigger executions without a human. Most doc-stable path: pre-build a **webhook-triggered KeeperHub workflow** (WF-2 below) and have the daemon POST the defense payload to it; alternatively use KeeperHub's REST API / `kh` CLI with your `kh_` key. Build a `KeeperHubClient` interface first and implement against whichever surface the live docs confirm — do not guess endpoints.

---

## 3. Architecture

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

**Component specs:**
- **Sensor** (`src/sensor/aave.ts`): every N seconds (config; 60s testnet, 30s during demo), call Aave V3 Pool `getUserAccountData(user)`. Returns `healthFactor` as a 1e18 wad; `totalCollateralBase`/`totalDebtBase` are in the market's base currency units (USD, 8 decimals on these deployments — verify and unit-test the decimals). Also read wallet balances of repay asset (USDC) and collateral asset (WETH). Compute HF velocity (Δ over last 3 samples).
- **Policy** (`src/policy/thresholds.ts`): pure function `(snapshot, config) → { state: healthy|warn|act|panic, reason }` with hysteresis (re-arm only after HF > re-arm level) and per-position cooldown so one dip doesn't fire repeated defenses.
- **Planner** (`src/agents/planner.ts`): LLM call. Input: position snapshot, balances, thresholds, recent history, allowed actions + caps. Output (strict JSON schema): `{ action: "repay"|"supplyCollateral"|"none", asset, amountUsd, expectedHfAfter, rationale }`. Reject/retry on schema violation.
- **Critic** (`src/agents/critic.ts`): separate prompt, no shared context beyond the snapshot + Planner output. Must independently recompute expected HF-after and check it clears `targetHf`. Output: `{ verdict: "APPROVE"|"REJECT", reason }`. **No approval → no execution. Ever.**
- **Guard** (`src/guard/guard.ts`): deterministic, non-LLM, final authority: `MAX_TX_USD`, `DAILY_CAP_USD`, contract+method allowlist (addresses come from config, **never** from LLM output), `MIN_HF_IMPROVEMENT`, `DRY_RUN` and `RIPCORD_ARM` flags, idempotency (decision ID not already executed).
- **Executor** (`src/executor/keeperhub.ts`): `KeeperHubClient` interface — `triggerDefense(payload)`, `getRun(runId)`, plus setup-time helpers. Records run ID, tx hash, gas used, outcome to SQLite; polls to terminal state; surfaces KeeperHub's retry behavior in logs.
- **Notifier** (`src/notifier/telegram.ts`): one message per decision outcome: state, action, rationale (1 line), tx hash link, run ID.
- **Risk engine** (stretch, `src/risk/engine.ts`): pure function `(chain, address) → { score: 0–100, band, factors[] }` — deterministic, unit-tested; exposed via marketplace workflow WF-3.

**Defense playbook:**

| HF band | State | Behavior | Routing (mainnet) |
|---|---|---|---|
| > 1.50 | healthy | monitor only | — |
| 1.25–1.50 | warn | Telegram warning; pre-stage (check allowance/balances) | — |
| 1.10–1.25 | **act** | Planner→Critic→Guard→ repay (preferred) or supply collateral; target post-defense HF ≥ 1.60 | **Private routing**, self-paid gas |
| < 1.10 | **panic** | Same pipeline, expedited (skip cooldown, conservative gas multiplier up) | **Private routing** |

Default thresholds config: `warn 1.50, act 1.25, panic 1.10, targetHf 1.60, rearm 1.55, cooldownSec 1800`.

**Gas sponsorship vs private routing (decide per tx, document in README):**

| Situation | Route | Gas |
|---|---|---|
| Testnet (all) | Public mempool | Sponsored (demo the sponsorship surface; no MEV risk on testnet) |
| Mainnet setup txs (approvals) | Public mempool | Sponsored (demo the surface again on mainnet) |
| Mainnet **defense** txs | **Private routing** | Self-paid (sponsorship is mutually exclusive with private routing — this documented tradeoff is a criterion-#3 scoring point) |

**Approval strategy:** `repay` requires USDC allowance to the Aave Pool. Pre-approve a capped allowance (e.g., 2× `DAILY_CAP_USD`) during Phase-2 setup so the defense itself is a single fast tx. Document the security tradeoff (capped, revocable, listed in README) — judges notice this kind of reasoning.

---

## 4. Repo layout

```
ripcord/
  CLAUDE.md                  # created by the master prompt
  README.md                  # judge-facing: what/why, surfaces map, tx links table, quickstart
  FRICTION.md                # onboarding-friction log (bounty fuel) — update daily
  .env.example
  .github/workflows/ci.yml   # lint + test
  package.json  tsconfig.json  biome.json
  src/
    index.ts                 # daemon entry (loop)
    config.ts                # env + thresholds + addresses (single source of truth)
    types.ts
    sensor/aave.ts
    policy/thresholds.ts
    agents/planner.ts  agents/critic.ts  agents/prompts.ts
    guard/guard.ts
    executor/keeperhub.ts    # KeeperHubClient interface + impl + mock
    notifier/telegram.ts
    risk/engine.ts           # stretch
    state/db.ts
    status.ts                # `pnpm status` pretty-printer (stretch)
  workflows/                 # exported KeeperHub workflow definitions + README per workflow
  scripts/
    setup-position.ts        # open/supply/borrow the monitored position (testnet + tiny mainnet)
    stress-position.ts       # testnet: push HF down (borrow more / withdraw a bit) for demos
    approve-repay-asset.ts
  test/                      # mirrors src/; unit + integration + chaos
  docs/
    ripcord-battle-plan.md   # drop in the strategy doc
    ripcord-build-guide.md   # this file
    architecture.md
    demo-script.md
    evidence/EVIDENCE.md     # index of screenshots, tx hashes, run IDs (append daily)
  starter/                   # bounty: minimal "ripcord-starter" template (or separate repo)
```

---

## 5. Phase 0 — Accounts, environment, first transaction (Jul 30–31)

Checklist, in order:

1. **DoraHacks:** register for the hackathon, join/confirm your BUIDL slot early (you can edit until deadline). Join the KeeperHub Discord builder channel (office hours = free debugging + judges see you engaged).
2. **GitHub:** create `ripcord` repo (30-second `ripcord crypto` collision search first). Private for now; **must be public before submission**.
3. **KeeperHub:** create account/org → Turnkey org wallet is provisioned; generate `kh_` API key; note wallet address.
4. **Install tooling:** `brew install keeperhub/tap/kh` (per docs); Node 20; pnpm.
5. **Connect Claude Code to KeeperHub MCP:** `claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp` (then authenticate; verify with `claude mcp list` and `/mcp` in-session). Install the KeeperHub Claude Code plugin per their docs (`/plugin marketplace add KeeperHub/claude-plugins`, then install the plugin it offers). *Exact names per live docs — log any mismatch in FRICTION.md.*
6. **Keys/services:** Anthropic API key; Base + Base Sepolia RPC URLs (Alchemy free tier or public endpoints); Telegram bot via @BotFather + your chat ID.
7. **Funds:** Base Sepolia ETH from a faucet (Alchemy/Coinbase/community faucets — availability changes; log friction). Plan mainnet budget for Phase 2 (see §14).
8. **First transaction (the tracer bullet):** via Claude Code + KeeperHub MCP, execute a tiny testnet transfer (`execute_transfer` or equivalent) from the org wallet on Base Sepolia.

**Phase 0 acceptance criteria:**
- [ ] Testnet tx hash visible on Sepolia Basescan, executed through KeeperHub, with the run visible in KeeperHub's Runs/audit trail.
- [ ] Screenshot pair (Basescan + KeeperHub run) saved to `docs/evidence/` and indexed in `EVIDENCE.md`.
- [ ] Repo scaffolded (via master prompt Session 1), CI green, `.env` populated locally.
- [ ] `FRICTION.md` has its first entries (there will be some — that's bounty fuel).

---

## 6. Phase 1 — Sense → decide → execute on testnet (Aug 1–3)

Build order (tests alongside each piece — see §9):
1. `config.ts` + `types.ts` (addresses with `// VERIFY` flags, thresholds, env parsing with zod).
2. Sensor + HF math (unit-test the wad/decimals conversions against a hand-computed fixture).
3. Policy (unit-test every band edge, hysteresis, cooldown; fuzz if time allows).
4. Planner + Critic (schema-validated outputs; test the reject paths with canned bad outputs).
5. Guard (test every rule, especially allowlist and caps).
6. KeeperHub workflows (build via Claude Code + MCP; export definitions to `workflows/`):
   - **WF-1 `hf-monitor`:** schedule/block-interval trigger (~5 min) → read `getUserAccountData` → condition HF < warn → Telegram warn. (Redundant sensing = reliability talking point: even if the daemon dies, monitoring survives.)
   - **WF-2 `defend`:** **webhook trigger** (payload: decisionId, action, asset, amount, minHfAfter) → re-verify HF onchain (check-and-execute pattern: never trust a stale decision) → contract call → notify with tx hash.
7. Executor: `KeeperHubClient` → POST to WF-2's webhook; poll run status; persist results.
8. Daemon loop in `index.ts` (DRY_RUN default) + Telegram notifier.
9. `scripts/setup-position.ts` + `scripts/stress-position.ts`: open a Base Sepolia Aave V3 position (supply WETH, borrow USDC), then push HF down on command. *If the Sepolia Aave market is illiquid/broken (common), fall back to: local Anvil fork of Base mainnet for the full drama loop + real testnet txs for simpler KeeperHub execution proof. Decide by end of Aug 2 and note it in FRICTION.md.*

**End-to-end target (Aug 3):** run `stress-position.ts` → daemon detects `act` → Planner proposes repay → Critic approves → Guard passes → WF-2 lands the repay on Base Sepolia → HF recovers → Telegram fires → audit trail shows trigger→sim→tx→outcome.

**Phase 1 acceptance criteria:**
- [ ] Full loop e2e on testnet, hands-off, at least 3 consecutive successful runs.
- [ ] At least one on-camera-worthy **failure→retry→success** captured (e.g., forced revert then corrected retry, or KeeperHub's own retry visible in the run log).
- [ ] Critic REJECT path demonstrated once (log + screenshot).
- [ ] ~40+ meaningful tests green in CI.

---

## 7. Phase 2 — Mainnet + private routing + chaos (Aug 4–6)

1. **Aug 4 checkpoint (from the battle plan):** if testnet e2e isn't reliable by tonight, cut x402 + Morpho now and pour everything into a bulletproof single-protocol mainnet keeper.
2. Fund the org wallet on Base mainnet (see budget §14). Run `setup-position.ts` for a **small real position** (e.g., supply ~$30 WETH, borrow ~$10 USDC → HF ≈ 2.0-ish; then borrow slightly more to sit near 1.4 so `warn` is real and you can nudge into `act` deliberately).
3. Pre-approve capped USDC allowance to the Pool (public mempool + gas sponsorship — demo that surface here).
4. Flip `CHAIN=base`, `RIPCORD_ARM=1`, `DRY_RUN=false` **only when supervised**. Enable **private routing** on WF-2 for defenses.
5. Execute the **hero tx**: nudge HF into the act band → full pipeline → private-routed repay on Base mainnet → HF recovers. Capture everything (screen-record the whole session — this is your primary video b-roll).
6. **Chaos testing** (each with evidence): forced revert path; Planner emits invalid JSON (inject via test hook) → schema reject → no tx; Critic rejects → no tx; duplicate trigger → idempotency holds; RPC timeout → sensor retries; daemon killed mid-cycle → restart resumes cleanly from SQLite; confirm KeeperHub retry/backoff appears in at least one run log.
7. Write `docs/architecture.md` + the README "surfaces map" table (each KeeperHub surface → where Ripcord uses it → evidence link).

**Phase 2 acceptance criteria:**
- [ ] Hero mainnet defensive tx: Basescan link + matching KeeperHub audit-trail record (trigger→simulation→submitted tx→gas→outcome→timestamp).
- [ ] Private routing confirmed for the defense; sponsorship demonstrated on a setup tx; tradeoff documented.
- [ ] Chaos matrix table in README with ✅ per scenario + evidence links.
- [ ] Zero unsafe paths: with `RIPCORD_ARM=0`, provably nothing can write to mainnet (test exists).

---

## 8. Phase 3 — x402/MPP marketplace layer (stretch) + test hardening (Aug 7–8)

1. Finalize `risk/engine.ts` (deterministic; factors: HF, HF velocity, collateral volatility class, debt concentration, buffer-to-liquidation). Unit-test exhaustively — it's a pure function, make it your test-count powerhouse.
2. Build **WF-3 `risk-score`** (input `{chain, address}` → reads → code node → JSON out). List on the KeeperHub Marketplace at **$0.05/call** (quota-exempt tier per docs), input/output schema included.
3. Second wallet: set up the KeeperHub agentic wallet (`npx -p @keeperhub/wallet …` per docs) with a few USDC; call your listed workflow via x402; confirm the payment/listing on **x402scan.com** (and mppscan if the MPP path is one toggle away — don't burn a day on it).
4. Test hardening: push meaningful assertions past ~100 (Tradewise optics); add the policy fuzzer; CI badge in README.

**Phase 3 acceptance criteria:**
- [ ] Listing live; one paid call from a second wallet; x402scan screenshot + payment reference in `EVIDENCE.md`.
- [ ] "Ripcord pays for itself" line is now literally true and provable.

---

## 9. Testing strategy (summary)

- **Unit:** HF/decimal math (fixture-verified), policy bands + hysteresis + cooldown, guard rules (every rule has a failing test), planner/critic schema validation, risk engine.
- **Integration:** mocked `KeeperHubClient` for CI; nightly live testnet e2e (manual trigger is fine).
- **Chaos:** the §7.6 matrix, each automated where possible, manual+evidence where not.
- **Never test in prod what you haven't broken on testnet first.**

---

## 10. Observability & evidence discipline

- Every decision gets a ULID `decisionId` threaded through logs, KeeperHub payloads, SQLite, and Telegram messages — one ID ties the whole story together on camera.
- JSON-line logs (pino) → the terminal itself becomes demo b-roll.
- **Daily habit (non-negotiable):** append to `docs/evidence/EVIDENCE.md` (what, link, screenshot path) and `FRICTION.md` (what confused/broke, proposed fix). These two files become the video, the README, and the bounty teardown almost for free.

---

## 11. Security & safety rails

- `.env` never committed; `.env.example` complete; repo history clean (check before going public).
- Separate concerns: org wallet holds only what the demo needs; your personal funds nowhere near this.
- Hard caps: `MAX_TX_USD=15`, `DAILY_CAP_USD=30` (tune to your budget).
- `DRY_RUN=true` is the default; mainnet writes additionally require `RIPCORD_ARM=1`.
- Contract addresses + method selectors come **only** from `config.ts` (allowlist); LLM output can never introduce an address.
- Capped, revocable approval; revoke after the hackathon.
- Kill switch: `pnpm stop` (or ctrl-C) → daemon halts; WF-1 monitoring continues (talking point).

`.env.example`:
```
# Chain
CHAIN=base-sepolia            # base-sepolia | base
BASE_RPC_URL=
BASE_SEPOLIA_RPC_URL=
MONITORED_ADDRESS=

# Brains
ANTHROPIC_API_KEY=

# KeeperHub
KEEPERHUB_API_KEY=            # kh_...
KEEPERHUB_DEFEND_WEBHOOK_URL= # WF-2 trigger URL

# Alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Safety
DRY_RUN=true
RIPCORD_ARM=0                 # must be 1 for any mainnet write
MAX_TX_USD=15
DAILY_CAP_USD=30
MIN_HF_IMPROVEMENT=0.05
```

---

## 12. Phase 4 — Demo video, README, bounty deliverables (Aug 9–10)

**Demo video (≤3 min, 1080p, OBS; script in `docs/demo-script.md`):**

| Beat | Time | On screen | Capture |
|---|---|---|---|
| Hook | 0:00–0:20 | "A position is 30 seconds from impact. Watch Ripcord deploy." Live HF ticking down | Phase 2 recording or re-staged |
| Architecture | 0:20–0:45 | One diagram: Planner→Critic→Guard→KeeperHub | Slide |
| The rescue | 0:45–1:45 | Detection → Planner JSON → Critic APPROVE → private-routed tx → Basescan confirm → HF recovers → Telegram pings | The hero session |
| Reliability | 1:45–2:20 | Audit-trail replay; the failure→retry→success run; Critic REJECT moment | Phase 1–2 evidence |
| It pays for itself | 2:20–2:45 | x402scan listing + a paid call landing | Phase 3 evidence |
| Close | 2:45–3:00 | "Agents decide. Ripcord makes the rescue land." Repo + tx links | Slide |

**README (judge-facing) must contain:** 3-sentence what/why (open with the Moonwell/Aave incident framing) · architecture diagram · **KeeperHub surfaces map table with evidence links** · **transactions table** (hero mainnet tx, sponsorship demo tx, x402 paid call) · chaos matrix · quickstart (works on testnet in <10 min) · safety design · tests/CI badge.

**Bounty deliverables (the trio):**
1. **`starter/` (or separate `ripcord-starter` repo):** minimal template — config + sensor + WF-2 webhook call + one command to first defensive testnet tx. Reference KeeperHub's template/`deploy_template` concept so it's directly adoptable.
2. **Tutorial:** "Zero to your first defensive transaction in 10 minutes" — the exact Phase-0/1 commands you actually ran, screen-recorded, published as `docs/tutorial.md` (+ optionally a short video).
3. **Docs PR:** fork the KeeperHub docs repo ("Edit this page on GitHub"), fix the stale Para-wallet reference on the Gas Management page (Para → Turnkey) + anything else FRICTION.md caught; open a tidy PR with before/after. Politely flag it in the builder Discord — merged > open.
4. **Teardown:** convert `FRICTION.md` into a prioritized teardown with proposed fixes; attach to the bounty submission.

---

## 13. Phase 5 — Submission (Aug 11, buffer Aug 12–13)

Dry-run checklist, every link in an incognito window:
- [ ] Repo **public**; no secrets in history; README renders; CI green.
- [ ] Video uploaded (YouTube unlisted or per DoraHacks spec), plays, ≤3 min.
- [ ] Hero tx link resolves on Basescan; audit-trail screenshot in repo.
- [ ] x402scan listing link live (if shipped).
- [ ] DoraHacks BUIDL: all required fields (GitHub link, demo video, tx link), tags, description pasted from README top; bounty entry filed separately for the UX bounty with the trio linked.
- [ ] Submit. Screenshot the confirmation. Then stop touching main.

---

## 14. Budget (suggested, your call)

| Item | Est. |
|---|---|
| Base Sepolia | Free (faucets) |
| Base mainnet gas (setup + defenses + chaos) | $2–5 (Base is cheap) |
| Mainnet position (recoverable after the hackathon) | $30–50 |
| USDC for x402 paid-call demo | $2–5 |
| Anthropic API (Planner/Critic + dev) | $5–20 |
| **Total at risk** | **~$40–80, mostly recoverable** |

---

## 15. Risk register

| Risk | Likelihood | Mitigation | Act when |
|---|---|---|---|
| Aave Sepolia market broken/illiquid | Med | Anvil fork of Base mainnet for the drama loop; testnet for KeeperHub execution proof | End of Aug 2 |
| Private routing unavailable/limited on Base | Low-Med | Verify Day 1 via docs/Discord; fallback: hero tx on Ethereum mainnet (sponsorship exists there) or public route + explicit tradeoff writeup | Aug 4 |
| MCP flakiness | Low | `kh` CLI / REST / webhook workflows as the programmatic path anyway | As hit |
| Marketplace listing review/delay | Med | Start listing early Aug 7; MPP toggle only if trivial | Aug 8 |
| Agentic wallet caps block demo | Low | Amounts are tiny by design | — |
| Testnet e2e not reliable | Med | **Aug 4 checkpoint:** cut x402 + Morpho, single-protocol bulletproof build | Aug 4 |
| Field crowded with liquidation bots | Low-Med | Check BUIDL gallery ~Aug 5; if crowded, reframe toward Watchtower (protocol incident response), ~90% code reuse | Aug 5 |

---

## 16. Verify-before-use list (do not code against these from memory)

- Exact KeeperHub MCP tool names/params; webhook-trigger payload shape; REST endpoints; run-status polling shape. → live docs + `/mcp` introspection; log doc gaps to FRICTION.md.
- Private routing: which chains, how enabled per workflow/tx.
- Marketplace listing flow, pricing tiers, quota-exemption threshold, x402/MPP toggle.
- Gas sponsorship scope + credit limits.
- Aave V3 Base addresses via the official Aave Address Book (do not trust any doc, including this one):
  - Pool (Base): `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` — **VERIFY**
  - USDC (Base): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — **VERIFY**
  - WETH (Base): `0x4200000000000000000000000000000000000006` — **VERIFY**
  - All Base Sepolia equivalents — **VERIFY** (testnet deployments move).
- Faucet availability (changes weekly).
- Claude Code specifics if anything misbehaves: https://code.claude.com/docs/en/mcp

---

## 17. Daily rhythm

Morning: check phase AC → pick tasks. Build in Claude Code sessions (see master prompt file). Evening: run tests → append `EVIDENCE.md` + `FRICTION.md` → conventional commit(s) → push (CI green) → 2-line status note in your own log. Every day ends with the repo in a demoable state.
