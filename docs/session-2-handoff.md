# Session 2 handoff — what Claude needs from you (human-only steps)

Session 1 shipped the offline-testable core. Everything below needs a human
because it involves accounts, browsers, funds, or OAuth. Numbered in the order
that unblocks the most work soonest.

## Blocking Session 2 (do these first)

1. **Create the GitHub repo and push.**
   The repo is committed locally but has no remote. Do a 30-second `ripcord crypto`
   collision search first (build guide §5.2), then:
   ```bash
   gh repo create ripcord --private --source=. --remote=origin --push
   ```
   Keep it private for now; it **must be public before submission**.

2. **Connect the KeeperHub MCP server** — this was the one Session-1 step I
   could not do, and it gates all of WF-1/WF-2 work:
   ```bash
   claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp
   claude mcp list          # confirm registered
   ```
   Then in-session run `/mcp` to authenticate (OAuth 2.1), and install the plugin:
   `/plugin marketplace add KeeperHub/claude-plugins`.
   First task in Session 2 will be re-introspecting the tools and diffing against
   [keeperhub-verification.md](keeperhub-verification.md).

3. **KeeperHub account + org wallet + API key.** Sign up, note the provisioned
   Turnkey org wallet address, generate a `kh_` API key, put it in `.env` as
   `KEEPERHUB_API_KEY`. (The key must start with `kh_` — config validation
   enforces that.)

## Needed for a live testnet run

4. **Base Sepolia ETH** for the monitored wallet, from a faucet (Alchemy /
   Coinbase / community — availability changes weekly; log friction if it's
   painful, that's bounty fuel).

5. **`MONITORED_ADDRESS`** in `.env` — the wallet whose Aave position Ripcord
   watches. Once set, `pnpm dev` switches from mock to live Sepolia reads
   automatically (the public RPC `https://sepolia.base.org` is the default, so
   an Alchemy key is optional).

6. **Aave Sepolia test tokens.** The market's USDC is the faucet-mintable
   `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` (**not** Circle's `0x036CbD…`).
   Mint some, and wrap a little ETH → WETH for collateral.
   `pnpm exec tsx scripts/setup-position.ts --supply-eth 0.01 --borrow-usdc 10`
   prints the exact calls to make.

## Needed for the full pipeline

7. **`ANTHROPIC_API_KEY`** — switches the Planner/Critic from the deterministic
   heuristics to `claude-sonnet-5`. (You approved this model over the originally
   locked `claude-sonnet-4-6`, which is now a legacy snapshot.)

8. **Telegram bot** — talk to @BotFather, get `TELEGRAM_BOT_TOKEN`, then get
   your `TELEGRAM_CHAT_ID`. Without both, alerts are log-only.

9. **Optional: Alchemy RPC URLs** for `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL`.
   The public endpoints work but are rate-limited and explicitly "not suitable
   for production traffic" per Base's docs — worth having before the demo.

## Hackathon admin (not code-blocking, but time-sensitive)

10. **DoraHacks:** register, claim your BUIDL slot early (editable until the
    deadline). **Join the KeeperHub builder Discord** — office hours are free
    debugging, and one open question already needs asking there: *is private
    routing available on Base, and how is it enabled per workflow?* There is no
    docs page for it (see [keeperhub-verification.md](keeperhub-verification.md) §4),
    and the Phase-2 hero tx depends on the answer.

## Things you do NOT need to do

- Verify Aave addresses — done, against the official address book **and**
  on-chain, for both Base and Base Sepolia.
- Worry about the Anvil-fork fallback (build guide §6.9) — the Base Sepolia
  Aave V3 market is live with 6 reserves.
- Fund anything on mainnet yet. Nothing touches mainnet until Session 3, and
  even then only after I present a runbook and you explicitly say go.
