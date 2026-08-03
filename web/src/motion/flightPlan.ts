/**
 * The flight plan — the single source of truth mapping the landing page's
 * scroll to the Health Factor the altimeter shows. The numbers are real:
 * band boundaries from src/config.ts:17-24, endpoints from the mainnet save
 * (docs/evidence/EVIDENCE.md:226-261 — 1.240014 → 1.602815).
 */

export type FlightPhase = "freefall" | "arrest" | "recovered";

export interface FlightSegment {
  /** Matches a section's data-flight attribute on index.html. */
  id: string;
  hfFrom: number;
  hfTo: number;
  band: string;
  phase: FlightPhase;
}

export const FLIGHT_PLAN: readonly FlightSegment[] = [
  { id: "hold", hfFrom: 1.6, hfTo: 1.6, band: "HEALTHY", phase: "freefall" },
  { id: "drift", hfFrom: 1.6, hfTo: 1.5, band: "HEALTHY", phase: "freefall" },
  { id: "warn", hfFrom: 1.5, hfTo: 1.26, band: "WARN", phase: "freefall" },
  { id: "act", hfFrom: 1.26, hfTo: 1.24, band: "ACT", phase: "freefall" },
  { id: "pull", hfFrom: 1.24, hfTo: 1.24, band: "ACT · PULL", phase: "arrest" },
  { id: "climb", hfFrom: 1.24, hfTo: 1.6028, band: "RECOVERED", phase: "recovered" },
] as const;
