/**
 * THE PULL — the one hard moment on the page.
 *
 * When the pull section reaches the viewport's upper third: the smooth
 * scroll's lerp momentarily tightens (0.1 → 0.32 → 0.1) so the scroll itself
 * feels caught, the fabric takes one violent damped kick (uArrest), and the
 * altimeter's phase flips to recovered. Scrolling back above re-arms it —
 * the ride is honest in both directions.
 */

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { HfStore } from "../ui/hfStore.js";
import type { Smooth } from "./smooth.js";

export function armArrest(opts: {
  smooth: Smooth;
  hfStore: HfStore;
  uArrest: { value: number };
}): void {
  const { smooth, hfStore, uArrest } = opts;
  let fired = false;

  ScrollTrigger.create({
    trigger: "[data-flight='pull']",
    start: "top 40%",
    onEnter: () => {
      if (fired) return;
      fired = true;

      // The catch: scroll goes taut, then eases back to drift.
      const proxy = { lerp: 0.1 };
      gsap
        .timeline()
        .to(proxy, {
          lerp: 0.32,
          duration: 0.12,
          ease: "power2.in",
          onUpdate: () => {
            smooth.lenis.options.lerp = proxy.lerp;
          },
        })
        .to(proxy, {
          lerp: 0.1,
          duration: 0.5,
          ease: "expressive",
          onUpdate: () => {
            smooth.lenis.options.lerp = proxy.lerp;
          },
          onComplete: () => {
            hfStore.setPhase("recovered");
          },
        });

      // One damped kick through the fabric.
      uArrest.value = 1;
      gsap.to(uArrest, { value: 0, duration: 0.8, ease: "expo.out" });
    },
    onLeaveBack: () => {
      fired = false;
      hfStore.setPhase("freefall");
    },
  });
}
