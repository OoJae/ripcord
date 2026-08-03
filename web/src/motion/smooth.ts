/**
 * Smooth scroll backbone: Lenis driven by gsap's ticker (one shared frame),
 * ScrollTrigger kept in sync, and a smoothed scroll-velocity accessor the
 * scene reads every frame to drive cloth turbulence.
 */

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

export interface Smooth {
  lenis: Lenis;
  /** Smoothed |velocity| in 0..1 — the scene's turbulence input. */
  turbulence(): number;
}

/** Scroll speed (px/frame-ish from Lenis) treated as "terminal velocity". */
const VELOCITY_MAX = 90;

export function createSmooth(): Smooth {
  const lenis = new Lenis({ lerp: 0.1 });

  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => {
    lenis.raf(time * 1000);
  });
  gsap.ticker.lagSmoothing(0);

  let turb = 0;
  gsap.ticker.add(() => {
    const target = Math.min(Math.abs(lenis.velocity) / VELOCITY_MAX, 1);
    turb += (target - turb) * 0.08;
  });

  return {
    lenis,
    turbulence: () => turb,
  };
}
