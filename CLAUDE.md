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
Phase 5 (submit). Update this line as phases complete: 0 setup ✅ · 1 testnet core ✅ · 2 mainnet+MEV-aware execution ✅ (private routing is Ethereum-only; tradeoff documented) · 3 x402 marketplace ✅ · 4 docs+video ✅ (live site, brand kit, 2:20 demo film) · 5 submitted ⬜

Development is complete — treat the daemon as frozen. Remaining work is submission only.
