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
import { HttpKeeperHubClient, MockKeeperHubClient } from "../../src/executor/keeperhub.js";
import {
  baseUnitsFor,
  chooseExecutor,
  createDaemon,
  type DaemonDeps,
  type DaemonLogger,
} from "../../src/index.js";
import { openDb } from "../../src/state/db.js";
import type {
  Critic,
  DecisionNotification,
  Notifier,
  Planner,
  PlanResult,
  Sensor,
  Snapshot,
} from "../../src/types.js";
import { fixedClock, makeSnapshot, makeTestConfig, TEST_ADDRESS } from "../helpers/fakes.js";

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
  return {
    async read() {
      return snapshot;
    },
  };
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

function harness(
  opts: {
    chain?: "base" | "base-sepolia";
    dryRun?: boolean;
    armed?: boolean;
    hf?: string;
    critic?: Critic;
  } = {},
): Harness {
  const chain = opts.chain ?? "base-sepolia";
  // NOTE: loadConfig itself refuses mainnet + DRY_RUN=false + ARM=0 (belt).
  // These tests bypass that via overrides on purpose, to prove the daemon and
  // Guard (suspenders) hold even if the config layer were ever weakened.
  const config = makeTestConfig(
    { MONITORED_ADDRESS: TEST_ADDRESS },
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

describe("SAFETY PROOF: a throwing Critic is not an approving Critic", () => {
  it("converts an exception from critique() into a REJECT rather than crashing past the gate", async () => {
    const h = harness({ dryRun: false, hf: "1.20" });
    h.deps.critic = {
      async critique() {
        throw new Error("anthropic API unreachable");
      },
    };
    await createDaemon(h.deps).runTick("01J9CRITICTHROWS00000000A");

    expect(h.executor.receivedPayloads).toHaveLength(0);
    const decision = h.db.recentDecisions(1)[0];
    expect(decision?.criticVerdict).toBe("REJECT");
    expect(decision?.status).toBe("rejected");
    expect(decision?.guardViolationsJson).toContain("critic-approval");
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

    expect(h.executor.receivedPayloads[0]?.assetAddress).toBe(
      ADDRESS_BOOK["base-sepolia"].usdc.address,
    );
    h.db.close();
  });

  it("does NOT record a defense when WF-2 declines and sends no transaction", async () => {
    // REGRESSION. A KeeperHub run ending "success" is not proof money moved.
    // WF-2 re-reads the position and, if it no longer needs defending, takes the
    // false branch of its gate and finishes successfully having sent nothing —
    // state "success", transactionHashes []. Verified against live execution
    // x8rb3lbaxyy2b6wvses82. Recording that as a defense announces a rescue that
    // never happened and burns a 30-minute cooldown on the real position.
    const h = harness({ dryRun: false, hf: "1.20" });
    const declining = new MockKeeperHubClient({ declineNoTx: true });
    h.deps.keeperhub = declining;

    const daemon = createDaemon(h.deps);
    await daemon.runTick("01J9DECLINED000000000000A");

    // It really did reach the executor — this is not a Guard block.
    expect(declining.receivedPayloads).toHaveLength(1);
    expect(h.db.recentDecisions(1)[0]?.status).toBe("blocked");

    const last = h.notifications.at(-1);
    expect(last?.kind).toBe("blocked");
    expect(last?.detail).toMatch(/declined/i);

    // And the latch must stay armed, so the next eligible tick can try again.
    expect(daemon.state.armed).toBe(true);
    h.db.close();
  });

  it("keeps the latch armed when a defense fails, so the act band stays defensible", async () => {
    // REGRESSION, and this one bit a real run. markDefenseFired used to disarm at
    // trigger time. When the transaction then reverted, HF was unchanged and
    // still in the act band — and the only branch that re-arms requires
    // hf > 1.55, which an undefended act-band position can never reach. The
    // position became permanently undefendable until it decayed into panic.
    const h = harness({ dryRun: false, hf: "1.20" });
    h.deps.keeperhub = new MockKeeperHubClient({ script: ["pending", "error"] });

    const daemon = createDaemon(h.deps);
    await daemon.runTick("01J9FAILEDDEFENSE0000000A");

    expect(h.db.recentDecisions(1)[0]?.status).toBe("failed");
    expect(daemon.state.armed).toBe(true);
    // The cooldown is still anchored, so the retry is rate-limited not blocked.
    expect(daemon.state.lastFiredAtMs).not.toBeNull();
    h.db.close();
  });

  it("opens the latch only for a defense that actually landed", async () => {
    const h = harness({ dryRun: false, hf: "1.20" });
    const daemon = createDaemon(h.deps); // default mock: success WITH a tx hash
    await daemon.runTick("01J9LANDEDDEFENSE0000000A");

    expect(h.db.recentDecisions(1)[0]?.status).toBe("executed");
    expect(daemon.state.armed).toBe(false);
    h.db.close();
  });

  it("blocks an unpriceable asset instead of sending a zero-amount payload", async () => {
    // Ripcord has no oracle feed, so it cannot convert USD → collateral base
    // units. Returning 0 would have POSTed a defense that supplies nothing;
    // the tick must record a block and leave the executor untouched.
    const h = harness({ dryRun: false, hf: "1.20" });
    h.deps.planner = {
      async plan(): Promise<PlanResult> {
        return {
          proposal: {
            action: "supplyCollateral",
            asset: "cbETH",
            amountUsd: 10,
            expectedHfAfter: 1.6,
            rationale: "top up collateral",
          },
          raw: null,
        };
      },
    };
    await createDaemon(h.deps).runTick("01J9UNPRICEABLE0000000000");

    expect(h.executor.receivedPayloads).toHaveLength(0);
    expect(h.db.recentDecisions(1)[0]?.status).toBe("blocked");
    expect(h.notifications.at(-1)?.kind).toBe("blocked");
    h.db.close();
  });
});

describe("baseUnitsFor", () => {
  it("converts USDC exactly at 6 decimals", () => {
    expect(baseUnitsFor("USDC", 4.02)).toBe(4_020_000n);
    expect(baseUnitsFor("USDC", 0.01)).toBe(10_000n);
  });

  it("refuses assets it cannot price rather than returning zero", () => {
    expect(() => baseUnitsFor("cbETH", 10)).toThrow(/cannot price cbETH/);
    expect(() => baseUnitsFor("WETH", 10)).toThrow(/oracle/);
  });
});

describe("chooseExecutor", () => {
  const WEBHOOK = "https://app.keeperhub.com/api/workflows/wf2/webhook";

  it("returns the live HTTP client only when the capability AND the URL are present", () => {
    const cfg = makeTestConfig({
      MONITORED_ADDRESS: TEST_ADDRESS,
      KEEPERHUB_DEFEND_WEBHOOK_URL: WEBHOOK,
    });
    expect(cfg.capabilities.keeperhub).toBe(true);
    expect(chooseExecutor(cfg)).toBeInstanceOf(HttpKeeperHubClient);
  });

  it("falls back to the mock with no webhook URL configured", () => {
    expect(chooseExecutor(makeTestConfig({ MONITORED_ADDRESS: TEST_ADDRESS }))).toBeInstanceOf(
      MockKeeperHubClient,
    );
  });

  it("falls back to the mock if the capability flag is somehow off", () => {
    // Defence in depth: both conditions must hold, so a future refactor that
    // sets one without the other degrades to simulation rather than to writes.
    const cfg = makeTestConfig(
      { MONITORED_ADDRESS: TEST_ADDRESS, KEEPERHUB_DEFEND_WEBHOOK_URL: WEBHOOK },
      { capabilities: { chainReads: true, llm: false, keeperhub: false, telegram: false } },
    );
    expect(chooseExecutor(cfg)).toBeInstanceOf(MockKeeperHubClient);
  });
});
