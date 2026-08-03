/**
 * The altimeter — the instrument that makes the scroll a descent.
 * Reads the hfStore; writes the DOM only when the formatted string changes.
 * Width is ch-pinned in CSS so ticking digits never shift layout.
 */

import type { HfStore } from "./hfStore.js";

export function mountAltimeter(store: HfStore): void {
  const root = document.getElementById("altimeter");
  if (!root) return;
  const value = root.querySelector<HTMLElement>(".altimeter-value");
  const band = root.querySelector<HTMLElement>(".altimeter-band");
  if (!value || !band) return;

  let lastText = "";
  let lastBand = "";

  store.subscribe((s) => {
    const text = `HF ${s.hf.toFixed(4)}`;
    if (text !== lastText) {
      lastText = text;
      value.textContent = text;
    }
    if (s.band !== lastBand) {
      lastBand = s.band;
      band.textContent = s.band;
    }
    root.classList.toggle("is-recovered", s.phase === "recovered");
    root.classList.toggle("is-warn", s.phase === "freefall" && s.hf < 1.5);
  });
}
