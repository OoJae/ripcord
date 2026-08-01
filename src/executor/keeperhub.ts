/**
 * KeeperHub execution seam: HTTP client, poll-until-terminal helper, and the
 * offline mock used whenever the `keeperhub` capability is absent.
 *
 * SAFETY POSTURE — fail closed everywhere:
 * - Any non-2xx, unparseable, or id-less trigger response throws (never a silent
 *   "probably fired"); the caller records the failure instead of assuming success.
 * - Unknown run states are treated as NON-terminal, so we keep polling until the
 *   deadline rather than declaring success/failure we cannot verify.
 * - waitForRun has a hard deadline and throws RunTimeoutError — no infinite polls.
 */

import { ulid } from "ulid";
import type {
  DefensePayload,
  KeeperHubClient,
  RunState,
  RunStatus,
  RunTxHash,
  TriggerResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Typed errors

/** Any KeeperHub HTTP failure — non-2xx, or a 2xx response we cannot trust. */
export class KeeperHubHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;

  constructor(message: string, opts: { status: number; body: unknown; url: string }) {
    super(message);
    this.name = "KeeperHubHttpError";
    this.status = opts.status;
    this.body = opts.body;
    this.url = opts.url;
  }
}

/** waitForRun exceeded its deadline without observing a terminal state. */
export class RunTimeoutError extends Error {
  readonly runId: string;
  readonly timeoutMs: number;

  constructor(runId: string, timeoutMs: number) {
    super(`KeeperHub run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
    this.name = "RunTimeoutError";
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

/** Verified terminal states (docs.keeperhub.com/api/executions, 2026-07-30). */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "success",
  "error",
  "cancelled",
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

const KNOWN_RUN_STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "success",
  "error",
  "cancelled",
]);

/** Minimal structural logger — pino satisfies this; tests inject a recorder. */
export interface KeeperHubLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Unwrap the documented REST envelope ({ data: {...} }) when present;
 * otherwise treat the body itself as the resource.
 */
function unwrapData(body: unknown): Record<string, unknown> {
  const rec = asRecord(body);
  if (!rec) return {};
  const data = asRecord(rec.data);
  return data ?? rec;
}

/**
 * Permissive run-id extraction: executionId | runId | id at the top level OR
 * under the { data: {...} } envelope (the documented REST envelope).
 */
function extractRunId(body: unknown): string | undefined {
  const fromRecord = (rec: Record<string, unknown> | undefined): string | undefined => {
    if (!rec) return undefined;
    for (const key of ["executionId", "runId", "id"] as const) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
    return undefined;
  };
  const top = asRecord(body);
  return fromRecord(top) ?? fromRecord(asRecord(top?.data));
}

function mapTxHashes(v: unknown): RunTxHash[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RunTxHash[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.length > 0) {
      out.push({ hash: item });
      continue;
    }
    const rec = asRecord(item);
    if (rec && typeof rec.hash === "string" && rec.hash.length > 0) {
      const tx: RunTxHash = { hash: rec.hash };
      if (typeof rec.chainId === "number") tx.chainId = rec.chainId;
      if (typeof rec.network === "string") tx.network = rec.network;
      if (typeof rec.nodeName === "string") tx.nodeName = rec.nodeName;
      out.push(tx);
    }
  }
  return out.length > 0 ? out : undefined;
}

function extractErrorDetail(rec: Record<string, unknown>): string | undefined {
  for (const key of ["error", "detail"] as const) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v !== undefined && v !== null) return JSON.stringify(v);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// HTTP client

export interface HttpKeeperHubClientOptions {
  /** WF-2's trigger endpoint (KEEPERHUB_DEFEND_WEBHOOK_URL). */
  triggerUrl: string;
  apiKey?: string;
  /** REST base for execution status reads. */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: KeeperHubLogger;
}

export const DEFAULT_KEEPERHUB_API_BASE_URL = "https://app.keeperhub.com/api";

export class HttpKeeperHubClient implements KeeperHubClient {
  private readonly triggerUrl: string;
  private readonly apiKey: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: KeeperHubLogger | undefined;

  constructor(opts: HttpKeeperHubClientOptions) {
    this.triggerUrl = opts.triggerUrl;
    this.apiKey = opts.apiKey;
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_KEEPERHUB_API_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
  }

  /**
   * Fire the WF-2 defense workflow.
   *
   * VERIFIED end-to-end against the live API on 2026-08-01 (probe workflows
   * c59sy9julvftyzeyz8gdi / lemzd7pw3pxo9ddw08fa0, then WF-2 itself):
   *  - Endpoint: POST {apiBaseUrl}/workflows/{workflowId}/execute.
   *  - Auth: `Authorization: Bearer kh_…`. `x-api-key` is rejected outright
   *    ("Missing Authorization header").
   *  - Body: the payload MUST be wrapped as {"input": {...}}. A bare body is
   *    accepted with 200 but its fields never reach the trigger node, and every
   *    {{@trigger-1:Trigger.<field>}} reference then fails to resolve.
   *  - Response: {"executionId": "...", "status": "running"} — top level.
   *
   * The sibling POST /api/workflows/{id}/webhook endpoint also exists but
   * requires a separate user webhook key (wfb_*); the org kh_* key is rejected
   * there with 401 wrong_key_type. See docs/keeperhub-verification.md.
   *
   * We still parse the response permissively (executionId | runId | id, with or
   * without a { data: {...} } envelope) and FAIL CLOSED when no run id is found:
   * without an id we cannot track the execution, so we refuse to report a
   * successful trigger.
   */
  async triggerDefense(payload: DefensePayload): Promise<TriggerResult> {
    const url = this.triggerUrl;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify({ input: payload }),
    });
    const body = await readBody(res);

    if (!res.ok) {
      this.logger?.error("KeeperHub defense trigger failed", {
        status: res.status,
        decisionId: payload.decisionId,
      });
      throw new KeeperHubHttpError(`KeeperHub defense trigger failed: HTTP ${res.status}`, {
        status: res.status,
        body,
        url,
      });
    }

    const runId = extractRunId(body);
    if (runId === undefined) {
      // 2xx but untrackable — fail closed rather than pretend the run is known.
      throw new KeeperHubHttpError(
        "KeeperHub trigger returned 2xx but no run id was found " +
          "(looked for executionId|runId|id at the top level and under a data envelope); " +
          "refusing to treat the trigger as tracked",
        { status: res.status, body, url },
      );
    }

    this.logger?.info("KeeperHub defense triggered", { runId, decisionId: payload.decisionId });
    return { runId, raw: body };
  }

  /**
   * Read execution status. VERIFIED endpoint:
   * GET {apiBaseUrl}/workflows/executions/{runId}/status
   * (docs.keeperhub.com/api/executions, 2026-07-30).
   *
   * State mapping choice: the documented enum is pending|running|success|error|
   * cancelled. An UNKNOWN status value maps to "running" (non-terminal) with a
   * logger.warn and the original value retained in `raw` — fail closed: we keep
   * polling until the deadline instead of inventing a terminal outcome. The
   * alternatives were rejected: throwing would abort tracking of a run that may
   * still complete, and mapping to "pending" would misstate observed progress.
   *
   * Session-2 optimization: the documented blocking
   * GET {apiBaseUrl}/workflows/executions/{id}/wait?timeoutMs= endpoint could
   * replace client-side polling.
   */
  async getRun(runId: string): Promise<RunStatus> {
    const url = `${this.apiBaseUrl}/workflows/executions/${encodeURIComponent(runId)}/status`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers({ json: false }),
    });
    const body = await readBody(res);

    if (!res.ok) {
      this.logger?.error("KeeperHub execution status read failed", {
        status: res.status,
        runId,
      });
      throw new KeeperHubHttpError(
        `KeeperHub execution status read failed for run ${runId}: HTTP ${res.status}`,
        { status: res.status, body, url },
      );
    }

    const resource = unwrapData(body);
    const state = this.mapState(resource.status, runId);
    const txHashes = mapTxHashes(resource.transactionHashes);
    const status: RunStatus = { runId, state, raw: body };
    if (txHashes) {
      status.txHashes = txHashes;
      const first = txHashes[0];
      if (first) status.txHash = first.hash;
    }
    const error = extractErrorDetail(resource);
    if (error !== undefined) status.error = error;
    return status;
  }

  private mapState(raw: unknown, runId: string): RunState {
    if (typeof raw === "string" && KNOWN_RUN_STATES.has(raw)) {
      return raw as RunState;
    }
    this.logger?.warn(
      "KeeperHub returned an unknown execution status; treating as non-terminal 'running'",
      { runId, status: raw === undefined ? "<missing>" : String(raw) },
    );
    return "running";
  }

  private headers(opts: { json: boolean }): Record<string, string> {
    const h: Record<string, string> = {};
    if (opts.json) h["content-type"] = "application/json";
    if (this.apiKey !== undefined) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }
}

/** Read a body as JSON when possible, raw text otherwise, null when empty. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// waitForRun

export interface WaitForRunOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** Injected in tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; defaults to Date.now. */
  clock?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll getRun with exponential backoff until a terminal state
 * (success | error | cancelled). Throws RunTimeoutError on deadline —
 * the caller must then record the execution as timed out (fail closed),
 * never assume it succeeded.
 */
export async function waitForRun(
  client: KeeperHubClient,
  runId: string,
  opts: WaitForRunOptions = {},
): Promise<RunStatus> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const initialDelayMs = opts.initialDelayMs ?? 2_000;
  const maxDelayMs = opts.maxDelayMs ?? 15_000;
  const factor = opts.factor ?? 1.5;
  const sleep = opts.sleep ?? realSleep;
  const clock = opts.clock ?? Date.now;

  const deadline = clock() + timeoutMs;
  let delayMs = initialDelayMs;

  for (;;) {
    const status = await client.getRun(runId);
    if (isTerminalRunState(status.state)) return status;

    const now = clock();
    if (now >= deadline) throw new RunTimeoutError(runId, timeoutMs);

    // Never sleep past the deadline; keeps the timeout exact under fake clocks too.
    await sleep(Math.min(delayMs, deadline - now));
    delayMs = Math.min(maxDelayMs, delayMs * factor);
  }
}

// ---------------------------------------------------------------------------
// Mock client (capability-off mode + tests)

export interface MockKeeperHubClientOptions {
  /** Per-run state progression; defaults to ["pending", "running", "success"]. */
  script?: RunState[];
  /** Every triggerDefense throws KeeperHubHttpError. */
  failTrigger?: boolean;
  /** Only the FIRST triggerDefense throws; subsequent calls succeed. */
  failOnce?: boolean;
  /** getRun always reports "running" — for timeout tests. */
  neverTerminal?: boolean;
}

/** Deterministic fake tx hash: hex of the decisionId's chars padded to 64 nibbles. */
function fakeTxHashFor(decisionId: string): string {
  let hex = "";
  for (const ch of decisionId) {
    hex += (ch.codePointAt(0) ?? 0).toString(16).padStart(2, "0");
  }
  return `0x${hex.padEnd(64, "0").slice(0, 64)}`;
}

interface MockRun {
  payload: DefensePayload;
  /** Index of the last served script step; -1 before the first getRun. */
  step: number;
}

export class MockKeeperHubClient implements KeeperHubClient {
  /** Every payload passed to triggerDefense, including ones whose trigger threw. */
  readonly receivedPayloads: DefensePayload[] = [];

  private readonly script: RunState[];
  private readonly failTrigger: boolean;
  private failOnceArmed: boolean;
  private readonly neverTerminal: boolean;
  private readonly runs = new Map<string, MockRun>();

  constructor(opts: MockKeeperHubClientOptions = {}) {
    this.script =
      opts.script !== undefined && opts.script.length > 0
        ? [...opts.script]
        : ["pending", "running", "success"];
    this.failTrigger = opts.failTrigger ?? false;
    this.failOnceArmed = opts.failOnce ?? false;
    this.neverTerminal = opts.neverTerminal ?? false;
  }

  async triggerDefense(payload: DefensePayload): Promise<TriggerResult> {
    // Record BEFORE any failure so blocked/failed attempts stay observable.
    this.receivedPayloads.push(payload);
    if (this.failTrigger || this.failOnceArmed) {
      this.failOnceArmed = false;
      throw new KeeperHubHttpError("mock KeeperHub trigger failure", {
        status: 500,
        body: { error: "mock KeeperHub trigger failure" },
        url: "mock://keeperhub/webhook",
      });
    }
    const runId = `mockrun_${ulid()}`;
    this.runs.set(runId, { payload, step: -1 });
    return { runId, raw: { mock: true, executionId: runId } };
  }

  async getRun(runId: string): Promise<RunStatus> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      // Fail closed: an unknown run must never look like a tracked one.
      throw new KeeperHubHttpError(`mock KeeperHub: unknown runId ${runId}`, {
        status: 404,
        body: null,
        url: "mock://keeperhub/executions",
      });
    }

    if (this.neverTerminal) {
      return { runId, state: "running", raw: { mock: true, neverTerminal: true } };
    }

    // Advance one step per call; once a terminal state is reached it sticks.
    const current = run.step >= 0 ? this.script[run.step] : undefined;
    if (current === undefined || !isTerminalRunState(current)) {
      run.step = Math.min(run.step + 1, this.script.length - 1);
    }
    const state = this.script[run.step] ?? "pending";

    const status: RunStatus = {
      runId,
      state,
      raw: { mock: true, step: run.step, state },
    };
    if (state === "success") {
      const hash = fakeTxHashFor(run.payload.decisionId);
      status.txHash = hash;
      status.txHashes = [{ hash }];
    }
    if (state === "error") {
      status.error = "execution reverted (mock)";
    }
    return status;
  }
}
