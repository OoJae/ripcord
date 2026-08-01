/**
 * Core domain types + the interfaces every subsystem implements.
 * This file is the contract between modules — keep it dependency-free.
 */

export type Chain = "base" | "base-sepolia";
export type Band = "healthy" | "warn" | "act" | "panic";
/** Assets Ripcord may supply as collateral. Which one is live is per-chain. */
export type CollateralSymbol = "WETH" | "cbETH";
/** Every asset Ripcord can name. Debt is always USDC; collateral is chain-specific. */
export type AssetSymbol = "USDC" | CollateralSymbol;
export type Address = `0x${string}`;

// ---------------------------------------------------------------------------
// Thresholds / policy

export interface Thresholds {
  warn: number;
  act: number;
  panic: number;
  targetHf: number;
  rearm: number;
  cooldownSec: number;
}

/** Wad (1e18) encodings of the HF thresholds — band comparisons use these, never floats. */
export interface ThresholdsWad {
  warn: bigint;
  act: bigint;
  panic: bigint;
  targetHf: bigint;
  rearm: bigint;
  cooldownSec: number;
}

export interface Snapshot {
  timestampMs: number;
  chain: Chain;
  address: Address;
  /** Raw Aave health factor, 1e18 wad. Authoritative for band classification. */
  hfWad: bigint;
  /** Float view for display/LLM/velocity only. Infinity when no debt. */
  hf: number;
  hasDebt: boolean;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  liquidationThresholdBps: number;
  ltvBps: number;
  balances: {
    usdcRaw: bigint;
    usdcUsd: number; // USDC ≈ $1 (documented simplification)
    /** Wallet balance of THIS chain's collateral asset, in base units. */
    collateralRaw: bigint;
    /** …and in whole tokens. No price feed in Session 1, so this is not USD. */
    collateralAmount: number;
    collateralSymbol: CollateralSymbol;
  };
  /** Δ HF per minute over the last 3 samples; null until 3 samples exist. */
  hfVelocityPerMin: number | null;
}

export interface PolicyState {
  /** Hysteresis latch; re-arms only when hfWad > rearm (strict). */
  armed: boolean;
  /** Cooldown anchor (rehydrated from the executions table on restart). */
  lastFiredAtMs: number | null;
  /** For transition-only notifications. */
  lastBand: Band;
}

export interface PolicyResult {
  band: Band;
  shouldDefend: boolean;
  /** True only in panic (skips cooldown + hysteresis; gas hint for Session 2). */
  expedited: boolean;
  reason: string;
  nextState: PolicyState;
}

// ---------------------------------------------------------------------------
// Agents

export interface PlannerProposal {
  action: "repay" | "supplyCollateral" | "none";
  asset: AssetSymbol;
  amountUsd: number;
  expectedHfAfter: number;
  rationale: string;
}

export interface CriticVerdict {
  verdict: "APPROVE" | "REJECT";
  reason: string;
}

export interface Caps {
  maxTxUsd: number;
  dailyCapUsd: number;
  minHfImprovement: number;
}

/** Minimal LLM seam — production wraps the Anthropic SDK; tests inject a fake. */
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export interface DecisionSummary {
  createdAtMs: number;
  band: Band;
  status: DecisionStatus;
  action?: PlannerProposal["action"];
  amountUsd?: number;
}

export interface PlannerContext {
  snapshot: Snapshot;
  thresholds: Thresholds;
  caps: Caps;
  recentDecisions: DecisionSummary[];
}

export interface PlanResult {
  proposal: PlannerProposal;
  /** Raw model output for the evidence trail; null for deterministic planners. */
  raw: string | null;
}

export interface CritiqueResult {
  verdict: CriticVerdict;
  raw: string | null;
}

export interface Planner {
  plan(ctx: PlannerContext): Promise<PlanResult>;
}

/** The Critic sees ONLY the snapshot + proposal (independence from the Planner). */
export interface Critic {
  critique(
    snapshot: Snapshot,
    proposal: PlannerProposal,
    thresholds: Thresholds,
    caps: Caps,
  ): Promise<CritiqueResult>;
}

// ---------------------------------------------------------------------------
// Guard

export type GuardDecision = "execute" | "dry-run" | "blocked";
export type GuardRuleId =
  | "action-none"
  | "critic-approval"
  | "allowlist"
  | "amount-positive"
  | "max-tx-usd"
  | "daily-cap"
  | "min-hf-improvement"
  | "hf-claim-honesty"
  | "snapshot-provenance"
  | "idempotency"
  | "arm-flag"
  | "dry-run";

export interface GuardCheck {
  rule: GuardRuleId;
  passed: boolean;
  detail: string;
}

export interface GuardViolation {
  rule: GuardRuleId;
  detail: string;
}

export interface GuardResult {
  decision: GuardDecision;
  /** Every failed rule (all rules are evaluated; nothing short-circuits). */
  violations: GuardViolation[];
  /** Full evaluation trail for logs/audit — includes passing checks. */
  checks: GuardCheck[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Executor (KeeperHub)

/**
 * The wire contract with WF-2. Field names and casing are VERIFIED against the
 * live workflow (2026-08-01) — WF-2's nodes read them as
 * `{{@trigger-1:Trigger.<field>}}`, so renaming one here silently breaks the
 * workflow's template references. The executor wraps this in {"input": …}.
 *
 * Mirrored by WF-2's `webhookSchema`; see workflows/wf2-defend.json.
 */
export interface DefensePayload {
  decisionId: string; // ULID — idempotency key end to end
  chain: Chain;
  action: "repay" | "supplyCollateral";
  assetSymbol: AssetSymbol;
  /** Resolved from the config allowlist, NEVER from LLM output. */
  assetAddress: Address;
  /** bigint token base units as string (JSON-safe). */
  amountBaseUnits: string;
  amountUsd: number;
  /** Target HF the defense is sized to reach (= thresholds.targetHf). Recorded
   *  for audit; WF-2's own gate re-derives its decision from chain state. */
  minHfAfter: number;
  monitoredAddress: Address;
}

export interface TriggerResult {
  runId: string;
  raw: unknown;
}

/** Verified against docs.keeperhub.com/api/executions (2026-07-30). */
export type RunState = "pending" | "running" | "success" | "error" | "cancelled";

export interface RunTxHash {
  hash: string;
  chainId?: number;
  network?: string;
  nodeName?: string;
}

export interface RunStatus {
  runId: string;
  state: RunState;
  /** First tx hash, if any — convenience for notifications. */
  txHash?: string;
  txHashes?: RunTxHash[];
  error?: string;
  /** Always retain the full response for evidence. */
  raw: unknown;
}

export interface KeeperHubClient {
  triggerDefense(payload: DefensePayload): Promise<TriggerResult>;
  getRun(runId: string): Promise<RunStatus>;
}

// ---------------------------------------------------------------------------
// Sensor / notifier / clock

export interface Sensor {
  read(): Promise<Snapshot>;
}

export interface DecisionNotification {
  kind: "band-change" | "defense" | "blocked" | "error";
  chain: Chain;
  band: Band;
  decisionId: string;
  dryRun: boolean;
  hf?: number;
  action?: PlannerProposal["action"];
  asset?: AssetSymbol;
  amountUsd?: number;
  expectedHfAfter?: number;
  rationale?: string;
  txHash?: string;
  runId?: string;
  detail?: string;
}

export interface Notifier {
  notify(n: DecisionNotification): Promise<void>;
}

export interface Clock {
  now(): number;
}

// ---------------------------------------------------------------------------
// State (SQLite)

export type DecisionStatus =
  | "observed"
  | "planner_invalid"
  | "critic_invalid"
  | "rejected"
  | "blocked"
  | "dry_run"
  | "executing"
  | "executed"
  | "failed";

export type ExecutionStatus = "triggered" | "running" | "success" | "error" | "timeout";

export interface DecisionRow {
  decisionId: string;
  createdAtMs: number;
  chain: Chain;
  band: Band;
  hf: number;
  snapshotJson: string;
  proposalJson?: string | null;
  plannerRaw?: string | null;
  criticVerdict?: "APPROVE" | "REJECT" | null;
  criticReason?: string | null;
  guardDecision?: GuardDecision | null;
  guardViolationsJson?: string | null;
  guardChecksJson?: string | null;
  status: DecisionStatus;
}

export interface ExecutionRow {
  decisionId: string;
  runId?: string | null;
  requestedAtMs: number;
  completedAtMs?: number | null;
  status: ExecutionStatus;
  action: "repay" | "supplyCollateral";
  assetSymbol: AssetSymbol;
  /** Integer cents — money arithmetic is exact, never floats. */
  amountUsdCents: number;
  txHash?: string | null;
  gasUsed?: string | null;
  rawRunJson?: string | null;
}

export interface RipcordDb {
  insertDecision(row: DecisionRow): void;
  updateDecision(decisionId: string, patch: Partial<Omit<DecisionRow, "decisionId">>): void;
  hasExecution(decisionId: string): boolean;
  insertExecution(row: ExecutionRow): void;
  updateExecutionByDecision(
    decisionId: string,
    patch: Partial<Omit<ExecutionRow, "decisionId">>,
  ): void;
  /** Rolling-window spend in integer cents; counts fail-closed statuses (see db.ts). */
  spentCentsSince(sinceMs: number): number;
  /** Most recent defense attempt (for cooldown rehydration); null if none. */
  lastDefenseAt(): number | null;
  recentDecisions(n: number): DecisionRow[];
  recentExecutions(n: number): ExecutionRow[];
  close(): void;
}

// ---------------------------------------------------------------------------
// Address book

export interface KnownAddress {
  address: Address;
  /** True only after checking the official Aave Address Book / on-chain. */
  verified: boolean;
  source: string;
}

/** The collateral asset for a chain, carrying its symbol and decimals. */
export interface CollateralAsset extends KnownAddress {
  symbol: CollateralSymbol;
  decimals: number;
}

export interface AddressBook {
  aavePool: KnownAddress;
  /** The debt asset. Always USDC — `repay` is Ripcord's primary defense. */
  usdc: KnownAddress;
  /**
   * The collateral asset, which differs by chain: WETH on Base mainnet, cbETH on
   * Base Sepolia, where the WETH reserve is capped out (see FRICTION.md).
   */
  collateral: CollateralAsset;
}
