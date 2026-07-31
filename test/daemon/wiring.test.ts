/**
 * WIRING-LEVEL SAFETY PROOFS.
 *
 * Unit-testing the Guard proves the Guard says "no". These tests prove the
 * assembled daemon *obeys* it: each one drives a real tick with a maximally
 * permissive Planner and Critic — LLM agents actively trying to spend money —
 * and asserts the executor spy was never called.
 *
 * If someone later refactors the daemon and drops the guard call, every unit
 * test still passes and these fail. That is the point.
 */

import { describe, expect, it } from "vitest";
import { ADDRESS_BOOK } from "../../src/config.js";
import { MockKeeperHubClient } from "../../src/executor/keeperhub.js";
import { createDaemon, type DaemonDeps, type DaemonLogger } from "../../src/index.js";
import { openDb } from "../../src/state/db.js";
import type {
  Critic,
  DecisionNotification,
  Notifier,
  PlanResult,
  Planner,
  Sensor,
  Snapshot,
} from "../../src/types.js";
import { fixedClock, makeSnapshot, makeTestConfig } from "../helpers/fakes.js";

/** A Planner that always proposes a valid, affordable, target-clearing defense. */
const permissivePlanner: Planner = {
  async plan(): Promise<PlanResult> {
    return {
      proposal: {
        action: "repay",
        asset: "USDC",
        amountUsd: 5,
        expectedHfAfter: 1.6,
        rationale: "maximally permissive planner — always wants to spend",
      },
      raw: null,
    };
  },
};

/** A Critic that always approves. */
const permissiveCritic: Critic = {
  async critique() {
    return { verdict: { verdict: "APPROVE" as const, reason: "always approves" }, raw: null };
  },
};

const rejectingCritic: Critic = {
  async critique() {
    return {
      verdict: { verdict: "REJECT" as const, reason: "expected HF does not clear the target" },
      raw: null,
    };
  },
};

function stubSensor(snapshot: Snapshot): Sensor {
  return { async read() { return snapshot; } };
}

function silentLogger(): DaemonLogger {
  const self: DaemonLogger = {
    child: () => self,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return self;
}

interface Harness {
  deps: DaemonDeps;
  executor: MockKeeperHubClient;
  notifications: DecisionNotification[];
  db: ReturnType<typeof openDb>;
}

function harness(opts: {
  chain?: "base" | "base-sepolia";
  dryRun?: boolean;
  armed?: boolean;
  hf?: string;
  critic?: Critic;
} = {}): Harness {
  const chain = opts.chain ?? "base-sepolia";
  // NOTE: loadConfig itself refuses mainnet + DRY_RUN=false + ARM=0 (belt).
  // These tests bypass that via overrides on purpose, to prove the daemon and
  // Guard (suspenders) hold even if the config layer were ever weakened.
  const config = makeTestConfig(
    {},
    {
      chain,
      dryRun: opts.dryRun ?? false,
      armed: opts.armed ?? false,
      addressBook: ADDRESS_BOOK[chain],
    },
  );
  const executor = new MockKeeperHubClient();
  const notifications: DecisionNotification[] = [];
  const db = openDb(":memory:");

  return {
    executor,
    notifications,
    db,
    deps: {
      config,
      db,
      sensor: stubSensor(makeSnapshot(opts.hf ?? "1.20", {}, chain)),
      planner: permissivePlanner,
      critic: opts.critic ?? permissiveCritic,
      keeperhub: executor,
      notifier: {
        async notify(n) {
          notifications.push(n);
        },
      } satisfies Notifier,
      logger: silentLogger(),
      clock: fixedClock(),
      sleep: async () => {},
    },
  };
}

describe("SAFETY PROOF: RIPCORD_ARM=0 on mainnet", () => {
  it("nothing reaches the executor in mainnet mode when unarmed", async () => {
    const h = harness({ chain: "base", dryRun: false, armed: false, hf: "1.20" });
    await createDaemon(h.deps).runTick("01J9ARMTEST0000000000000AA");

    // The load-bearing assertion of the entire project.
    expect(h.executor.receivedPayloads).toHaveLength(0);

    const decision = h.db.recentDecisions(1)[0];
    expect(decision?.status).toBe("blocked");
    expect(decision?.guardDecision).toBe("blocked");
    expect(decision?.guardViolationsJson).toContain("arm-flag");
    expect(h.notifications.some((n) => n.kind === "blocked")).toBe(true);
    h.db.close();
  });

  it("panic does not become an escape hatch around the arm flag", async () => {
    // Panic bypasses hysteresis and cooldown by design — it must NOT bypass ARM.
    const h = harness({ chain: "base", dryRun: false, armed: false, hf: "1.05" });
    await createDaemon(h.deps).runTick("01J9ARMTEST0000000000000BB");

    expect(h.executor.receivedPayloads).toHaveLength(0);
    expect(h.db.recentDecisions(1)[0]?.band).toBe("panic");
    expect(h.db.recentDecisions(1)[0]?.guardViolationsJson).toContain("arm-flag");
    h.db.close();
  });

  it("an armed mainnet run does execute — proving the block above is the flag, not a dead path", async () => {
    const h = harness({ chain: "base", dryRun: false, armed: true, hf: "1.20" });
    await createDaemon(h.deps).runTick("01J9ARMTEST0000000000000CC");

    expect(h.executor.receivedPayloads).toHaveLength(1);
    expect(h.db.recentDecisions(1)[0]?.status).toBe("executed");
    h.db.close();
  });
});

describe("SAFETY PROOF: DRY_RUN", () => {
  it("holds fire while recording the payload it would have sent", async () => {
    const h = harness({ chain: "base-sepolia", dryRun: true, hf: "1.20" });
    await createDaemon(h.deps).runTick("01J9DRYRUN00000000000000AA");

    expect(h.executor.receivedPayloads).toHaveLength(0);
    const decision = h.db.recentDecisions(1)[0];
    expect(decision?.status).toBe("dry_run");
    expect(decision?.guardDecision).toBe("dry-run");
    expect(decision?.guardViolationsJson).toBe("[]"); // held by DRY_RUN, not by a failure

    const defense = h.notifications.find((n) => n.kind === "defense");
    expect(defense?.dryRun).toBe(true);
    h.db.close();
  });
});

describe("SAFETY PROOF: Critic approval is mandatory", () => {
  it("a REJECT stops execution even though the Planner and caps are happy", async () => {
    const h = harness({ dryRun: false, critic: rejectingCritic, hf: "1.20" });
    await createDaemon(h.deps).runTick("01J9CRITIC000000000000000A");

    expect(h.executor.receivedPayloads).toHaveLength(0);
    const decision = h.db.recentDecisions(1)[0];
    expect(decision?.status).toBe("rejected");
    expect(decision?.criticVerdict).toBe("REJECT");
    expect(decision?.guardViolationsJson).toContain("critic-approval");
    expect(h.notifications.some((n) => n.kind === "blocked")).toBe(true);
    h.db.close();
  });
});

describe("SAFETY PROOF: idempotency", () => {
  it("hysteresis alone stops an immediate re-fire of the same decision", async () => {
    const h = harness({ dryRun: false, hf: "1.20" });
    const daemon = createDaemon(h.deps);
    const id = "01J9IDEMPOTENT0000000000A";

    await daemon.runTick(id);
    expect(h.executor.receivedPayloads).toHaveLength(1);

    await daemon.runTick(id); // same tick replayed against a live daemon
    expect(h.executor.receivedPayloads).toHaveLength(1);
    h.db.close();
  });

  it("in PANIC after a restart — where hysteresis and cooldown are bypassed — idempotency is what stops the double-spend", async () => {
    // The crash-and-restart scenario, in the one band that deliberately ignores
    // both anti-flap layers. If the Guard's idempotency rule were missing, this
    // position would be defended (and paid for) twice.
    const h = harness({ dryRun: false, hf: "1.05" });
    const id = "01J9IDEMPOTENT0000000000B";

    await createDaemon(h.deps).runTick(id);
    expect(h.executor.receivedPayloads).toHaveLength(1);

    // Fresh daemon over the same db = process restart: armed resets to true and
    // panic skips the cooldown, so policy says "defend" all over again.
    const restarted = createDaemon(h.deps);
    await restarted.runTick(id);

    expect(h.executor.receivedPayloads).toHaveLength(1);
    const decision = h.db.recentDecisions(1)[0];
    expect(decision?.band).toBe("panic");
    expect(decision?.guardDecision).toBe("blocked");
    expect(decision?.guardViolationsJson).toContain("idempotency");
    expect(h.notifications.some((n) => n.kind === "blocked")).toBe(true);
    h.db.close();
  });
});

describe("daemon: policy suppression paths", () => {
  it("a healthy position never invokes the executor", async () => {
    const h = harness({ dryRun: false, hf: "2.00" });
    await createDaemon(h.deps).runTick("01J9HEALTHY00000000000000");

    expect(h.executor.receivedPayloads).toHaveLength(0);
    expect(h.db.recentDecisions(1)[0]?.status).toBe("observed");
    h.db.close();
  });

  it("a failing planner aborts the tick fail-safe (no action, decision recorded)", async () => {
    const h = harness({ dryRun: false, hf: "1.20" });
    h.deps.planner = {
      async plan(): Promise<PlanResult> {
        throw new Error("schema validation exhausted");
      },
    };
    await createDaemon(h.deps).runTick("01J9PLANNERFAIL0000000000");

    expect(h.executor.receivedPayloads).toHaveLength(0);
    expect(h.db.recentDecisions(1)[0]?.status).toBe("planner_invalid");
    h.db.close();
  });

  it("threads one decisionId through the decision row, payload, and notification", async () => {
    const h = harness({ dryRun: false, hf: "1.20" });
    const id = "01J9THREADED00000000000AA";
    await createDaemon(h.deps).runTick(id);

    expect(h.db.recentDecisions(1)[0]?.decisionId).toBe(id);
    expect(h.executor.receivedPayloads[0]?.decisionId).toBe(id);
    expect(h.notifications.every((n) => n.decisionId === id)).toBe(true);
    h.db.close();
  });

  it("resolves the asset address from the config allowlist, never from the planner", async () => {
    const h = harness({ dryRun: false, hf: "1.20" });
    await createDaemon(h.deps).runTick("01J9ADDRESSBOOK000000000A");

    expect(h.executor.receivedPayloads[0]?.assetAddress).toBe(ADDRESS_BOOK["base-sepolia"].usdc.address);
    h.db.close();
  });
});
