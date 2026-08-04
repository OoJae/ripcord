/**
 * Scene orchestrator — mounts the cloth behind the landing page and binds
 * every uniform to the page's choreography:
 *   uScroll     master page progress (scrub)
 *   uMorph      plane→canopy bloom, scrubbed across the pull section
 *   uTurbulence smoothed Lenis velocity (freefall flutter)
 *   uArrest     the pull's damped kick (armArrest)
 * The mesh drifts from right-of-center (streamer, behind the hero's negative
 * space) to center (canopy) as the morph completes.
 */

import { gsap } from "gsap";
import type { Smooth } from "../motion/smooth.js";
import { createCloth } from "./cloth.js";
import { createRendererShell } from "./renderer.js";

export interface CanopyScene {
  uniforms: ReturnType<typeof createCloth>["uniforms"];
  stop(): void;
}

export function mountCanopy(canvas: HTMLCanvasElement, smooth: Smooth | null): CanopyScene | null {
  let shell: ReturnType<typeof createRendererShell>;
  try {
    shell = createRendererShell(canvas);
  } catch {
    // No WebGL: reveal the CSS poster and carry on — the page still works.
    canvas.hidden = true;
    document.getElementById("poster")?.removeAttribute("hidden");
    return null;
  }

  const cloth = createCloth();
  shell.scene.add(cloth.mesh);
  const { uniforms } = cloth;

  const desktop = () => window.innerWidth >= 768;
  // Mobile: the streamer hugs the right edge and shrinks — it must never
  // sit on top of the copy on a narrow viewport.
  const restX = () => (desktop() ? 0.55 : 0.42);

  // Reduced motion: the canopy poster — fully bloomed, one frame, stop.
  // Held well back: at full strength, centred, it drove body copy to ~1.3:1 for
  // exactly the users the setting exists to protect.
  if (!smooth) {
    uniforms.uMorph.value = 1;
    uniforms.uTurbulence.value = 0;
    uniforms.uOpacity.value = 0.16;
    cloth.mesh.position.x = restX();
    shell.start(() => {});
    requestAnimationFrame(() => shell.stop());
    return { uniforms, stop: shell.stop };
  }

  cloth.mesh.position.x = restX();
  cloth.mesh.scale.setScalar(desktop() ? 1 : 0.78);

  // The bloom, scrubbed across the pull section — reversible by construction.
  gsap.to(uniforms.uMorph, {
    value: 1,
    ease: "none",
    scrollTrigger: {
      trigger: "[data-flight='pull']",
      start: "top 80%",
      end: "bottom 90%",
      scrub: 0.6,
    },
  });

  // Fade the scene out under the quiet content past the loop section.
  gsap.to(uniforms.uOpacity, {
    value: 0.25,
    ease: "none",
    scrollTrigger: {
      trigger: ".guard-manifest",
      start: "top 90%",
      end: "top 30%",
      scrub: true,
    },
  });

  shell.start((dt) => {
    uniforms.uTime.value += dt;
    uniforms.uTurbulence.value = smooth.turbulence();
    // Streamer rides right-of-center; the canopy takes the middle.
    const targetX = restX() * (1 - uniforms.uMorph.value);
    cloth.mesh.position.x += (targetX - cloth.mesh.position.x) * 0.06;
    cloth.mesh.rotation.z = Math.sin(uniforms.uTime.value * 0.1) * 0.04;
  });

  return { uniforms, stop: shell.stop };
}
