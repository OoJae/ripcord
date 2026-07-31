# Ripcord: A Grand-Prize Battle Plan for the KeeperHub "Agents Onchain" Hackathon

## TL;DR
- **Build "Ripcord": an autonomous, MEV-aware liquidation-protection / position-defense keeper agent that executes real defensive transactions on Base/Ethereum mainnet through KeeperHub, and monetizes its own risk engine as a paid x402/MPP marketplace workflow.** It maps directly onto KeeperHub's own thesis ("did it execute, and can we prove it"), hits the most scoring surfaces of any idea, and is genuinely useful — the exact profile that won the prior KeeperHub hackathon.
- **The Grand Prize is decided on execution and reliability, not polish.** Judges (KeeperHub engineers, ex-Sky/MakerDAO devops) reward real mainnet transactions, production rigor (tests, failure-mode handling, audit-trail usage), and integrations they can adopt. Avoid the cliché generic trading bot / yield rebalancer — that pattern already won last time and will be crowded.
- **Stack the $1,000 "Best Onboarding UX Improvement" bounty for free** by shipping a Ripcord starter template + a "zero-to-first-defensive-transaction in 10 minutes" tutorial + a merged documentation-fix PR (the docs contain at least one concrete, fixable bug). These fall directly out of building the champion and are judged separately.

---

## Key Findings

1. **KeeperHub is the "last mile" execution layer** — it takes an agent's *decision* and reliably lands the *transaction* on-chain, handling gas estimation, retries/backoff, nonce management, MEV-protected private routing, and a full audit trail. It was built by the Sky/MakerDAO (formerly MakerDAO) devops team and already powers Sky Protocol. It is open source and free during beta.
2. **The surfaces you can build on are unusually rich:** a hosted MCP server (30+ tools, OAuth), a `kh` CLI, a visual/AI workflow builder, x402 + MPP pay-per-execution (creator and caller sides), a workflow Marketplace indexed on x402scan/mppscan/8004scan, smart gas estimation, private routing, gas sponsorship, and a full audit trail. **Hitting many surfaces is criterion #2 and is the single biggest differentiation lever** — prior winners each hit only a subset.
3. **Execution is weighted heavily and "working transactions beat mockups" is stated policy.** The prior KeeperHub hackathon (ETHGlobal OpenAgents, ~180 builders) awarded only three main-track prizes and deliberately left two unfilled — the bar is real mainnet execution with production seriousness.
4. **The best use cases are ones KeeperHub already evangelizes:** treasury defense, liquidation protection, and onchain incident response. KeeperHub's own blog cites incidents like Moonwell's $1.78M bad debt (from the Feb. 15, 2026 incident, in which a configuration error caused its oracle to misprice Coinbase Wrapped ETH after governance proposal MIP-X43 enabled Chainlink OEV wrapper contracts, per The Block) and Aave's $27M liquidation event of March 10, 2026 (in which a configuration error in a risk-management tool caused inaccurate price calculations across several loan positions, per crypto.news) as "detectable before a single bot ran." Building squarely in that lane signals product-market fit to the judges.
5. **A subtle reliability trap doubles as a scoring opportunity:** KeeperHub's gas sponsorship only applies to transactions sent through the *public* mempool from a direct wallet — it is mutually exclusive with private (MEV-protected) routing and with Safe senders. Explicitly reasoning about that tradeoff in your build and demo is exactly the "failure-mode awareness" criterion #3 rewards.

---

## Details

### 1. How KeeperHub works and the exact surfaces available

**Core model.** Every KeeperHub automation is a *workflow*: a **trigger** (Manual, Schedule/cron, Webhook, Blockchain Event, or Block Interval) → **actions** (Web3 read/write, notifications via Discord/Slack/Telegram/SendGrid, HTTP, conditional branching, loops, Math aggregation, sandboxed Code) → with **conditions** gating expensive steps. Data flows between nodes via a reference syntax (`{{@nodeId:Label.field}}`). When a step fails, KeeperHub retries with configurable backoff and logs the full error context in a Runs panel.

**Wallets & security.** Every org gets a non-custodial **Turnkey** wallet with keys in a secure enclave (they never touch KeeperHub infra). **Safe** smart-account senders are supported. (Note: the "Para" wallet integration is discontinued — but is still referenced in one docs page, a bounty opportunity; see below.)

**Supported chains (stable):** Ethereum (1), Base (8453), Arbitrum One (42161), Optimism (10), Polygon (137); testnets Sepolia (11155111) and Base Sepolia (84532). 0G chains are experimental.

**The agent-native surfaces (the scoring gold):**
- **MCP server** — hosted at `https://app.keeperhub.com/mcp`, added in one line (`claude mcp add --transport http keeperhub …`), OAuth or `kh_` API key. Exposes 30+ tools: `create/validate/execute_workflow`, `get_execution` (status + step logs), `execute_transfer`, `execute_contract_call`, `execute_check_and_execute` (read → evaluate → act atomically), `execute_protocol_action` (e.g. `aave-v3/supply`), `ai_generate_workflow`, plus marketplace tools `search_workflows`/`call_workflow`/`list_workflow`. Every listed workflow is *also* a typed single-tool MCP server at `/mcp/w/<slug>` — better LLM tool-selection accuracy than the generic dispatcher.
- **CLI (`kh`)** — `brew install keeperhub/tap/kh`; direct execution via `kh execute contract-call` / `kh execute transfer`, run inspection via `kh run logs`/`kh run status`, wallet and workflow management.
- **Claude Code plugin** — `/plugin marketplace add KeeperHub/claude-plugins`; ships skills (`workflow-builder`, `execution-monitor`, `template-browser`, `plugin-explorer`) that activate on natural-language intent. This is the single most solo-builder-friendly surface, since the user builds with Claude Code.
- **x402 / MPP pay-per-execution.** Paid workflows settle in USDC on Base (x402) or USDC.e on Tempo (MPP). Callers use an agentic wallet; the first-party **KeeperHub agentic wallet** (`npx -p @keeperhub/wallet …`) has server-side Turnkey custody, a three-tier auto/ask/block `PreToolUse` safety hook, and hard server-side caps (≤100 USDC/transfer, 200 USDC/UTC-day, Base+Tempo USDC only). Agents pay no gas — a facilitator submits an EIP-3009 `TransferWithAuthorization` and covers gas.
- **Marketplace (creator side).** Publish a workflow with a slug, price ($0.001–$0.10 typical), and input/output schema; keep the node graph private; earn **70%** of each call (KeeperHub takes 30%). Listings ≥$0.05/call are exempt from your monthly execution quota. Your listing auto-registers on x402scan.com, mppscan.com, and 8004scan.io under KeeperHub's registration.
- **Smart gas estimation** — `eth_estimateGas` × a per-chain safety multiplier (Ethereum/Polygon 2.0×/2.5×, Base/Arbitrum 1.5×/2.0×), with an adaptive fee strategy and conservative multipliers for time-sensitive triggers.
- **Private routing** — MEV protection via non-public submission.
- **Gas sponsorship** — via Turnkey Gas Station on Ethereum/Base/Polygon/Arbitrum (+ testnets), metered against monthly gas credits. **Only for direct-wallet senders on the public mempool** — not Safe senders, not private-routed transactions.
- **Audit trail** — every run logs trigger, simulation, submitted tx, gas used, outcome, and timestamp; replayable from one place.

### 2. What actually wins this hackathon

**Evidence from the prior KeeperHub hackathon (ETHGlobal OpenAgents, Apr 2026, ~180 builders, only 3 main winners — self-reported by KeeperHub's wrap-up blog):**
- **Tradewise Agentlab** — an onchain agent quoting Uniswap swaps for x402 USDC payments on Base Sepolia; every paid call fired three KeeperHub workflows (heartbeat, reputation cache, compliance attestation); shipped with 125 tests and a live deployment. *Lesson: production seriousness + real x402→KeeperHub flow.*
- **Keeper-Gate** — a framework-agnostic SDK wrapping KeeperHub as native tools inside LangChain/ElizaOS/OpenClaw. *Lesson: reusable integrations KeeperHub can adopt win.*
- **ZW.ARM** — a three-agent yield-rotation system on **Base mainnet with real USDC**, ~450 confirmed transactions, plus an independent "critique" agent that challenges every decision before execution. *Lesson: mainnet execution + multi-agent safety/critique + observability.*

**Synthesizing what the judges value:** (1) real, verifiable **mainnet** transactions over demos; (2) **production rigor** — tests, retries, gas handling, explicit failure-mode reasoning, audit-trail usage; (3) integrations they could **merge or build on**; (4) **native surfaces** (MCP and x402 were the "right" integrations; ~52/180 teams used MCP, ~40 used x402); (5) **multi-agent patterns** where one agent decides and another critiques before KeeperHub executes; (6) **honest product feedback** (rewarded with a dedicated bounty then, mirrored by the Onboarding UX bounty now).

**What to avoid:** generic DeFi trading bots and portfolio/yield rebalancers. Yield rotation *already won* (ZW.ARM), so a similar entry is both derivative and crowded. AI-agent projects have become one of the largest single categories of hackathon submissions industry-wide, so undifferentiated "agent that trades" entries are among the most saturated.

**On x402/MPP as a theme:** x402 (Coinbase) had, as of April 21, 2026, roughly 69,000 active AI agents that had processed over 165 million transactions totaling $50 million in cumulative volume (figures Coinbase released the week it launched Agent.market, per Cryptonews); the average transaction runs about $0.20–$0.30. MPP (Stripe + Tempo) launched March 18, 2026 — the same day Tempo's Stripe-and-Paradigm-built payments L1 went to mainnet — introducing a "sessions" primitive that lets agents authorize a spending limit upfront and stream micropayments continuously (per The Defiant), with the streaming primitive extended at Stripe Sessions 2026 (Apr. 29–30, 2026). But a CoinDesk analysis (Mar. 11, 2026) noted that "despite a roughly $7 billion ecosystem valuation, onchain data shows that x402 currently processes only about $28,000 in daily volume, much of it from testing and 'gamed' transactions rather than real commerce" (source data Artemis: ~131,000 tx/day averaging ~$0.20). So lean on x402/MPP for *surface coverage and novelty*, but anchor your project's real-world usefulness in something people genuinely run (defense/automation), not in speculative agent-commerce volume.

### 3. Five project ideas

For each: concept · why it wins on the 5 criteria · surfaces exercised · architecture · 13-day solo feasibility · demo wow · pitch · risks.

---

**Idea 1 — RIPCORD (CHAMPION): MEV-aware liquidation-protection & position-defense keeper.**
- **Concept.** An agent watches a DeFi debt position (Aave V3 / Morpho / Spark) on mainnet. When the health factor approaches a danger threshold, the agent decides on a defense (repay debt, add collateral, or partially unwind), simulates it, and lands it through KeeperHub with retries, smart gas, and **private routing** so a liquidator/MEV bot can't front-run the rescue. A second "critique" agent validates the action before execution. As a differentiator layer, Ripcord publishes its **risk-scoring engine as a paid x402/MPP workflow** so other agents can pay ~$0.02 to query a position's risk — a self-funding loop.
- **Criteria fit.** (1) Real mainnet defensive tx via KeeperHub. (2) Hits the most surfaces: MCP, workflow builder, protocol actions (Aave/Morpho/Spark), private routing, smart gas, audit trail, gas sponsorship (with the tradeoff called out), x402+MPP marketplace. (3) Reliability *is the product* — retries, gas spikes, MEV, failure modes, audit provenance. (4) KeeperHub literally blogs about this exact problem; people run liquidation protection. (5) Clean multi-agent design + self-funding x402 loop shows DX depth.
- **Architecture.** LangGraph (or a lean custom TS agent) as the brain → KeeperHub MCP for reads/writes → an event/block/schedule trigger on health factor → condition node gates the defense → `execute_protocol_action`/`execute_contract_call` with private routing → Discord/Telegram alert with tx hash → audit trail. Risk engine published via `list_workflow`.
- **Feasibility (13d).** High. Core defensive keeper is buildable in days; x402 monetization is a layered stretch, not a dependency.
- **Demo wow.** Live: push a position toward liquidation on a fork/testnet, watch Ripcord detect → critique → privately route the rescue → health factor recover, then show the audit trail replay and a paying agent hitting the risk workflow on x402scan.
- **Pitch.** "Agents can decide to save a position; Ripcord is how the rescue actually lands before the liquidators do."
- **Risks.** Reproducing a believable liquidation scenario on mainnet safely; mitigate with a small real position + testnet dramatization. The private-routing-vs-gas-sponsorship exclusivity must be handled deliberately.

**Idea 2 — TOLL: two-sided agent-to-agent commerce service.**
- **Concept.** An agent that both *sells* a useful onchain service (e.g., a "safe-to-send?" address-risk check or a gas-optimal-time oracle) as a paid KeeperHub marketplace workflow, and *buys* from other x402 services, forming a self-funding economic loop, with ERC-8004 identity/reputation.
- **Criteria fit.** Strongest on surfaces (x402, MPP, marketplace, agentic wallet, MCP, 8004scan) and originality; weaker on "would anyone run this" given thin real x402 demand.
- **Surfaces.** x402 + MPP (both sides), marketplace creator side, per-workflow MCP servers, agentic wallet, audit trail.
- **Feasibility.** High. **Risk:** overlaps last year's Tradewise; must differentiate via the two-sided self-funding loop and reputation.
- **Pitch.** "The first KeeperHub workflow that pays its own bills."

**Idea 3 — PAYSTREAM: autonomous stablecoin payroll / subscriptions.**
- **Concept.** An agent that runs recurring stablecoin payroll or subscription payouts on a schedule, using KeeperHub scheduled workflows + Superfluid streaming and/or MPP recurring "sessions," with balance checks, retries, and per-payee audit receipts.
- **Criteria fit.** Strong real-world usefulness and reliability story; medium originality; solid surface coverage (scheduling, Superfluid plugin, MPP, notifications, audit trail).
- **Feasibility.** High. **Risk:** payroll demos can look mundane on video; needs a crisp "money actually moved on-chain, on time, every time" hook.

**Idea 4 — WATCHTOWER: treasury circuit-breaker / incident-response agent.**
- **Concept.** Protocol/treasury-level defense: monitor contract events and invariants (large withdrawals, oracle deviation, ownership transfers); on an anomaly, the agent executes a protective action (pause, withdraw to safe, revoke approval) via private routing, with severity-routed alerts.
- **Criteria fit.** Extremely high DNA fit (KeeperHub's incident-response narrative) and reliability weight; originality high. **Risk:** overlaps Ripcord's "defensive execution" theme and is harder to demo convincingly (simulating an exploit). This is essentially the "protocol-scale" sibling of the champion; strong runner-up.
- **Surfaces.** Event triggers, condition branching, private routing, Safe, audit trail, notifications.

**Idea 5 — TREASURY COPILOT: natural-language → workflow DAO treasury ops (dev tool / dApp).**
- **Concept.** A copilot that turns plain-English treasury intents ("every Friday, if idle USDC > $50k, supply to Aave and alert Discord") into validated KeeperHub workflows on a Safe multisig, with a simulate-critique-execute loop.
- **Criteria fit.** Good DX/originality and uses `ai_generate_workflow` + Safe + audit trail; **weaker on criterion #1** (it orchestrates more than it uniquely executes) and risks looking like a thin wrapper over KeeperHub's own AI builder.
- **Feasibility.** Very high. **Risk:** differentiation from KeeperHub's built-in AI assistant.

### 4. Comparison matrix (1–5, higher is better)

| Idea | C1 Executes onchain | C2 Surfaces | C3 Reliability/obs | C4 Originality/use | C5 Integration/DX | Feasibility 13d | Differentiation vs prior winners | Total |
|---|---|---|---|---|---|---|---|---|
| **1. Ripcord (champion)** | 5 | 5 | 5 | 5 | 5 | 4 | 4 | **33** |
| 2. Toll | 4 | 5 | 3 | 4 | 5 | 4 | 2 | 27 |
| 3. PayStream | 4 | 4 | 4 | 3 | 4 | 5 | 4 | 28 |
| 4. Watchtower | 5 | 4 | 5 | 4 | 4 | 3 | 3 | 28 |
| 5. Treasury Copilot | 3 | 4 | 3 | 3 | 4 | 5 | 3 | 25 |

Ripcord leads because it maximizes the two heaviest-weighted criteria (execution + reliability) while also topping surface coverage and usefulness, and it is differentiated from all three prior winners.

### 5. The Champion — Ripcord: full build plan

**Why Ripcord over the rest (against every variable).** It is the only idea that simultaneously (a) executes real, verifiable defensive transactions on mainnet — criterion #1; (b) makes reliability/observability the *product*, not an afterthought — criterion #3, heavily weighted; (c) touches the widest set of KeeperHub surfaces including the underused x402/MPP marketplace *creator* side — criterion #2; (d) solves a problem KeeperHub publicly cares about and real users run — criterion #4; and (e) demonstrates clean multi-agent + payment integration — criterion #5. It borrows the winning DNA of all three prior champions (Tradewise's x402 flow, ZW.ARM's mainnet execution + critique agent, Keeper-Gate's clean integration) without copying any of their concepts. The name carries the story: a ripcord is the thing you pull seconds before impact — and it has to deploy, every time.

**Architecture.**
- **Brain:** a lean agent (LangGraph or custom TypeScript, since the user builds fast with Claude Code and TS pairs cleanly with the MCP surface). Two roles: a *Planner* that proposes a defense and a *Critic* that must approve before execution.
- **Sensing:** KeeperHub Block Interval / Schedule trigger + `read-contract`/`execute_protocol_action` to pull health factor and prices from Aave V3 (and Morpho/Spark as stretch).
- **Deciding:** condition node gates on threshold; Planner picks repay vs. add-collateral vs. unwind.
- **Executing:** `execute_check_and_execute` / `execute_contract_call` with **private routing**; smart gas with conservative multiplier; retries/backoff.
- **Observing:** audit trail + Telegram/Discord alert with the tx hash and the decision rationale.
- **Monetizing (stretch):** publish the risk-scoring workflow via `list_workflow` at $0.05/call (quota-exempt), callable by other agents through x402/MPP; verify on x402scan.

**Milestone timeline (today = Jul 30; deadline Aug 13, 12:00 UTC+2; aim to finish Aug 11 with a 2-day buffer).**
- **Jul 30–31 (Days 1–2):** Grab the `ripcord` GitHub repo name immediately (plus a 30-second `ripcord crypto` collision check). Account + Turnkey wallet; connect MCP (`claude mcp add …`) and the Claude Code plugin; fund Sepolia/Base Sepolia; run `mcp-test`; first `execute_transfer` on testnet. Read the OpenZeppelin Defender / Gelato migration guides (frames the pitch and the bounty).
- **Aug 1–3 (Days 3–5):** Build the sensing + decision loop on Base Sepolia against a mock/forked Aave position; wire the Planner/Critic; get a defensive `execute_contract_call` landing reliably with retries.
- **Aug 4–6 (Days 6–8):** Move to **Base mainnet** with a small real position; enable **private routing**; deliberately test failure modes (gas spike, revert, nonce) and capture audit-trail replays. Decide gas-sponsorship vs. private-routing per action and document the reasoning.
- **Aug 7–8 (Days 9–10):** Stretch: publish the risk-scoring workflow to the Marketplace; call it from a second agentic wallet via x402; confirm it on x402scan/mppscan. Write tests (mirror Tradewise's rigor).
- **Aug 9–10 (Days 11–12):** Record the demo video; write the README + architecture doc; produce the onboarding-bounty deliverables (below).
- **Aug 11 (Day 13):** Final dry run of every submission link (repo public, video plays, tx link resolves on Basescan, x402scan listing live). Submit. Keep Aug 12–13 as buffer.

**Exact transactions to showcase.** (1) The hero: a real Base-mainnet defensive tx (e.g., Aave V3 `repay` or `supply` that raises health factor) submitted via private routing, linked on Basescan, with the matching audit-trail record (trigger → simulation → submitted tx → gas → outcome → timestamp). (2) A paid x402 call to your published risk-scoring workflow, visible on x402scan. (3) A deliberately-failed-then-retried run to prove the reliability story on video.

**How to max every criterion.** #1: link the mainnet tx prominently and narrate it first. #2: enumerate the surfaces touched in the README with links. #3: show the retry/backoff, the gas-sponsorship-vs-private-routing decision, and an audit-trail replay. #4: open with the Moonwell/Aave incident framing. #5: ship tests, a clean README, and the self-funding x402 loop.

**Demo video structure (≤3 min).** 0:00 hook — "A position is 30 seconds from impact. Watch Ripcord deploy: the rescue lands before the MEV bots." 0:20 architecture (Planner→Critic→KeeperHub). 0:45 live detection → critique → private-routed rescue on mainnet → health factor recovers. 1:45 audit-trail replay + a forced failure that retries and still lands. 2:20 the risk engine earning USDC via x402 on x402scan. 2:45 close on the KeeperHub thesis.

**Finalist pitch angle (live, Aug 17–19).** "Every agent framework can *decide* to protect a position. Almost none can guarantee the *rescue transaction actually lands* under gas spikes and MEV. Ripcord is that guarantee, built on KeeperHub — the chute that always opens. And it pays for itself." Lead with the mainnet tx hash and the audit trail; that is the proof the judges are optimizing for.

### 6. Bounty-stacking plan (Best Onboarding UX Improvement, $1,000 split two ways)

The bounty rewards whatever most improves the new-builder zero-to-first-transaction path: a merged PR to the KeeperHub repo, a starter template, a tutorial, or an onboarding-friction teardown with fixes. All four fall out of building Ripcord:
- **Starter template (highest leverage):** publish a "Ripcord Starter" — a minimal liquidation-protection keeper repo + a deployable KeeperHub template that gets a newcomer from signup to a first defensive testnet transaction in one command. Templates are a first-class KeeperHub concept (`deploy_template`), so this is directly adoptable.
- **"Zero-to-first-defensive-tx in 10 minutes" tutorial:** a step-by-step guide using the exact commands you'll have run (MCP add, wallet fund, first `execute_transfer`, first protocol action). Screen-recorded.
- **Merged documentation-fix PR:** the docs are open source ("Edit this page on GitHub"). At least one concrete, mergeable bug exists — the Gas Management page's "Wallet Funding" section still instructs readers to fund a **Para wallet**, though Para is discontinued and superseded by Turnkey. Fixing that (and any other stale references you hit) is a clean merged-PR candidate that judges will see as real onboarding friction removed.
- **Onboarding teardown:** while building, log every friction point (e.g., the private-routing/gas-sponsorship exclusivity being non-obvious; the two API-key systems `kh_` vs `wfb_`; the deprecated local `kh serve --mcp`), and submit a prioritized teardown with proposed fixes — mirroring the honest-feedback style KeeperHub rewarded last time.

Do the template + tutorial + one merged doc PR; that trio is the most credible path to one of the two bounty slots while the Grand-Prize build proceeds in parallel.

---

## Recommendations

1. **Commit to Ripcord now and get a testnet transaction landing within 48 hours.** The fastest signal you're on track is a real `execute_transfer` on Base Sepolia through the MCP server by Aug 1.
2. **Get to Base mainnet by Aug 6.** The prior grand-style winners executed on mainnet; a testnet-only entry caps your ceiling. Use a small real position and KeeperHub's gas credits.
3. **Make reliability visible, not implied.** Put the retry/backoff, the private-routing decision, and an audit-trail replay *on camera*. This is the heavily-weighted criterion most entrants will neglect.
4. **Layer the x402 monetization only after the defensive core is rock-solid.** It's the differentiator, not the foundation — don't let it jeopardize criterion #1.
5. **Ship the bounty trio (template + tutorial + doc PR) in the Aug 9–11 window** so both prizes are in reach without competing for build time.

**Benchmarks that should change your plan:** If by **Aug 4** the mainnet defensive tx isn't landing reliably, cut the x402 layer and Morpho/Spark, and ship a bulletproof single-protocol (Aave V3) Base-mainnet keeper — a narrow, flawless execution beats a broad, flaky one under these judging criteria. If the BUIDL gallery (checkable in-browser) shows the field crowded with liquidation/defense agents, pivot the framing toward **Watchtower** (protocol-scale incident response) which is less likely to be duplicated, reusing ~90% of the same code.

## Caveats

- **Live submission field is not yet visible.** As of Jul 30 the hackathon is ~3 days into its build phase and the DoraHacks BUIDL gallery is JavaScript-rendered and not reliably fetchable; competitor projects couldn't be enumerated. Check it in a browser mid-build to confirm crowding.
- **Prior-winner details are self-reported** by KeeperHub's own wrap-up blog; treat the specific metrics (e.g., ZW.ARM's ~450 transactions, Tradewise's 125 tests) as the organizer's account, not independently audited.
- **x402/MPP real demand is early and partly speculative** (CoinDesk flagged ~$28,000 real daily volume in early 2026, much of it test/"gamed"). This is why Ripcord anchors usefulness in defense, using x402 as a surface-coverage and novelty layer rather than the core value.
- **Agentic-wallet hard caps** (≤100 USDC/transfer, 200 USDC/day, Base+Tempo USDC only) constrain how large a paid-workflow demo can be; keep monetization amounts small.
- **Gas sponsorship excludes private routing and Safe senders** — you cannot have both MEV protection and sponsored gas on the same transaction; plan the demo accordingly.
- **The Moonwell ($1.78M, Feb 15 2026) and Aave ($27M, Mar 10 2026) incident figures** come from The Block and crypto.news respectively via KeeperHub's marketing; use them as framing, and cite the primary outlets rather than the KeeperHub blog if pressed.
