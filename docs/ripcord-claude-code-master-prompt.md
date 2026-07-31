# Ripcord — Claude Code Master Prompt Pack

How to use this file:
1. Do the **pre-flight** below (5–10 min of human-only steps).
2. Paste **THE MASTER PROMPT (Session 1)** into Claude Code as your first message in the empty repo.
3. Use the **Session Prompt Library** at the bottom to kick off each subsequent phase.

---

## Pre-flight (human steps, before opening Claude Code)

```bash
mkdir ripcord && cd ripcord && git init
mkdir -p docs
# Drop the two companion docs into the repo so Claude Code can read them:
#   docs/ripcord-battle-plan.md
#   docs/ripcord-build-guide.md

# Connect the KeeperHub MCP server to Claude Code (verify exact URL in KeeperHub docs):
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp
claude mcp list          # confirm it's registered

claude                   # start Claude Code
# In-session: run /mcp to authenticate/verify the KeeperHub server,
# and install the KeeperHub plugin per their docs:
#   /plugin marketplace add KeeperHub/claude-plugins
```

Have ready in a local note (never paste secrets into prompts; you'll put them in `.env` yourself): Anthropic API key, KeeperHub `kh_` API key, Base + Base Sepolia RPC URLs, Telegram bot token + chat ID.

---

## THE MASTER PROMPT (Session 1 — paste everything between the lines)

---BEGIN PROMPT---

You are my senior TypeScript engineer and pair-builder for **Ripcord**, my solo entry to the KeeperHub "Agents Onchain" hackathon (DoraHacks). We have until Aug 13, 2026, 12:00 UTC+2; internal target Aug 11. Judging weighs, in roughly this order: real onchain execution via KeeperHub, breadth of KeeperHub surfaces used, reliability/observability (retries, gas handling, failure-mode awareness, audit-trail usage), originality/real-world usefulness, and integration quality/DX. Working transactions beat polished mockups.

**What Ripcord is:** an autonomous, MEV-aware liquidation-protection agent. It monitors a DeFi debt position on Aave V3 (Base), and when the health factor drops into a danger band it plans a defense (repay debt or supply collateral), a second independent Critic agent must approve, a deterministic Guard applies hard safety rules, and then the transaction executes **through KeeperHub** (webhook-triggered workflow) with retries, smart gas, and private routing on mainnet — proven via KeeperHub's audit trail, a Basescan link, and a Telegram alert. Stretch: a risk-scoring engine published as a paid x402 marketplace workflow.

**First, read these two files fully before writing any code:** `docs/ripcord-build-guide.md` (architecture, phases, acceptance criteria — treat it as the spec) and `docs/ripcord-battle-plan.md` (strategy context). If anything in this prompt conflicts with the build guide, the build guide wins.

**Ground rules for this entire project (repeat back your understanding of these before starting):**
1. **Never invent external API details.** For KeeperHub: use the connected KeeperHub MCP server to introspect real tool names/schemas, and consult https://docs.keeperhub.com when uncertain. For Aave/viem: verify addresses and ABIs against official sources. Where something can't be verified right now, define a clean interface, stub the implementation, and add a `// VERIFY:` comment plus an entry in FRICTION.md — never guess silently.
2. **All onchain writes go through KeeperHub.** viem is for reads only. This is the judged core of the project.
3. **Safety invariants (non-negotiable, enforce in code and tests):** `DRY_RUN=true` by default; any mainnet write additionally requires `RIPCORD_ARM=1`; hard caps `MAX_TX_USD` and `DAILY_CAP_USD`; contract addresses and method selectors come only from `config.ts` allowlists — never from LLM output; Critic approval is mandatory before any execution; the deterministic Guard is the final authority and overrides both LLM agents; idempotency via decisionId so no decision executes twice.
4. **Secrets:** never in git, never in code, never echoed into logs. `.env` + complete `.env.example`. Check `git status` before every commit.
5. **Test-first for policy, guard, and math.** HF/decimal conversions get fixture-verified unit tests. Every guard rule gets a failing-case test. Target meaningful coverage, not vanity counts.
6. **Small conventional commits** (`feat:`, `fix:`, `test:`, `docs:`), each leaving the repo green. Ask me before any destructive git operation.
7. **Evidence and friction discipline:** whenever we produce something demo-worthy (tx hash, run ID, screenshot-worthy log), append it to `docs/evidence/EVIDENCE.md`; whenever anything about KeeperHub/Aave/tooling confuses us or breaks, append a dated entry to `FRICTION.md` with a proposed fix (this feeds a hackathon bounty).
8. **Mainnet actions:** before any real-money or mainnet-affecting step, stop, show me the exact plan (what, where, how much), and wait for my explicit go.

**Stack (locked; don't relitigate):** TypeScript + Node 20 + pnpm · plain TS agent orchestration calling the Anthropic API (`claude-sonnet-4-6`) for Planner and Critic as separately-prompted calls with strict JSON-schema outputs · viem for reads · better-sqlite3 · vitest (+ fast-check for policy fuzzing if cheap) · pino JSON logs · biome · GitHub Actions CI (lint + test). No LangChain/LangGraph. Keep dependencies minimal.

**Session 1 objective — scaffold and build the offline-testable core (Phase 1 of the build guide, minus live KeeperHub calls):**
1. Create `CLAUDE.md` at the repo root with exactly the content in the "CLAUDE.md CONTENT" block below.
2. Scaffold the repo per the layout in the build guide §4 (package.json scripts: `dev`, `test`, `lint`, `status`; tsconfig; biome; CI workflow; `.env.example` per build guide §11; `.gitignore` including `.env` and `*.sqlite`).
3. Implement with tests, in this order:
   a. `src/config.ts` + `src/types.ts` — zod-validated env, thresholds (`warn 1.50, act 1.25, panic 1.10, targetHf 1.60, rearm 1.55, cooldownSec 1800`), address book with `// VERIFY:` flags for Aave V3 Base + Base Sepolia (Pool, USDC, WETH) — populate candidates from official Aave sources if reachable, otherwise stub with VERIFY flags.
   b. `src/sensor/aave.ts` — `getUserAccountData` read via viem; HF wad (1e18) and base-currency (8-decimal) conversions; fixture-verified unit tests; HF-velocity over last 3 samples.
   c. `src/policy/thresholds.ts` — pure `evaluate(snapshot, config)` with hysteresis + cooldown; exhaustive band-edge tests.
   d. `src/agents/prompts.ts`, `planner.ts`, `critic.ts` — strict JSON schemas (`{action, asset, amountUsd, expectedHfAfter, rationale}` / `{verdict, reason}`), schema-reject-and-retry logic, unit tests using canned model outputs (mock the Anthropic client in tests).
   e. `src/guard/guard.ts` — every rule from ground-rule 3, each with a failing-case test, including "with RIPCORD_ARM=0 nothing can reach the executor in mainnet mode".
   f. `src/executor/keeperhub.ts` — `KeeperHubClient` interface (`triggerDefense(payload)`, `getRun(runId)`) + a `MockKeeperHubClient` for tests + an HTTP implementation that POSTs to `KEEPERHUB_DEFEND_WEBHOOK_URL` and polls run status (shape behind the interface; mark unverified response fields with VERIFY comments).
   g. `src/state/db.ts` — decisions/executions tables; idempotency check.
   h. `src/notifier/telegram.ts` — one clean message format: state, action, one-line rationale, tx hash link, decisionId, runId.
   i. `src/index.ts` — the daemon loop wiring sensor→policy→planner→critic→guard→executor→notifier, DRY_RUN default, graceful shutdown, structured logs threading `decisionId` end to end.
   j. `scripts/setup-position.ts`, `scripts/stress-position.ts`, `scripts/approve-repay-asset.ts` — testnet-first; these may stay partially stubbed until Session 2 but must compile and document their exact intended calls.
4. Then, using the **KeeperHub MCP server** (it's connected): introspect the available tools and print me a short report — the real tool names relevant to us (transfer, contract call, check-and-execute, workflow create/execute, run status, marketplace), any schema surprises vs our assumptions, and corrections needed to `KeeperHubClient`. Append discrepancies to FRICTION.md.
5. Finish the session with: `pnpm lint` and `pnpm test` green; `pnpm dev` running the full loop in DRY_RUN against Base Sepolia reads (or a mocked snapshot if I haven't set RPC vars yet); a `README.md` skeleton with the surfaces-map and transactions tables scaffolded; conventional commits pushed; and a numbered list of exactly what you need from me (human-only steps) before Session 2.

**Definition of done for Session 1:** repo green in CI, DRY_RUN loop demonstrably making (mock) decisions end to end with Critic and Guard in the path, KeeperHub MCP introspection report delivered, zero unverified API guesses outside `// VERIFY:` markers.

Work in this order, plan briefly before each numbered step, and keep asking yourself: "would a KeeperHub engineer reading this repo believe it was built for production?"

**CLAUDE.md CONTENT (create verbatim as `CLAUDE.md`):**

```markdown
# Ripcord

Autonomous MEV-aware liquidation-protection agent for the KeeperHub "Agents Onchain" hackathon (DoraHacks). Deadline Aug 13 2026 12:00 UTC+2; internal target Aug 11. Spec: docs/ripcord-build-guide.md (authoritative). Strategy: docs/ripcord-battle-plan.md.

## Loop
Sense (viem read, Aave V3 Base) → Policy bands → Planner (LLM, strict JSON) → Critic (independent LLM, must APPROVE) → Guard (deterministic, final authority) → Execute via KeeperHub webhook workflow (private routing on mainnet) → Notify (Telegram) → Record (SQLite + docs/evidence/EVIDENCE.md).

## Commands
- pnpm dev — run daemon (DRY_RUN by default)
- pnpm test / pnpm lint — must be green before any commit
- pnpm status — current HF, recent decisions, recent runs

## Hard safety invariants (never weaken, always test)
1. All onchain WRITES go through KeeperHub. viem = reads only.
2. DRY_RUN=true default; mainnet writes also require RIPCORD_ARM=1.
3. MAX_TX_USD and DAILY_CAP_USD enforced in Guard.
4. Addresses/selectors only from src/config.ts allowlists — never from LLM output.
5. No Critic APPROVE → no execution. Guard overrides everything.
6. Idempotency by decisionId.
7. Secrets only in .env (gitignored). Never log them.

## External-API truth policy
Never guess KeeperHub/Aave details. Verify via the connected KeeperHub MCP server or https://docs.keeperhub.com and official Aave sources. Unverifiable → interface + stub + `// VERIFY:` + FRICTION.md entry.

## Working habits
- Small conventional commits, repo always green.
- Demo-worthy output → append docs/evidence/EVIDENCE.md. Confusion/breakage → dated FRICTION.md entry with proposed fix.
- Before any mainnet/real-money action: present exact plan, wait for explicit human go.

## Current phase
Phase 1 (testnet core). Update this line as phases complete: 0 setup ✅/⬜ · 1 testnet core ⬜ · 2 mainnet+private routing ⬜ · 3 x402 marketplace ⬜ · 4 docs+video ⬜ · 5 submitted ⬜
```

---END PROMPT---

---

## Session Prompt Library (paste at the start of each later session)

**Session 2 — Testnet end-to-end (Aug 1–3):**
> Read CLAUDE.md and docs/ripcord-build-guide.md §6. Objective: full e2e on Base Sepolia. Using the KeeperHub MCP server, build and export WF-1 `hf-monitor` (schedule → read HF → condition < warn → Telegram) and WF-2 `defend` (webhook trigger → onchain re-verify HF → contract call → notify); save definitions + per-workflow README to `workflows/`. Wire the real `KeeperHubClient` to WF-2's webhook URL. Finish `scripts/setup-position.ts` and `scripts/stress-position.ts` for Base Sepolia Aave V3; if the testnet market is unusable, implement the Anvil-fork fallback from build guide §6.9 and tell me which path you chose and why. Then walk me through the live run: I'll execute the position setup and stress; you monitor logs and KeeperHub runs, and we iterate until the loop lands a defensive tx on testnet hands-off 3 times in a row. Capture the Critic-REJECT demo and one failure→retry→success run. Update EVIDENCE.md, FRICTION.md, tests, commits. End with the Phase-1 acceptance checklist from the build guide, checked or with blockers.

**Session 3 — Mainnet + private routing + chaos (Aug 4–6):**
> Read CLAUDE.md and build guide §7. First: Aug-4 checkpoint — assess testnet reliability honestly and recommend keep/cut for x402 + Morpho. Then prepare the mainnet runbook: exact funding amounts, `setup-position.ts` parameters for a ~$30/$10 WETH/USDC position near HF 1.4, capped USDC approval (public mempool + gas sponsorship — we demo sponsorship here), WF-2 switched to private routing for defenses, and the supervised arming procedure (CHAIN=base, DRY_RUN=false, RIPCORD_ARM=1). Present the runbook and wait for my go before anything touches mainnet. After the hero tx lands: run the chaos matrix from §7.6 one scenario at a time with evidence per scenario, add the chaos table to README, and write docs/architecture.md plus the README surfaces-map with evidence links. I will screen-record the entire hero session — remind me before we arm.

**Session 4 — x402 marketplace + test hardening (Aug 7–8):**
> Read CLAUDE.md and build guide §8. Implement `src/risk/engine.ts` as a deterministic pure function with exhaustive unit tests. Build WF-3 `risk-score` via the KeeperHub MCP tools, list it on the Marketplace at $0.05/call with a clean input/output schema, and guide me through the second-wallet agentic setup and one paid x402 call; we verify on x402scan and capture evidence. Then harden: push meaningful assertions past 100, add the fast-check policy fuzzer, CI badge in README. If any marketplace step is blocked by review/delays, log it in FRICTION.md, ship everything ship-able, and give me the exact resume-point.

**Session 5 — Docs, demo assets, bounty trio (Aug 9–10):**
> Read CLAUDE.md and build guide §12. Finalize the judge-facing README (incident-framing intro, architecture diagram, surfaces-map with evidence links, transactions table, chaos matrix, <10-min testnet quickstart, safety design, CI badge). Write docs/demo-script.md matching the 6-beat shot table and tell me exactly which evidence clips slot into each beat. Produce the bounty trio: `starter/` template (one command to first defensive testnet tx), docs/tutorial.md ("zero to first defensive transaction in 10 minutes" from our real command history), and prepare the KeeperHub docs PR fixing the stale Para-wallet reference (branch, diff, PR text ready for me to submit) plus the FRICTION.md → prioritized teardown conversion. Everything committed, CI green.

**Session 6 — Submission dry run (Aug 11):**
> Read build guide §13. Run the full submission dry-run checklist: repo public-readiness audit (secret scan of full git history, README render, CI), every link checked as if you were a judge in an incognito window (hero tx, video, x402scan), and draft the DoraHacks BUIDL description + the separate UX-bounty submission text from the README. Output: the final checklist with every box checked or a blocker, and the exact text blocks I paste into DoraHacks.

**Micro-prompts (use anytime):**
- "Something KeeperHub-related just surprised us — before fixing, add the dated FRICTION.md entry with a proposed fix, then fix."
- "We just produced demo-worthy output — append it to docs/evidence/EVIDENCE.md with links before we move on."
- "Gut-check against the judging criteria: for each of the 5, what's our current proof, and what's the cheapest improvement?"
