# Session 2 handoff — what Claude needs from you (human-only steps)

Session 1 shipped the offline-testable core. Everything below needs a human
because it involves accounts, browsers, funds, or OAuth. Numbered in the order
that unblocks the most work soonest.

## Which Turnkey wallet Ripcord uses

The KeeperHub org has two Turnkey EOAs. **Ripcord uses the EVM one:**

| Wallet | Address | Use |
|---|---|---|
| **Turnkey EOA (EVM Compatible)** | `0x30C8…f27a` — multi-chain | ✅ **This one.** Base is EVM; every Aave `supply`/`borrow`/`repay`/`approve` is signed by it, and it is the account that holds the monitored position. |
| Turnkey EOA (SVM Compatible) | `J4RkjA…4LJj` — Solana | ❌ Not used. Solana-only; Aave V3 on Base is unreachable from it. |

Two consequences worth being explicit about:

- **`MONITORED_ADDRESS` should be the full `0x30C8…f27a` address.** Ripcord watches
  the position that the executing wallet owns, so the sensor target and the
  KeeperHub signer are the same account. (Aave's `repay`/`supply` do accept an
  `onBehalfOf` other than the sender, so a split is *possible* — but keeping them
  identical is simpler, and it means the Guard's `snapshot-provenance` rule
  double-checks the very account we sign for.)
- **Fund `0x30C8…f27a`**, not the Solana one: Base Sepolia ETH now, and a small
  Base mainnet balance in Session 3.

Grab the full address from the KeeperHub Organization Wallet dialog (the UI
truncates it) and put it in `.env`.

## Blocking Session 2 (do these first)

1. ~~**Create the GitHub repo and push.**~~ ✅ **Done** —
   <https://github.com/OoJae/ripcord> (private, `main` pushed, CI green).
   It **must be made public before submission**: `gh repo edit OoJae/ripcord --visibility public`.

2. **Authenticate the KeeperHub MCP server.** The server is already *registered*
   by the `keeperhub@keeperhub-plugins` plugin at `https://app.keeperhub.com/mcp`
   — `claude mcp list` shows it as "Needs authentication". Only the auth step is
   left, and it cannot be done non-interactively. Either:
   - **OAuth (preferred):** run `/mcp` in an interactive Claude Code session,
     pick `keeperhub`, and approve in the browser; or
   - **Headless:** create an org API key at app.keeperhub.com (avatar → API Keys →
     Organisation → New API Key; starts with `kh_`, shown once), then set
     `KH_API_KEY=kh_…` in your environment and restart Claude Code.

   Verify with `/keeperhub:status`. First task in Session 2 is re-introspecting the
   tools and diffing against [keeperhub-verification.md](keeperhub-verification.md).

3. **KeeperHub `kh_` API key into `.env`** as `KEEPERHUB_API_KEY` (the same key
   works for both the MCP auth above and the daemon's REST calls). Config
   validation enforces the `kh_` prefix.

   Note: you already have a workflow named **"Aave Health Factor Monitor"**
   (`zz5f7urg15v83k9kiugww`) in the org — that is essentially WF-1 `hf-monitor`.
   In Session 2 we'll reconcile it with the spec (it currently alerts Discord +
   email; the plan is Telegram) rather than building a duplicate.

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
