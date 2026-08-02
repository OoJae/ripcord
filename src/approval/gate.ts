/**
 * Interruptibility — the trust primitive Ripcord was missing.
 *
 * Research across mature autonomy products converges on one pattern: people
 * accept autonomy they can *interrupt*. PagerDuty has acknowledge; alarm panels
 * have an entry delay before the siren; brokers offer Reg-T's call window
 * alongside portfolio margin's real-time autonomy. Ripcord had exactly two
 * settings — fully autonomous, or DRY_RUN (does nothing, ever).
 *
 * Three modes now sit between those poles:
 *   advisory  — full pipeline, real alerts, never executes. A recommendation
 *               engine. (Distinct from DRY_RUN: that is a safety flag; this is
 *               a product mode, recorded in the audit trail as such.)
 *   copilot   — the payload is built and HELD pending explicit approval.
 *               Panic still auto-fires: an unreachable owner must not become a
 *               liquidation, which is the same doctrine that lets panic bypass
 *               the hysteresis latch and cooldown.
 *   autopilot — acts, but announces a cancel window in the act band first.
 *               Panic skips the window (instant-trigger zone, in alarm terms).
 *
 * The gate is an injected seam so the daemon never knows the channel. The file
 * gate below works anywhere (including this build network, where Telegram is
 * unreachable) and is what the tests drive; a Telegram inline-keyboard gate is
 * a drop-in implementation of the same two methods.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type DefenseMode = "advisory" | "copilot" | "autopilot";

export interface ApprovalRequest {
  decisionId: string;
  /** One-line human summary, e.g. "repay $4.79 USDC → HF 1.24 → 1.60". */
  summary: string;
  /** How long to wait for the human, in ms. */
  windowMs: number;
}

export interface ApprovalGate {
  /** copilot: true only on an explicit approval. Timeout ⇒ false (fail-closed). */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  /** autopilot: true unless the human cancels within the window (fail-OPEN by design). */
  awaitCancelWindow(req: ApprovalRequest): Promise<boolean>;
}

/**
 * No channel configured. Copilot cannot be satisfied, so it denies — a mode
 * that requires a human, with no way to reach one, must not silently execute.
 * The cancel window is a no-op: autopilot's contract is "acts unless stopped".
 */
export const noopApprovalGate: ApprovalGate = {
  async requestApproval() {
    return false;
  },
  async awaitCancelWindow() {
    return true;
  },
};

export interface FileApprovalGateOptions {
  dir: string;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  onPrompt?: (req: ApprovalRequest, approvePath: string, cancelPath: string) => void;
}

/**
 * Filesystem gate: `touch approve-<decisionId>` to approve, `cancel-<decisionId>`
 * to cancel. Deliberately dumb — no network, no polling a third-party API, and
 * it works over SSH, in CI, and from a phone via any file-sync tool.
 */
export function createFileApprovalGate(opts: FileApprovalGateOptions): ApprovalGate {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 1_000;
  mkdirSync(opts.dir, { recursive: true });

  const paths = (decisionId: string) => ({
    approve: join(opts.dir, `approve-${decisionId}`),
    cancel: join(opts.dir, `cancel-${decisionId}`),
  });

  async function watch(
    req: ApprovalRequest,
    /** Value returned when the window expires with no signal. */
    onTimeout: boolean,
  ): Promise<boolean> {
    const { approve, cancel } = paths(req.decisionId);
    opts.onPrompt?.(req, approve, cancel);
    let waited = 0;
    for (;;) {
      if (existsSync(cancel)) {
        rmSync(cancel, { force: true });
        return false;
      }
      if (existsSync(approve)) {
        rmSync(approve, { force: true });
        return true;
      }
      if (waited >= req.windowMs) return onTimeout;
      await sleep(Math.min(pollMs, req.windowMs - waited));
      waited += pollMs;
    }
  }

  return {
    // Fail-CLOSED: no explicit approval means no defense.
    requestApproval: (req) => watch(req, false),
    // Fail-OPEN: silence means proceed. That is what autopilot means.
    awaitCancelWindow: (req) => watch(req, true),
  };
}
