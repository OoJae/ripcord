/**
 * Threshold policy: band classification + the defend/suppress state machine.
 *
 * PURE MODULE — no I/O, no timers, no Date.now(). Callers inject `nowMs`.
 * Band comparisons use 1e18 wad bigints exclusively (never floats); the float
 * `hf`/`hfVelocityPerMin` fields are display-only and may at most decorate the
 * reason string.
 *
 * Band semantics (pinned; boundaries belong to the more protective band except
 * where explicit below — thresholds warn 1.50 · act 1.25 · panic 1.10):
 *   healthy : hfWad >  warn            (exactly 1.50 → warn)
 *   warn    : act   <  hfWad <= warn   (exactly 1.25 → act)
 *   act     : panic <= hfWad <= act    (exactly 1.10 → act; panic is STRICTLY below 1.10)
 *   panic   : hfWad <  panic
 * No-debt sentinel: hasDebt === false (Aave reports HF = type(uint256).max) → healthy.
 *
 * WHY PANIC BYPASSES BOTH THE ARMED LATCH AND THE COOLDOWN:
 * The hysteresis latch and cooldown exist to stop flapping — repeated small
 * defenses when HF oscillates around the act boundary. In panic (HF < 1.10)
 * the position is one adverse price tick from liquidation, which is an
 * irreversible loss of collateral plus a liquidation penalty. Position
 * survival outranks flap protection: suppressing a real panic defense can
 * lose the whole position, while a spurious panic defense is bounded by the
 * Guard's caps (max-tx USD, daily cap), decision idempotency, and the
 * single-in-flight execution rule. So panic always defends (expedited), and
 * flap damping is deliberately confined to the act band.
 */

import type { Band, PolicyResult, PolicyState, Snapshot, ThresholdsWad } from "../types.js";

/**
 * Classify a raw health-factor wad into a band. Pure bigint comparisons —
 * see the module header for the pinned boundary semantics.
 */
export function classifyBand(hfWad: bigint, t: ThresholdsWad): Band {
  if (hfWad > t.warn) return "healthy";
  if (hfWad > t.act) return "warn";
  if (hfWad >= t.panic) return "act";
  return "panic";
}

/**
 * Evaluate one snapshot against the policy state machine.
 *
 * - healthy/warn: never defend; re-arm the hysteresis latch only when
 *   hfWad > t.rearm (STRICT — exactly rearm does not re-arm).
 * - act: defend only if armed AND the cooldown has elapsed (inclusive >=);
 *   suppression reasons name the blocker ("unarmed" / "cooldown").
 * - panic: defend unconditionally, expedited (see module header).
 *
 * Never mutates `state`; `nextState` is a fresh object with lastBand = band.
 */
export function evaluate(
  snapshot: Snapshot,
  t: ThresholdsWad,
  state: PolicyState,
  nowMs: number,
): PolicyResult {
  const band: Band = snapshot.hasDebt ? classifyBand(snapshot.hfWad, t) : "healthy";

  const cooldownOk =
    state.lastFiredAtMs == null || nowMs - state.lastFiredAtMs >= t.cooldownSec * 1000;

  let armed = state.armed;
  let shouldDefend = false;
  let expedited = false;
  let reason: string;

  switch (band) {
    case "healthy":
    case "warn": {
      if (!state.armed && snapshot.hfWad > t.rearm) {
        armed = true;
        reason = `${band}: hf strictly above rearm threshold — hysteresis latch re-armed`;
      } else {
        reason = `${band}: no defense needed`;
      }
      break;
    }
    case "act": {
      const blockers: string[] = [];
      if (!state.armed) {
        blockers.push("unarmed (hysteresis latch open; re-arms only when hf > rearm)");
      }
      if (!cooldownOk) {
        blockers.push("cooldown active since last defense");
      }
      if (blockers.length === 0) {
        shouldDefend = true;
        reason = "act: armed and cooldown elapsed — defend";
      } else {
        reason = `act: defense suppressed — ${blockers.join("; ")}`;
      }
      break;
    }
    case "panic": {
      shouldDefend = true;
      expedited = true;
      reason = "panic: defending unconditionally (bypasses armed latch and cooldown; expedited)";
      break;
    }
  }

  // Display-only decoration: a falling HF may be surfaced in the reason, but
  // velocity NEVER changes the band or the defend decision.
  if (snapshot.hfVelocityPerMin != null && snapshot.hfVelocityPerMin < 0) {
    reason += ` [hf velocity ${snapshot.hfVelocityPerMin.toFixed(4)}/min]`;
  }

  return {
    band,
    shouldDefend,
    expedited,
    reason,
    nextState: { armed, lastFiredAtMs: state.lastFiredAtMs, lastBand: band },
  };
}

/**
 * Record that a defense fired: disarm the hysteresis latch and anchor the
 * cooldown at `nowMs`. Pure — returns a fresh state, never mutates the input.
 */
export function markDefenseFired(state: PolicyState, nowMs: number): PolicyState {
  return { armed: false, lastFiredAtMs: nowMs, lastBand: state.lastBand };
}
