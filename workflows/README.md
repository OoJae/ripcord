# KeeperHub workflows

Exported workflow definitions + per-workflow README land here in Session 2 (built via the KeeperHub MCP server / builder).

## WF-1 `hf-monitor` (planned)
Schedule trigger (~5 min) → read `Pool.getUserAccountData(MONITORED_ADDRESS)` → condition `healthFactor < warn (1.50)` → Telegram warning.
Purpose: redundant sensing — monitoring survives even if the Ripcord daemon dies.

## WF-2 `defend` (planned)
**Webhook trigger** (payload: `decisionId`, `action`, `assetSymbol`, `assetAddress`, `amountBaseUnits`, `amountUsd`, `minHfAfter`, `monitoredAddress` — field casing `// VERIFY:` against the live builder) → **onchain re-verify HF** (check-and-execute pattern: never trust a stale decision; require `healthFactor < warn` and post-tx `≥ minHfAfter`) → contract call (`Pool.repay` / `Pool.supply`) → notify with tx hash.
Mainnet (Session 3): private routing enabled for this workflow; self-paid gas (sponsorship is mutually exclusive with private routing).

## WF-3 `risk-score` (stretch, Session 4)
Input `{chain, address}` → reads → code node scoring → JSON out. Listed on the Marketplace at $0.05/call.
