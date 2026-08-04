/**
 * Per-page bootstrap. Every page calls initShell() first.
 * Owns the global concerns: reduced-motion branch, the expressive ease,
 * smooth scroll, and text reveals. Pages layer their own choreography on top.
 */

import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { initReveals } from "../motion/reveal.js";
import { createSmooth, type Smooth } from "../motion/smooth.js";
import { initTransitions } from "../ui/transition.js";

gsap.registerPlugin(CustomEase);
CustomEase.create("expressive", "0.16,1,0.3,1");

export interface ShellContext {
  /** True when the user asked for reduced motion — the whole site honors it. */
  reducedMotion: boolean;
  /** Smooth-scroll handle; null under reduced motion (native scroll). */
  smooth: Smooth | null;
}

export function initShell(): ShellContext {
  // Tells the head's failsafe the bundle booted; without this it un-hides
  // everything after 2.5s (see the inline script in each page head).
  document.documentElement.setAttribute("data-booted", "1");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const smooth = reducedMotion ? null : createSmooth();
  initTransitions(reducedMotion);
  void initReveals(reducedMotion);
  return { reducedMotion, smooth };
}
