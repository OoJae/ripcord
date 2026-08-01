/**
 * SQLite state store (better-sqlite3) — the evidence trail and the source of
 * truth for spend accounting and cooldown rehydration after a restart.
 *
 * SAFETY INVARIANTS
 * - spentCentsSince counts EVERY execution status ('triggered','running',
 *   'success','error','timeout'). Fail-closed: an errored or timed-out trigger
 *   may still have landed on-chain and spent funds, so it must count against
 *   the daily cap. Blocked and dry-run decisions never create execution rows
 *   at all, so they can never inflate spend.
 * - Money is integer cents end to end; no float arithmetic touches the cap.
 * - CHECK constraints reject any status/band/verdict outside the contract.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DecisionRow, ExecutionRow, LockAcquisition, RipcordDb } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  decision_id           TEXT PRIMARY KEY,
  created_at_ms         INTEGER NOT NULL,
  chain                 TEXT NOT NULL,
  band                  TEXT NOT NULL CHECK (band IN ('healthy','warn','act','panic')),
  hf                    REAL NOT NULL,
  snapshot_json         TEXT NOT NULL,
  proposal_json         TEXT,
  planner_raw           TEXT,
  critic_verdict        TEXT CHECK (critic_verdict IN ('APPROVE','REJECT')),
  critic_reason         TEXT,
  guard_decision        TEXT CHECK (guard_decision IN ('execute','dry-run','blocked')),
  guard_violations_json TEXT,
  guard_checks_json     TEXT,
  status                TEXT NOT NULL CHECK (status IN (
    'observed','planner_invalid','critic_invalid','rejected',
    'blocked','dry_run','executing','executed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions (created_at_ms DESC);

-- Single-instance advisory lock. Exactly one daemon may hold it per database.
-- Two daemons sharing one SQLite file DO serialize on rows, but each mints its
-- own ULID decisionIds, so the Guard's idempotency rule cannot see across
-- instances: both can pass the cooldown check before either records an
-- execution, and the position gets defended twice for one event. Phase 1
-- accidentally ran four daemons at once, so this is not hypothetical.
CREATE TABLE IF NOT EXISTS daemon_lock (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  pid            INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_ms   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id     TEXT NOT NULL UNIQUE REFERENCES decisions(decision_id),
  run_id          TEXT,
  requested_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('triggered','running','success','error','timeout')),
  action          TEXT NOT NULL,
  asset_symbol    TEXT NOT NULL,
  amount_usd_cents INTEGER NOT NULL,
  tx_hash         TEXT,
  gas_used        TEXT,
  raw_run_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_requested_at ON executions (requested_at_ms DESC);
`;

// ---------------------------------------------------------------------------
// camelCase <-> snake_case column maps for PATCH updates. decisionId is
// deliberately absent: it is the immutable key and must never be patched.

const DECISION_COLS = {
  createdAtMs: "created_at_ms",
  chain: "chain",
  band: "band",
  hf: "hf",
  snapshotJson: "snapshot_json",
  proposalJson: "proposal_json",
  plannerRaw: "planner_raw",
  criticVerdict: "critic_verdict",
  criticReason: "critic_reason",
  guardDecision: "guard_decision",
  guardViolationsJson: "guard_violations_json",
  guardChecksJson: "guard_checks_json",
  status: "status",
} as const;

const EXECUTION_COLS = {
  runId: "run_id",
  requestedAtMs: "requested_at_ms",
  completedAtMs: "completed_at_ms",
  status: "status",
  action: "action",
  assetSymbol: "asset_symbol",
  amountUsdCents: "amount_usd_cents",
  txHash: "tx_hash",
  gasUsed: "gas_used",
  rawRunJson: "raw_run_json",
} as const;

/** Optional fields absent from a row insert become explicit NULLs. */
const toParam = (v: unknown): unknown => (v === undefined ? null : v);

/**
 * Build "col1 = ?, col2 = ?" + params from the DEFINED keys of a patch.
 * undefined keys are untouched; an explicit null clears the column.
 */
function buildSet(
  patch: Record<string, unknown>,
  cols: Record<string, string>,
): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const col = cols[key];
    if (col === undefined) {
      throw new Error(`db: unknown patch key "${key}"`);
    }
    parts.push(`${col} = ?`);
    params.push(value);
  }
  return { clause: parts.join(", "), params };
}

// Raw row shapes as they come back from better-sqlite3 (snake_case, nulls).
interface RawDecisionRow {
  decision_id: string;
  created_at_ms: number;
  chain: string;
  band: string;
  hf: number;
  snapshot_json: string;
  proposal_json: string | null;
  planner_raw: string | null;
  critic_verdict: string | null;
  critic_reason: string | null;
  guard_decision: string | null;
  guard_violations_json: string | null;
  guard_checks_json: string | null;
  status: string;
}

interface RawExecutionRow {
  decision_id: string;
  run_id: string | null;
  requested_at_ms: number;
  completed_at_ms: number | null;
  status: string;
  action: string;
  asset_symbol: string;
  amount_usd_cents: number;
  tx_hash: string | null;
  gas_used: string | null;
  raw_run_json: string | null;
}

function mapDecision(r: RawDecisionRow): DecisionRow {
  return {
    decisionId: r.decision_id,
    createdAtMs: r.created_at_ms,
    chain: r.chain,
    band: r.band,
    hf: r.hf,
    snapshotJson: r.snapshot_json,
    proposalJson: r.proposal_json,
    plannerRaw: r.planner_raw,
    criticVerdict: r.critic_verdict,
    criticReason: r.critic_reason,
    guardDecision: r.guard_decision,
    guardViolationsJson: r.guard_violations_json,
    guardChecksJson: r.guard_checks_json,
    status: r.status,
  } as DecisionRow;
}

function mapExecution(r: RawExecutionRow): ExecutionRow {
  return {
    decisionId: r.decision_id,
    runId: r.run_id,
    requestedAtMs: r.requested_at_ms,
    completedAtMs: r.completed_at_ms,
    status: r.status,
    action: r.action,
    assetSymbol: r.asset_symbol,
    amountUsdCents: r.amount_usd_cents,
    txHash: r.tx_hash,
    gasUsed: r.gas_used,
    rawRunJson: r.raw_run_json,
  } as ExecutionRow;
}

export function openDb(path: string): RipcordDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  // WAL for durability/concurrency on file DBs; :memory: cannot WAL — ignore.
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // :memory: (or an odd filesystem) — journal mode is best-effort.
  }
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA); // idempotent: CREATE TABLE IF NOT EXISTS throughout

  const insertDecisionStmt = db.prepare(
    `INSERT INTO decisions (
      decision_id, created_at_ms, chain, band, hf, snapshot_json,
      proposal_json, planner_raw, critic_verdict, critic_reason,
      guard_decision, guard_violations_json, guard_checks_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertExecutionStmt = db.prepare(
    `INSERT INTO executions (
      decision_id, run_id, requested_at_ms, completed_at_ms, status,
      action, asset_symbol, amount_usd_cents, tx_hash, gas_used, raw_run_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const hasExecutionStmt = db.prepare("SELECT 1 FROM executions WHERE decision_id = ? LIMIT 1");

  // FAIL-CLOSED SPEND ACCOUNTING: every execution status counts — including
  // 'error' and 'timeout' — because a trigger that errored or timed out on our
  // side may still have landed on-chain and spent real funds. Undercounting
  // here would let the agent blow through the daily cap after flaky runs.
  // Blocked and dry-run decisions never create execution rows at all, so they
  // are structurally excluded from spend.
  const spentSinceStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_usd_cents), 0) AS total
     FROM executions
     WHERE requested_at_ms >= ?
       AND status IN ('triggered','running','success','error','timeout')`,
  );

  const lastDefenseStmt = db.prepare("SELECT MAX(requested_at_ms) AS latest FROM executions");

  const recentDecisionsStmt = db.prepare(
    "SELECT * FROM decisions ORDER BY created_at_ms DESC LIMIT ?",
  );

  const recentExecutionsStmt = db.prepare(
    "SELECT * FROM executions ORDER BY requested_at_ms DESC LIMIT ?",
  );

  const selectLockStmt = db.prepare("SELECT pid, heartbeat_ms FROM daemon_lock WHERE id = 1");
  const insertLockStmt = db.prepare(
    "INSERT INTO daemon_lock (id, pid, acquired_at_ms, heartbeat_ms) VALUES (1, ?, ?, ?)",
  );
  const takeoverLockStmt = db.prepare(
    "UPDATE daemon_lock SET pid = ?, acquired_at_ms = ?, heartbeat_ms = ? WHERE id = 1",
  );
  const refreshLockStmt = db.prepare(
    "UPDATE daemon_lock SET heartbeat_ms = ? WHERE id = 1 AND pid = ?",
  );
  const releaseLockStmt = db.prepare("DELETE FROM daemon_lock WHERE id = 1 AND pid = ?");

  // The whole read-decide-write must be one transaction: two daemons starting
  // in the same instant must serialize here, not both observe "no lock".
  const acquireLockTxn = db.transaction(
    (pid: number, nowMs: number, staleMs: number): LockAcquisition => {
      const row = selectLockStmt.get() as { pid: number; heartbeat_ms: number } | undefined;
      if (row === undefined) {
        insertLockStmt.run(pid, nowMs, nowMs);
        return { acquired: true };
      }
      if (row.pid === pid) {
        // Re-entrant: the same process re-acquiring its own lock is harmless.
        refreshLockStmt.run(nowMs, pid);
        return { acquired: true };
      }
      const heartbeatAgeMs = nowMs - row.heartbeat_ms;
      if (heartbeatAgeMs > staleMs) {
        // The holder died without releasing (crash, SIGKILL): take over.
        takeoverLockStmt.run(pid, nowMs, nowMs);
        return { acquired: true, tookOverStalePid: row.pid };
      }
      return { acquired: false, holderPid: row.pid, heartbeatAgeMs };
    },
  );

  return {
    insertDecision(row: DecisionRow): void {
      insertDecisionStmt.run(
        row.decisionId,
        row.createdAtMs,
        row.chain,
        row.band,
        row.hf,
        row.snapshotJson,
        toParam(row.proposalJson),
        toParam(row.plannerRaw),
        toParam(row.criticVerdict),
        toParam(row.criticReason),
        toParam(row.guardDecision),
        toParam(row.guardViolationsJson),
        toParam(row.guardChecksJson),
        row.status,
      );
    },

    updateDecision(decisionId, patch): void {
      const { clause, params } = buildSet(patch, DECISION_COLS);
      if (clause === "") return; // nothing defined to update
      db.prepare(`UPDATE decisions SET ${clause} WHERE decision_id = ?`).run(...params, decisionId);
    },

    hasExecution(decisionId: string): boolean {
      return hasExecutionStmt.get(decisionId) !== undefined;
    },

    insertExecution(row: ExecutionRow): void {
      insertExecutionStmt.run(
        row.decisionId,
        toParam(row.runId),
        row.requestedAtMs,
        toParam(row.completedAtMs),
        row.status,
        row.action,
        row.assetSymbol,
        row.amountUsdCents,
        toParam(row.txHash),
        toParam(row.gasUsed),
        toParam(row.rawRunJson),
      );
    },

    updateExecutionByDecision(decisionId, patch): void {
      const { clause, params } = buildSet(patch, EXECUTION_COLS);
      if (clause === "") return;
      db.prepare(`UPDATE executions SET ${clause} WHERE decision_id = ?`).run(
        ...params,
        decisionId,
      );
    },

    spentCentsSince(sinceMs: number): number {
      const row = spentSinceStmt.get(sinceMs) as { total: number };
      return row.total;
    },

    lastDefenseAt(): number | null {
      const row = lastDefenseStmt.get() as { latest: number | null };
      return row.latest;
    },

    recentDecisions(n: number): DecisionRow[] {
      return (recentDecisionsStmt.all(n) as RawDecisionRow[]).map(mapDecision);
    },

    recentExecutions(n: number): ExecutionRow[] {
      return (recentExecutionsStmt.all(n) as RawExecutionRow[]).map(mapExecution);
    },

    acquireDaemonLock(pid: number, nowMs: number, staleMs: number): LockAcquisition {
      return acquireLockTxn(pid, nowMs, staleMs);
    },

    refreshDaemonLock(pid: number, nowMs: number): boolean {
      return refreshLockStmt.run(nowMs, pid).changes > 0;
    },

    releaseDaemonLock(pid: number): void {
      releaseLockStmt.run(pid);
    },

    close(): void {
      db.close();
    },
  };
}
