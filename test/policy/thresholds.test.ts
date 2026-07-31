/**
 * Example-based tests for the threshold policy: exact band boundaries,
 * hysteresis latch, cooldown window, velocity neutrality, and purity.
 * Every safety rule has at least one FAILING-case test (suppression paths).
 */

import { describe, expect, it } from "vitest";
import { THRESHOLDS_WAD } from "../../src/config.js";
import { classifyBand, evaluate, markDefenseFired } from "../../src/policy/thresholds.js";
import type { Band, PolicyState } from "../../src/types.js";
import { MAX_UINT256, ONE_WEI, WAD_1_10, WAD_1_25, WAD_1_50, WAD_1_55, wadOf } from "../fixtures/aave.js";
import { makeSnapshot } from "../helpers/fakes.js";

const T0 = 1_753_920_000_000;
const COOLDOWN_MS = THRESHOLDS_WAD.cooldownSec * 1000;

function freshArmed(lastBand: Band = "healthy"): PolicyState {
  return { armed: true, lastFiredAtMs: null, lastBand };
}

describe("classifyBand — band matrix (pinned boundaries)", () => {
  const cases: Array<{ name: string; hfWad: bigint; expected: Band }> = [
    { name: "maxUint-style no-debt sentinel", hfWad: MAX_UINT256, expected: "healthy" },
    { name: "2.0", hfWad: wadOf("2.0"), expected: "healthy" },
    { name: "1.50 + 1 wei", hfWad: WAD_1_50 + ONE_WEI, expected: "healthy" },
    { name: "exactly 1.50", hfWad: WAD_1_50, expected: "warn" },
    { name: "1.50 - 1 wei", hfWad: WAD_1_50 - ONE_WEI, expected: "warn" },
    { name: "1.25 + 1 wei", hfWad: WAD_1_25 + ONE_WEI, expected: "warn" },
    { name: "exactly 1.25", hfWad: WAD_1_25, expected: "act" },
    { name: "1.25 - 1 wei", hfWad: WAD_1_25 - ONE_WEI, expected: "act" },
    { name: "1.10 + 1 wei", hfWad: WAD_1_10 + ONE_WEI, expected: "act" },
    { name: "exactly 1.10", hfWad: WAD_1_10, expected: "act" },
    { name: "1.10 - 1 wei", hfWad: WAD_1_10 - ONE_WEI, expected: "panic" },
    { name: "0.5", hfWad: wadOf("0.5"), expected: "panic" },
    { name: "0", hfWad: 0n, expected: "panic" },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(classifyBand(c.hfWad, THRESHOLDS_WAD)).toBe(c.expected);
    });
  }
});

describe("evaluate — hysteresis latch", () => {
  it("after markDefenseFired, act-band dip does NOT defend and reason mentions unarmed", () => {
    const fired = markDefenseFired(freshArmed("act"), T0);
    // Cooldown fully elapsed so the ONLY blocker is the open latch.
    const r = evaluate(makeSnapshot("1.20"), THRESHOLDS_WAD, fired, T0 + COOLDOWN_MS);
    expect(r.band).toBe("act");
    expect(r.shouldDefend).toBe(false);
    expect(r.reason).toMatch(/unarmed/);
  });

  it("recovery to exactly 1.55 does NOT re-arm (strict >)", () => {
    const state: PolicyState = { armed: false, lastFiredAtMs: T0, lastBand: "act" };
    const r = evaluate(
      makeSnapshot("1.55", { hfWad: WAD_1_55 }),
      THRESHOLDS_WAD,
      state,
      T0 + COOLDOWN_MS,
    );
    expect(r.band).toBe("healthy");
    expect(r.nextState.armed).toBe(false);
  });

  it("1.55 + 1 wei re-arms, then a dip to 1.20 (cooldown elapsed) fires", () => {
    const state: PolicyState = { armed: false, lastFiredAtMs: T0, lastBand: "act" };
    const recovered = evaluate(
      makeSnapshot("1.55", { hfWad: WAD_1_55 + ONE_WEI }),
      THRESHOLDS_WAD,
      state,
      T0 + COOLDOWN_MS,
    );
    expect(recovered.nextState.armed).toBe(true);

    const dip = evaluate(
      makeSnapshot("1.20"),
      THRESHOLDS_WAD,
      recovered.nextState,
      T0 + COOLDOWN_MS + 60_000,
    );
    expect(dip.band).toBe("act");
    expect(dip.shouldDefend).toBe(true);
  });

  it("panic fires even while unarmed (latch bypassed)", () => {
    const state: PolicyState = { armed: false, lastFiredAtMs: T0, lastBand: "act" };
    const r = evaluate(makeSnapshot("0.50"), THRESHOLDS_WAD, state, T0 + 60_000);
    expect(r.band).toBe("panic");
    expect(r.shouldDefend).toBe(true);
    expect(r.expedited).toBe(true);
  });

  it("fresh armed state fires at 1.20 (act, not expedited)", () => {
    const r = evaluate(makeSnapshot("1.20"), THRESHOLDS_WAD, freshArmed(), T0);
    expect(r.band).toBe("act");
    expect(r.shouldDefend).toBe(true);
    expect(r.expedited).toBe(false);
  });
});

describe("evaluate — cooldown window", () => {
  // Armed with a prior fire on record (e.g. re-armed after a defense).
  const armedWithHistory = (): PolicyState => ({ armed: true, lastFiredAtMs: T0, lastBand: "act" });

  it("+1799s is suppressed with a cooldown reason", () => {
    const r = evaluate(makeSnapshot("1.20"), THRESHOLDS_WAD, armedWithHistory(), T0 + 1_799_000);
    expect(r.band).toBe("act");
    expect(r.shouldDefend).toBe(false);
    expect(r.reason).toMatch(/cooldown/);
  });

  it("exactly +1800s fires (inclusive >=)", () => {
    const r = evaluate(makeSnapshot("1.20"), THRESHOLDS_WAD, armedWithHistory(), T0 + 1_800_000);
    expect(r.shouldDefend).toBe(true);
  });

  it("+1801s fires", () => {
    const r = evaluate(makeSnapshot("1.20"), THRESHOLDS_WAD, armedWithHistory(), T0 + 1_801_000);
    expect(r.shouldDefend).toBe(true);
  });

  it("panic at +60s fires despite active cooldown", () => {
    const r = evaluate(makeSnapshot("0.90"), THRESHOLDS_WAD, armedWithHistory(), T0 + 60_000);
    expect(r.band).toBe("panic");
    expect(r.shouldDefend).toBe(true);
    expect(r.expedited).toBe(true);
  });
});

describe("evaluate — velocity is display-only", () => {
  it("same wad with velocity -0.5 vs +0.5 → identical band and shouldDefend", () => {
    const falling = evaluate(
      makeSnapshot("1.20", { hfVelocityPerMin: -0.5 }),
      THRESHOLDS_WAD,
      freshArmed(),
      T0,
    );
    const rising = evaluate(
      makeSnapshot("1.20", { hfVelocityPerMin: 0.5 }),
      THRESHOLDS_WAD,
      freshArmed(),
      T0,
    );
    expect(falling.band).toBe(rising.band);
    expect(falling.shouldDefend).toBe(rising.shouldDefend);
    expect(falling.expedited).toBe(rising.expedited);
  });

  it("steep negative velocity appears in the reason only — decision matches null velocity", () => {
    const neutral = evaluate(
      makeSnapshot("1.20", { hfVelocityPerMin: null }),
      THRESHOLDS_WAD,
      freshArmed(),
      T0,
    );
    const steep = evaluate(
      makeSnapshot("1.20", { hfVelocityPerMin: -0.5 }),
      THRESHOLDS_WAD,
      freshArmed(),
      T0,
    );
    expect(steep.band).toBe(neutral.band);
    expect(steep.shouldDefend).toBe(neutral.shouldDefend);
    expect(steep.reason).toMatch(/velocity/);
    expect(neutral.reason).not.toMatch(/velocity/);
  });
});

describe("purity and state transitions", () => {
  it("evaluate never mutates the passed-in state and returns a fresh nextState", () => {
    const state: PolicyState = { armed: false, lastFiredAtMs: T0, lastBand: "act" };
    const before = { ...state };
    const r = evaluate(
      makeSnapshot("1.60", { hfWad: wadOf("1.60") }),
      THRESHOLDS_WAD,
      state,
      T0 + COOLDOWN_MS,
    );
    expect(state).toEqual(before);
    expect(r.nextState).not.toBe(state);
    expect(r.nextState.armed).toBe(true); // re-armed on the copy, not on the input
  });

  it("evaluate always sets nextState.lastBand to the classified band", () => {
    const state: PolicyState = { armed: true, lastFiredAtMs: null, lastBand: "panic" };
    const r = evaluate(makeSnapshot("2.00"), THRESHOLDS_WAD, state, T0);
    expect(r.band).toBe("healthy");
    expect(r.nextState.lastBand).toBe("healthy");
  });

  it("no-debt snapshot is healthy regardless of sentinel hfWad", () => {
    const r = evaluate(
      makeSnapshot("1.20", { hasDebt: false, hfWad: MAX_UINT256, hf: Number.POSITIVE_INFINITY }),
      THRESHOLDS_WAD,
      freshArmed(),
      T0,
    );
    expect(r.band).toBe("healthy");
    expect(r.shouldDefend).toBe(false);
  });

  it("markDefenseFired disarms, anchors cooldown, preserves lastBand, and never mutates", () => {
    const state = freshArmed("act");
    const before = { ...state };
    const next = markDefenseFired(state, T0);
    expect(next).toEqual({ armed: false, lastFiredAtMs: T0, lastBand: "act" });
    expect(state).toEqual(before);
    expect(next).not.toBe(state);
  });
});
