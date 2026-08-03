/**
 * Renderer shell: WebGL context on the fixed background canvas, DPR clamped
 * to 1.5, render callback on gsap's ticker (one shared frame with ScrollTrigger),
 * paused when the tab is hidden. Throws if WebGL is unavailable — the caller
 * swaps in the CSS poster.
 */

import { gsap } from "gsap";
import { PerspectiveCamera, Scene, WebGLRenderer } from "three";

export interface RendererShell {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** Register the per-frame update; starts the loop. */
  start(update: (dt: number) => void): void;
  stop(): void;
}

export function createRendererShell(canvas: HTMLCanvasElement): RendererShell {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.1, 20);
  camera.position.set(0, 0.1, 2.6);

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  let tick: ((time: number, dt: number) => void) | null = null;
  let running = false;

  const start = (update: (dt: number) => void) => {
    if (tick) gsap.ticker.remove(tick);
    tick = (_time, dt) => {
      update(dt / 1000);
      renderer.render(scene, camera);
    };
    running = true;
    gsap.ticker.add(tick);
    // Paint one frame immediately — never a blank canvas while the ticker spins up.
    update(0);
    renderer.render(scene, camera);
  };

  const stop = () => {
    if (tick) gsap.ticker.remove(tick);
    running = false;
  };

  // A hidden tab must not burn frames.
  document.addEventListener("visibilitychange", () => {
    if (!tick) return;
    if (document.hidden) {
      gsap.ticker.remove(tick);
    } else if (running) {
      gsap.ticker.add(tick);
    }
  });

  return { scene, camera, renderer, start, stop };
}
