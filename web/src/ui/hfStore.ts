/**
 * hfStore — one store, two consumers. Registers a ScrollTrigger per
 * flight-plan segment; the latest active segment (document order) drives the
 * HF value, band label, and phase. The altimeter DOM and the WebGL scene both
 * subscribe here, so the scroll→HF mapping exists exactly once.
 */

import { ScrollTrigger } from "gsap/ScrollTrigger";
import { FLIGHT_PLAN, type FlightPhase } from "../motion/flightPlan.js";

export interface HfState {
  hf: number;
  band: string;
  phase: FlightPhase;
}

type Listener = (s: HfState) => void;

export interface HfStore {
  state: HfState;
  subscribe(fn: Listener): void;
  /** The arrest flips recovery on before the climb segment scrolls in. */
  setPhase(phase: FlightPhase): void;
}

export function createHfStore(): HfStore {
  const state: HfState = { hf: 1.6, band: "HEALTHY", phase: "freefall" };
  const listeners: Listener[] = [];

  const emit = () => {
    for (const fn of listeners) {
      fn(state);
    }
  };

  const set = (hf: number, band: string, phase: FlightPhase) => {
    if (state.hf === hf && state.band === band && state.phase === phase) return;
    state.hf = hf;
    state.band = band;
    state.phase = phase;
    emit();
  };

  for (const seg of FLIGHT_PLAN) {
    const el = document.querySelector<HTMLElement>(`[data-flight="${seg.id}"]`);
    if (!el) continue;
    ScrollTrigger.create({
      trigger: el,
      start: "top center",
      end: "bottom center",
      onUpdate: (self) => {
        const hf = seg.hfFrom + (seg.hfTo - seg.hfFrom) * self.progress;
        // A manual "recovered" phase (set by the arrest) outlives freefall
        // segments only in the forward direction; scrolling back up above the
        // pull hands control back to the segment's own phase.
        set(Number(hf.toFixed(4)), seg.band, seg.phase);
      },
    });
  }

  return {
    state,
    subscribe(fn: Listener) {
      listeners.push(fn);
      fn(state);
    },
    setPhase(phase: FlightPhase) {
      if (state.phase === phase) return;
      state.phase = phase;
      emit();
    },
  };
}
