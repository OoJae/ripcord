/**
 * Single-instance daemon lock.
 *
 * Phase 1 accidentally ran FOUR daemons against one database (pkill matched a
 * shell wrapper, not the node process). SQLite serializes their writes, but
 * each instance mints its own decisionIds, so the Guard's idempotency rule is
 * blind across instances and one event can be defended twice. The lock makes
 * the second daemon die at startup instead.
 */

import { describe, expect, it } from "vitest";
import { acquireDaemonLockOrThrow } from "../../src/index.js";
import { openDb } from "../../src/state/db.js";

const T0 = 1_753_920_000_000;
const STALE_MS = 180_000; // 3 × 60s poll interval

describe("db: daemon lock", () => {
  it("acquires on an empty database", () => {
    const db = openDb(":memory:");
    expect(db.acquireDaemonLock(101, T0, STALE_MS)).toEqual({ acquired: true });
    db.close();
  });

  it("REFUSES a second daemon while the first heartbeat is fresh", () => {
    const db = openDb(":memory:");
    db.acquireDaemonLock(101, T0, STALE_MS);

    const res = db.acquireDaemonLock(202, T0 + 60_000, STALE_MS);
    expect(res.acquired).toBe(false);
    expect(res.holderPid).toBe(101);
    expect(res.heartbeatAgeMs).toBe(60_000);
    db.close();
  });

  it("is re-entrant for the same pid", () => {
    const db = openDb(":memory:");
    db.acquireDaemonLock(101, T0, STALE_MS);
    expect(db.acquireDaemonLock(101, T0 + 5_000, STALE_MS).acquired).toBe(true);
    db.close();
  });

  it("takes over a stale lock (crashed holder) and reports whose it was", () => {
    const db = openDb(":memory:");
    db.acquireDaemonLock(101, T0, STALE_MS);

    // Exactly at the boundary the lock is still considered live (strict >).
    expect(db.acquireDaemonLock(202, T0 + STALE_MS, STALE_MS).acquired).toBe(false);

    const res = db.acquireDaemonLock(202, T0 + STALE_MS + 1, STALE_MS);
    expect(res.acquired).toBe(true);
    expect(res.tookOverStalePid).toBe(101);

    // …and the takeover is real: the original pid is now the outsider.
    expect(db.acquireDaemonLock(101, T0 + STALE_MS + 2, STALE_MS).acquired).toBe(false);
    db.close();
  });

  it("heartbeat refresh keeps the lock live past the stale window", () => {
    const db = openDb(":memory:");
    db.acquireDaemonLock(101, T0, STALE_MS);
    expect(db.refreshDaemonLock(101, T0 + STALE_MS)).toBe(true);

    // Without the refresh this attempt would have taken the lock over.
    expect(db.acquireDaemonLock(202, T0 + STALE_MS + 1, STALE_MS).acquired).toBe(false);
    db.close();
  });

  it("refresh by a non-holder is a no-op and reports false", () => {
    const db = openDb(":memory:");
    db.acquireDaemonLock(101, T0, STALE_MS);
    expect(db.refreshDaemonLock(999, T0 + 1)).toBe(false);
    // The real holder's heartbeat is untouched (still refusable at T0+60s).
    expect(db.acquireDaemonLock(202, T0 + 60_000, STALE_MS).heartbeatAgeMs).toBe(60_000);
    db.close();
  });

  it("release frees the lock for the next daemon — but only for the holder", () => {
    const db = openDb(":memory:");
    db.acquireDaemonLock(101, T0, STALE_MS);

    db.releaseDaemonLock(999); // someone else cannot release it
    expect(db.acquireDaemonLock(202, T0 + 1, STALE_MS).acquired).toBe(false);

    db.releaseDaemonLock(101); // the holder can
    expect(db.acquireDaemonLock(202, T0 + 2, STALE_MS)).toEqual({ acquired: true });
    db.close();
  });
});

describe("acquireDaemonLockOrThrow (the startup gate main() calls)", () => {
  it("passes silently when the lock is free", () => {
    const db = openDb(":memory:");
    expect(() => acquireDaemonLockOrThrow(db, 101, T0, STALE_MS)).not.toThrow();
    db.close();
  });

  it("throws a named, actionable error when another daemon holds the lock", () => {
    const db = openDb(":memory:");
    acquireDaemonLockOrThrow(db, 101, T0, STALE_MS);
    expect(() => acquireDaemonLockOrThrow(db, 202, T0 + 60_000, STALE_MS)).toThrow(
      /pid 101.*60s ago/s,
    );
    db.close();
  });
});
