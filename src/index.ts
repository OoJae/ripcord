/**
 * Ripcord daemon: Sense → Policy → Plan → Critique → Guard → Execute → Notify → Record.
 *
 * createDaemon(deps) is fully dependency-injected so the wiring-level safety
 * proofs in test/daemon/wiring.test.ts can drive a real tick with fakes and
 * assert that nothing reaches the executor when it must not.
 */

import { pathToFileURL } from "node:url";
import { ulid } from "ulid";
import { createHeuristicCritic, createLlmCritic } from "./agents/critic.js";
import { hfAfter } from "./agents/hf-math.js";
import { createAnthropicLlm } from "./agents/llm.js";
import { createHeuristicPlanner, createLlmPlanner } from "./agents/planner.js";
import {
  type AppConfig,
  getConfig,
  MOCK_POLL_SEC,
  redactRpcUrl,
  scrubRpcUrl,
  TOKEN_DECIMALS,
  usdToCents,
} from "./config.js";
import {
  HttpKeeperHubClient,
  MockKeeperHubClient,
  RunTimeoutError,
  waitForRun,
} from "./executor/keeperhub.js";
import { checkGuard } from "./guard/guard.js";
import { createNotifier } from "./notifier/telegram.js";
import { evaluate, markDefenseFired } from "./policy/thresholds.js";
import {
  computeVelocity,
  createAaveSensor,
  createMockSensor,
  SampleWindow,
} from "./sensor/aave.js";
import { openDb } from "./state/db.js";
import type {
  Clock,
  Critic,
  DefensePayload,
  KeeperHubClient,
  Notifier,
  Planner,
  PlannerProposal,
  PolicyState,
  RipcordDb,
  Sensor,
  Snapshot,
} from "./types.js";

// ---------------------------------------------------------------------------

export interface DaemonLogger {
  child(bindings: Record<string, unknown>): DaemonLogger;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface DaemonDeps {
  config: AppConfig;
  db: RipcordDb;
  sensor: Sensor;
  planner: Planner;
  critic: Critic;
  keeperhub: KeeperHubClient;
  notifier: Notifier;
  logger: DaemonLogger;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Called after a successful (non-dry-run) defense — mock mode uses it to rescue the position. */
  onDefenseSuccess?: (payload: DefensePayload) => void;
}

export interface Daemon {
  /** One full decision cycle. decisionIdOverride exists for idempotency tests only. */
  runTick(decisionIdOverride?: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  readonly state: PolicyState;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Convert a USD amount into token base units for the defense payload. */
export function baseUnitsFor(asset: "USDC" | "WETH", amountUsd: number): bigint {
  if (asset === "USDC") {
    // USDC ≈ $1 — exact 6-decimal conversion.
    return BigInt(Math.round(amountUsd * 10 ** TOKEN_DECIMALS.USDC));
  }
  // No WETH price feed in Session 1: WF-2 derives units from amountUsd + its own
  // oracle read (check-and-execute). VERIFY in Session 2 when WF-2 exists.
  return 0n;
}

export function buildDefensePayload(
  cfg: AppConfig,
  proposal: PlannerProposal,
  snapshot: Snapshot,
  decisionId: string,
): DefensePayload {
  if (proposal.action === "none") {
    throw new Error("buildDefensePayload: action 'none' never reaches the executor");
  }
  // Addresses resolved HERE, from the config allowlist — never from LLM output.
  const assetAddress =
    proposal.asset === "USDC" ? cfg.addressBook.usdc.address : cfg.addressBook.weth.address;
  return {
    decisionId,
    chain: cfg.chain,
    action: proposal.action,
    assetSymbol: proposal.asset,
    assetAddress,
    amountBaseUnits: baseUnitsFor(proposal.asset, proposal.amountUsd).toString(),
    amountUsd: proposal.amountUsd,
    minHfAfter: cfg.thresholds.targetHf,
    // Config is the authority for WHO we defend, exactly as it is for WHICH
    // contracts we touch. The snapshot only gets a say when no monitored address
    // is configured at all — and in that case the Guard's snapshot-provenance
    // rule has already blocked execution before we ever build a payload.
    monitoredAddress: cfg.monitoredAddress ?? snapshot.address,
  };
}

// ---------------------------------------------------------------------------

export function createDaemon(deps: DaemonDeps): Daemon {
  const { config: cfg, db, sensor, planner, critic, keeperhub, notifier, logger, clock } = deps;
  const sleep = deps.sleep ?? realSleep;

  const state: PolicyState = {
    armed: true,
    lastFiredAtMs: db.lastDefenseAt(),
    lastBand: "healthy",
  };
  const window = new SampleWindow(3);
  let stopping = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function readWithRetry(log: DaemonLogger): Promise<Snapshot | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await sensor.read();
      } catch (err) {
        log.warn({ err: scrubRpcUrl(String(err), cfg.rpcUrl), attempt }, "sensor read failed");
        if (attempt < 3) await sleep(500 * attempt);
      }
    }
    return null;
  }

  async function safeNotify(n: Parameters<Notifier["notify"]>[0], log: DaemonLogger) {
    try {
      await notifier.notify(n);
    } catch (err) {
      log.warn({ err: String(err) }, "notifier failed");
    }
  }

  async function runTick(decisionIdOverride?: string): Promise<void> {
    const decisionId = decisionIdOverride ?? ulid();
    const log = logger.child({ decisionId });
    const now = clock.now();

    const rawSnapshot = await readWithRetry(log);
    if (!rawSnapshot) {
      log.error({}, "sensor unavailable after retries — skipping tick");
      return;
    }
    window.push({ tMs: rawSnapshot.timestampMs, hf: rawSnapshot.hf });
    const snapshot: Snapshot = {
      ...rawSnapshot,
      hfVelocityPerMin: computeVelocity(window.samples),
    };

    const prevBand = state.lastBand;
    const res = evaluate(snapshot, cfg.thresholdsWad, state, now);
    Object.assign(state, res.nextState);

    try {
      db.insertDecision({
        decisionId,
        createdAtMs: now,
        chain: cfg.chain,
        band: res.band,
        hf: snapshot.hf,
        snapshotJson: JSON.stringify(snapshot, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
        status: "observed",
      });
    } catch (err) {
      // A decisionId we have already recorded — a replay. Don't crash the tick:
      // continue so the Guard's idempotency rule blocks it explicitly and the
      // operator gets a notification, rather than an unhandled throw.
      log.warn({ err: String(err) }, "decision already recorded — treating this tick as a replay");
    }

    log.info(
      {
        band: res.band,
        // JSON renders Infinity as null, so carry hasDebt alongside: a no-debt
        // position logs as `hf: null, hasDebt: false`, which reads correctly.
        hf: snapshot.hf,
        hasDebt: snapshot.hasDebt,
        shouldDefend: res.shouldDefend,
        reason: res.reason,
      },
      "tick",
    );

    if (res.band !== prevBand) {
      await safeNotify(
        {
          kind: "band-change",
          chain: cfg.chain,
          band: res.band,
          decisionId,
          dryRun: cfg.dryRun,
          hf: snapshot.hf,
          detail: `band ${prevBand} → ${res.band}`,
        },
        log,
      );
    }

    if (!res.shouldDefend) return;

    // --- Plan
    let proposal: PlannerProposal;
    let plannerRaw: string | null = null;
    try {
      const planned = await planner.plan({
        snapshot,
        thresholds: cfg.thresholds,
        caps: cfg.caps,
        recentDecisions: db.recentDecisions(5).map((d) => ({
          createdAtMs: d.createdAtMs,
          band: d.band,
          status: d.status,
        })),
      });
      proposal = planned.proposal;
      plannerRaw = planned.raw;
    } catch (err) {
      log.error({ err: String(err) }, "planner output invalid — fail-safe no-action");
      db.updateDecision(decisionId, { status: "planner_invalid" });
      await safeNotify(
        {
          kind: "error",
          chain: cfg.chain,
          band: res.band,
          decisionId,
          dryRun: cfg.dryRun,
          detail: "planner output failed validation — no action taken",
        },
        log,
      );
      return;
    }

    // --- Critique. Fail-closed twice over: the LLM critic already resolves an
    // exhausted retry budget to REJECT, and a Critic that *throws* (a custom
    // implementation, a network error escaping) is converted to REJECT here.
    // There is no path on which the absence of an approval becomes an approval.
    let critiqued: Awaited<ReturnType<Critic["critique"]>>;
    try {
      critiqued = await critic.critique(snapshot, proposal, cfg.thresholds, cfg.caps);
    } catch (err) {
      log.error({ err: String(err) }, "critic threw — treating as REJECT (fail-closed)");
      critiqued = {
        verdict: { verdict: "REJECT", reason: `critic errored: ${String(err)}` },
        raw: null,
      };
    }
    const verdict = critiqued.verdict;

    // --- Guard (deterministic final authority; all facts injected)
    const guard = checkGuard({
      proposal,
      verdict,
      snapshot,
      chain: cfg.chain,
      flags: { dryRun: cfg.dryRun, armed: cfg.armed },
      capsCents: cfg.capsCents,
      minHfImprovement: cfg.caps.minHfImprovement,
      addressBook: cfg.addressBook,
      spentTodayCents: db.spentCentsSince(now - 86_400_000),
      alreadyExecuted: db.hasExecution(decisionId),
      monitoredAddress: cfg.monitoredAddress,
      liveExecutor: cfg.capabilities.keeperhub,
    });

    db.updateDecision(decisionId, {
      proposalJson: JSON.stringify(proposal),
      plannerRaw,
      criticVerdict: verdict.verdict,
      criticReason: verdict.reason,
      guardDecision: guard.decision,
      guardViolationsJson: JSON.stringify(guard.violations),
      guardChecksJson: JSON.stringify(guard.checks),
      status:
        guard.decision === "blocked"
          ? verdict.verdict === "REJECT"
            ? "rejected"
            : "blocked"
          : guard.decision === "dry-run"
            ? "dry_run"
            : "executing",
    });

    log.info(
      { guard: guard.decision, violations: guard.violations, checks: guard.checks.length },
      "guard evaluated",
    );

    // Report OUR arithmetic to the human, never the model's self-report. Live
    // testing showed both agents drift on this; the operator should see the
    // number the Guard actually gated on.
    const verifiedHfAfter = hfAfter(snapshot, proposal);

    if (guard.decision === "blocked") {
      await safeNotify(
        {
          kind: "blocked",
          chain: cfg.chain,
          band: res.band,
          decisionId,
          dryRun: cfg.dryRun,
          hf: snapshot.hf,
          detail: guard.reason,
        },
        log,
      );
      return;
    }

    const payload = buildDefensePayload(cfg, proposal, snapshot, decisionId);

    if (guard.decision === "dry-run") {
      log.info(
        { payload, checks: guard.checks },
        "DRY_RUN: all safety checks passed — would trigger KeeperHub defense",
      );
      Object.assign(state, markDefenseFired(state, now));
      await safeNotify(
        {
          kind: "defense",
          chain: cfg.chain,
          band: res.band,
          decisionId,
          dryRun: true,
          hf: snapshot.hf,
          action: proposal.action,
          asset: proposal.asset,
          amountUsd: proposal.amountUsd,
          expectedHfAfter: verifiedHfAfter,
          rationale: proposal.rationale,
        },
        log,
      );
      return;
    }

    // --- Execute (guard already proved arm-flag for mainnet)
    db.insertExecution({
      decisionId,
      requestedAtMs: now,
      status: "triggered",
      action: payload.action,
      assetSymbol: payload.assetSymbol,
      amountUsdCents: usdToCents(payload.amountUsd),
    });
    Object.assign(state, markDefenseFired(state, now));

    let runId: string;
    try {
      const trig = await keeperhub.triggerDefense(payload);
      runId = trig.runId;
      db.updateExecutionByDecision(decisionId, { runId, status: "running" });
    } catch (err) {
      log.error({ err: String(err) }, "KeeperHub trigger failed");
      db.updateExecutionByDecision(decisionId, { status: "error", completedAtMs: clock.now() });
      db.updateDecision(decisionId, { status: "failed" });
      await safeNotify(
        {
          kind: "error",
          chain: cfg.chain,
          band: res.band,
          decisionId,
          dryRun: false,
          detail: `KeeperHub trigger failed: ${String(err)}`,
        },
        log,
      );
      return;
    }

    try {
      const run = await waitForRun(keeperhub, runId, { sleep, clock: () => clock.now() });
      db.updateExecutionByDecision(decisionId, {
        status: run.state === "success" ? "success" : "error",
        txHash: run.txHash ?? null,
        completedAtMs: clock.now(),
        rawRunJson: JSON.stringify(run.raw ?? null),
      });
      db.updateDecision(decisionId, { status: run.state === "success" ? "executed" : "failed" });
      if (run.state === "success") deps.onDefenseSuccess?.(payload);
      await safeNotify(
        {
          kind: run.state === "success" ? "defense" : "error",
          chain: cfg.chain,
          band: res.band,
          decisionId,
          runId,
          dryRun: false,
          hf: snapshot.hf,
          action: proposal.action,
          asset: proposal.asset,
          amountUsd: proposal.amountUsd,
          expectedHfAfter: verifiedHfAfter,
          rationale: proposal.rationale,
          txHash: run.txHash,
          detail: run.state === "success" ? undefined : (run.error ?? `run ${run.state}`),
        },
        log,
      );
    } catch (err) {
      const timedOut = err instanceof RunTimeoutError;
      log.error({ err: String(err), runId }, timedOut ? "run polling timed out" : "run poll error");
      // Fail-closed: a timed-out run may still have landed — status counts toward daily spend.
      db.updateExecutionByDecision(decisionId, {
        status: timedOut ? "timeout" : "error",
        completedAtMs: clock.now(),
      });
      db.updateDecision(decisionId, { status: "failed" });
      await safeNotify(
        {
          kind: "error",
          chain: cfg.chain,
          band: res.band,
          decisionId,
          runId,
          dryRun: false,
          detail: timedOut ? "KeeperHub run polling timed out" : `run poll error: ${String(err)}`,
        },
        log,
      );
    }
  }

  function start(): void {
    const pollMs = (cfg.capabilities.chainReads ? cfg.pollSec : MOCK_POLL_SEC) * 1000;
    const scheduleNext = () => {
      if (stopping) return;
      timer = setTimeout(() => {
        // Self-scheduling chain — never setInterval, so ticks can't overlap.
        inFlight = runTick()
          .catch((err) => logger.error({ err: String(err) }, "tick crashed"))
          .finally(() => {
            inFlight = null;
            scheduleNext();
          });
      }, pollMs);
    };
    inFlight = runTick()
      .catch((err) => logger.error({ err: String(err) }, "tick crashed"))
      .finally(() => {
        inFlight = null;
        scheduleNext();
      });
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (timer) clearTimeout(timer);
    if (inFlight) await inFlight;
  }

  return { runTick, start, stop, state };
}

// ---------------------------------------------------------------------------
// main()

async function main(): Promise<void> {
  const cfg = await getConfig();
  const { default: pino } = await import("pino");
  const logger = pino(
    process.stdout.isTTY
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {},
  ) as unknown as DaemonLogger & { flush?: () => void };

  const db = openDb(cfg.dbPath);

  const mockSensor = cfg.capabilities.chainReads ? null : createMockSensor(undefined, cfg.chain);
  const sensor: Sensor = cfg.capabilities.chainReads
    ? createAaveSensor(cfg)
    : (mockSensor as Sensor);

  let planner: Planner;
  let critic: Critic;
  if (cfg.capabilities.llm && cfg.anthropicApiKey) {
    const llm = createAnthropicLlm(cfg.anthropicApiKey, cfg.model, cfg.anthropicBaseUrl);
    planner = createLlmPlanner(llm);
    critic = createLlmCritic(llm);
  } else {
    planner = createHeuristicPlanner();
    critic = createHeuristicCritic();
  }

  const keeperhub: KeeperHubClient =
    cfg.capabilities.keeperhub && cfg.keeperhubWebhookUrl
      ? new HttpKeeperHubClient({
          webhookUrl: cfg.keeperhubWebhookUrl,
          apiKey: cfg.keeperhubApiKey,
          apiBaseUrl: cfg.keeperhubApiBaseUrl,
        })
      : new MockKeeperHubClient();

  const notifier = createNotifier(cfg, logger);

  const banner = [
    `chain: ${cfg.chain}`,
    `chain reads: ${cfg.capabilities.chainReads ? `LIVE (${redactRpcUrl(cfg.rpcUrl)})` : "MOCK (no MONITORED_ADDRESS)"}`,
    `brain: ${cfg.capabilities.llm ? `LLM ${cfg.model}${cfg.anthropicBaseUrl ? ` @ ${redactRpcUrl(cfg.anthropicBaseUrl)}` : ""}` : "HEURISTIC (no ANTHROPIC_API_KEY)"}`,
    `executor: ${cfg.capabilities.keeperhub ? "KeeperHub webhook" : "MOCK (no KEEPERHUB_DEFEND_WEBHOOK_URL)"}`,
    `alerts: ${cfg.capabilities.telegram ? "Telegram" : "log-only"}`,
    `DRY_RUN: ${cfg.dryRun ? "ON" : "off"} · RIPCORD_ARM: ${cfg.armed ? "1" : "0"}`,
    `caps: $${cfg.caps.maxTxUsd}/tx · $${cfg.caps.dailyCapUsd}/24h`,
  ];
  logger.info({}, `🪂 RIPCORD starting — ${banner.join(" · ")}`);

  const daemon = createDaemon({
    config: cfg,
    db,
    sensor,
    planner,
    critic,
    keeperhub,
    notifier,
    logger,
    clock: { now: () => Date.now() },
    onDefenseSuccess: mockSensor ? (p) => mockSensor.applyDefense(p.amountUsd) : undefined,
  });

  let signals = 0;
  const shutdown = async (sig: string) => {
    signals += 1;
    if (signals > 1) process.exit(1);
    logger.info({}, `${sig} received — finishing in-flight tick, then exiting`);
    await daemon.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  daemon.start();
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
