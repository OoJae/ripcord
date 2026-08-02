/**
 * The approval gate's two failure postures are opposite ON PURPOSE, and that
 * asymmetry is the whole design:
 *   copilot  — silence means NO (fail-closed). A mode whose point is human
 *              consent must not execute when the human never answered.
 *   autopilot— silence means GO (fail-open). A mode whose point is autonomy
 *              must not be disarmed by an unread notification.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileApprovalGate, noopApprovalGate } from "../../src/approval/gate.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ripcord-approval-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const req = (id: string) => ({ decisionId: id, summary: "repay $4.79", windowMs: 3_000 });

describe("noopApprovalGate — no channel configured", () => {
  it("denies copilot approval (fail-closed)", async () => {
    expect(await noopApprovalGate.requestApproval(req("a"))).toBe(false);
  });
  it("does not block autopilot (fail-open)", async () => {
    expect(await noopApprovalGate.awaitCancelWindow(req("a"))).toBe(true);
  });
});

describe("createFileApprovalGate", () => {
  it("approval: times out to FALSE when the human never answers", async () => {
    const gate = createFileApprovalGate({ dir: tempDir(), sleep: async () => {}, pollMs: 1_000 });
    expect(await gate.requestApproval(req("timeout-1"))).toBe(false);
  });

  it("approval: returns true when the approve file exists, and consumes it", async () => {
    const dir = tempDir();
    const gate = createFileApprovalGate({ dir, sleep: async () => {}, pollMs: 1_000 });
    writeFileSync(join(dir, "approve-ok-1"), "");
    expect(await gate.requestApproval(req("ok-1"))).toBe(true);
    // Consumed: a stale approval must never authorise a second, later defense.
    expect(await gate.requestApproval(req("ok-1"))).toBe(false);
  });

  it("cancel window: times out to TRUE (silence = proceed)", async () => {
    const gate = createFileApprovalGate({ dir: tempDir(), sleep: async () => {}, pollMs: 1_000 });
    expect(await gate.awaitCancelWindow(req("go-1"))).toBe(true);
  });

  it("cancel window: a cancel file aborts, and is consumed", async () => {
    const dir = tempDir();
    const gate = createFileApprovalGate({ dir, sleep: async () => {}, pollMs: 1_000 });
    writeFileSync(join(dir, "cancel-stop-1"), "");
    expect(await gate.awaitCancelWindow(req("stop-1"))).toBe(false);
    expect(await gate.awaitCancelWindow(req("stop-1"))).toBe(true);
  });

  it("cancel beats approve when both are present — the veto always wins", async () => {
    const dir = tempDir();
    const gate = createFileApprovalGate({ dir, sleep: async () => {}, pollMs: 1_000 });
    writeFileSync(join(dir, "approve-both-1"), "");
    writeFileSync(join(dir, "cancel-both-1"), "");
    expect(await gate.requestApproval(req("both-1"))).toBe(false);
  });

  it("signals are per-decision — approving one does not authorise another", async () => {
    const dir = tempDir();
    const gate = createFileApprovalGate({ dir, sleep: async () => {}, pollMs: 1_000 });
    writeFileSync(join(dir, "approve-decision-A"), "");
    expect(await gate.requestApproval(req("decision-B"))).toBe(false);
    expect(await gate.requestApproval(req("decision-A"))).toBe(true);
  });

  it("prompts with both paths so the human knows what to touch", async () => {
    const dir = tempDir();
    const prompted: { approve?: string; cancel?: string } = {};
    const gate = createFileApprovalGate({
      dir,
      sleep: async () => {},
      pollMs: 1_000,
      onPrompt: (_r, approve, cancel) => {
        prompted.approve = approve;
        prompted.cancel = cancel;
      },
    });
    await gate.requestApproval(req("prompt-1"));
    expect(prompted.approve).toContain("approve-prompt-1");
    expect(prompted.cancel).toContain("cancel-prompt-1");
  });
});
