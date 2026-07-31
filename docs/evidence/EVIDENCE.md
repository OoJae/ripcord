# EVIDENCE.md — demo-worthy output index

Append-only index of screenshots, tx hashes, run IDs, and log captures. One entry per artifact: date · what · link/path.

| Date | What | Link / path |
|---|---|---|
| 2026-07-31 | Zero-secret mock loop: HF descent 1.82 → 1.21, act band fires, Critic APPROVE (recomputed 1.6003), 10/10 guard checks, DRY_RUN holds fire | `pnpm dev` — transcript excerpt in [README quickstart](../../README.md#quickstart-works-in-under-a-minute-zero-secrets) |
| 2026-07-31 | Live Base Sepolia read against the verified Aave V3 Pool `0x8bAB…AE27` over the public RPC; no-debt sentinel correctly maps to HF ∞ | verified locally; re-runnable with `MONITORED_ADDRESS=<addr> pnpm dev` |
| 2026-07-31 | KeeperHub API verification report (substitutes for the blocked MCP introspection) | [docs/keeperhub-verification.md](../keeperhub-verification.md) |

## Still to capture (Phase 0–2)

- [ ] First testnet tx through KeeperHub — Sepolia Basescan link + KeeperHub run screenshot (Phase 0 tracer bullet)
- [ ] Full hands-off testnet defense, 3 consecutive successes (Phase 1 AC)
- [ ] Critic REJECT moment — log + screenshot (Phase 1 AC)
- [ ] One failure → retry → success run (Phase 1 AC)
- [ ] **Hero tx:** private-routed mainnet defensive repay — Basescan + matching audit-trail record (Phase 2 AC)
- [ ] Gas-sponsored mainnet setup tx (demonstrates the sponsorship surface + the tradeoff)
- [ ] Chaos matrix, one evidence artifact per scenario (build guide §7.6)
- [ ] x402 paid call on x402scan (Phase 3, stretch)
