/**
 * db.ts tests — schema, round-trips, patch semantics, constraint enforcement
 * (failing cases), fail-closed spend accounting, and restart resume.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/state/db.js";
import type { DecisionRow, ExecutionRow, RipcordDb } from "../../src/types.js";

const T0 = 1_753_920_000_000;
const HOUR = 3_600_000;

function makeDecision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "01JD000000000000000000TEST",
    createdAtMs: T0,
    chain: "base-sepolia",
    band: "act",
    hf: 1.2,
    snapshotJson: JSON.stringify({ hf: 1.2, chain: "base-sepolia" }),
    proposalJson: JSON.stringify({ action: "repay", asset: "USDC", amountUsd: 10 }),
    plannerRaw: '{"action":"repay"}',
    criticVerdict: "APPROVE",
    criticReason: "sound",
    guardDecision: "execute",
    guardViolationsJson: "[]",
    guardChecksJson: JSON.stringify([{ rule: "allowlist", passed: true, detail: "ok" }]),
    status: "executing",
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    decisionId: "01JD000000000000000000TEST",
    runId: "run-1",
    requestedAtMs: T0,
    completedAtMs: null,
    status: "triggered",
    action: "repay",
    assetSymbol: "USDC",
    amountUsdCents: 1000,
    txHash: null,
    gasUsed: null,
    rawRunJson: null,
    ...overrides,
  };
}

/** Insert a decision + execution pair (FK: decision must exist first). */
function insertPair(
  db: RipcordDb,
  decisionId: string,
  requestedAtMs: number,
  amountUsdCents: number,
  status: ExecutionRow["status"],
): void {
  db.insertDecision(makeDecision({ decisionId, createdAtMs: requestedAtMs }));
  db.insertExecution(makeExecution({ decisionId, requestedAtMs, amountUsdCents, status }));
}

describe("openDb", () => {
  it("applies the schema idempotently (reopening the same file twice does not throw)", () => {
    const path = join(tmpdir(), `ripcord-db-idem-${process.pid}-${Date.now()}.sqlite`);
    try {
      const db1 = openDb(path);
      db1.insertDecision(makeDecision());
      db1.close();
      const db2 = openDb(path); // second open re-runs CREATE TABLE IF NOT EXISTS
      expect(db2.recentDecisions(10)).toHaveLength(1);
      db2.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("round-trips every decision field including JSON columns", () => {
    const db = openDb(":memory:");
    const row = makeDecision();
    db.insertDecision(row);
    const [got] = db.recentDecisions(1);
    expect(got).toEqual(row);
    db.close();
  });

  it("updateDecision patches only provided keys; undefined untouched, explicit null clears", () => {
    const db = openDb(":memory:");
    db.insertDecision(makeDecision());
    db.updateDecision("01JD000000000000000000TEST", {
      status: "executed",
      criticReason: null, // explicit null clears
      // criticVerdict, guardDecision etc. undefined → untouched
    });
    const [got] = db.recentDecisions(1);
    expect(got?.status).toBe("executed");
    expect(got?.criticReason).toBeNull();
    expect(got?.criticVerdict).toBe("APPROVE"); // untouched
    expect(got?.guardDecision).toBe("execute"); // untouched
    expect(got?.hf).toBe(1.2); // untouched
    db.close();
  });

  it("FAILING CASE: duplicate decision_id insertExecution throws and hasExecution is true", () => {
    const db = openDb(":memory:");
    db.insertDecision(makeDecision());
    db.insertExecution(makeExecution());
    expect(db.hasExecution("01JD000000000000000000TEST")).toBe(true);
    // UNIQUE(decision_id): one defense per decision, enforced by the database.
    expect(() => db.insertExecution(makeExecution())).toThrow(/UNIQUE|constraint/i);
    db.close();
  });

  it("FAILING CASE: CHECK constraint rejects a bogus status", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.insertDecision(makeDecision({ status: "totally-bogus" as DecisionRow["status"] })),
    ).toThrow(/CHECK|constraint/i);
    // and on executions too
    db.insertDecision(makeDecision());
    expect(() =>
      db.insertExecution(makeExecution({ status: "landed" as ExecutionRow["status"] })),
    ).toThrow(/CHECK|constraint/i);
    db.close();
  });

  it("FAILING CASE: execution without its decision row violates the foreign key", () => {
    const db = openDb(":memory:");
    expect(() => db.insertExecution(makeExecution({ decisionId: "01JDNOPARENT" }))).toThrow(
      /FOREIGN KEY|constraint/i,
    );
    db.close();
  });

  it("spentCentsSince counts ALL statuses in the window (fail-closed), excluding older rows", () => {
    const db = openDb(":memory:");
    insertPair(db, "01JDOLD", T0 - 25 * HOUR, 1000, "success"); // outside 24h window
    insertPair(db, "01JDSUCCESS", T0 - 1 * HOUR, 1000, "success");
    insertPair(db, "01JDERROR", T0 - HOUR / 2, 500, "error"); // errored trigger may have landed
    insertPair(db, "01JDTIMEOUT", T0 - HOUR / 6, 250, "timeout"); // timed-out trigger may have landed
    expect(db.spentCentsSince(T0 - 24 * HOUR)).toBe(1750);
    db.close();
  });

  it("spentCentsSince is exact integer cents: three 10c rows sum to exactly 30", () => {
    const db = openDb(":memory:");
    insertPair(db, "01JDCENT1", T0, 10, "success");
    insertPair(db, "01JDCENT2", T0, 10, "success");
    insertPair(db, "01JDCENT3", T0, 10, "success");
    expect(db.spentCentsSince(0)).toBe(30);
    db.close();
  });

  it("lastDefenseAt returns null on empty and the max requested_at_ms otherwise", () => {
    const db = openDb(":memory:");
    expect(db.lastDefenseAt()).toBeNull();
    insertPair(db, "01JDA", T0 - 2 * HOUR, 100, "success");
    insertPair(db, "01JDB", T0 - 1 * HOUR, 100, "error"); // any status counts
    expect(db.lastDefenseAt()).toBe(T0 - 1 * HOUR);
    db.close();
  });

  it("restart resume: file db survives close/reopen with decisions and lastDefenseAt intact", () => {
    const path = join(tmpdir(), `ripcord-db-resume-${process.pid}-${Date.now()}.sqlite`);
    try {
      const db1 = openDb(path);
      insertPair(db1, "01JDRESUME", T0, 1234, "success");
      db1.close();

      const db2 = openDb(path);
      expect(db2.lastDefenseAt()).toBe(T0); // cooldown anchor rehydrates
      expect(db2.recentDecisions(10)).toHaveLength(1);
      expect(db2.recentDecisions(10)[0]?.decisionId).toBe("01JDRESUME");
      expect(db2.spentCentsSince(0)).toBe(1234);
      db2.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("recentExecutions returns newest first, round-trips fields, and updateExecutionByDecision patches", () => {
    const db = openDb(":memory:");
    insertPair(db, "01JDX1", T0 - 2 * HOUR, 100, "triggered");
    insertPair(db, "01JDX2", T0, 200, "triggered");
    insertPair(db, "01JDX3", T0 - 1 * HOUR, 300, "triggered");

    db.updateExecutionByDecision("01JDX2", {
      status: "success",
      completedAtMs: T0 + 5000,
      txHash: "0xabc",
      gasUsed: "21000",
    });

    const execs = db.recentExecutions(10);
    expect(execs.map((e) => e.decisionId)).toEqual(["01JDX2", "01JDX3", "01JDX1"]);
    const newest = execs[0];
    expect(newest?.status).toBe("success");
    expect(newest?.completedAtMs).toBe(T0 + 5000);
    expect(newest?.txHash).toBe("0xabc");
    expect(newest?.gasUsed).toBe("21000");
    expect(newest?.amountUsdCents).toBe(200); // untouched by patch
    expect(newest?.runId).toBe("run-1"); // untouched by patch
    expect(db.recentExecutions(2)).toHaveLength(2); // limit respected
    db.close();
  });
});
