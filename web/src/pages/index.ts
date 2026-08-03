import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/pages.css";
import { armArrest } from "../motion/arrest.js";
import { mountCanopy } from "../scene/canopy.js";
import { initShell } from "../shell/shell.js";
import { mountAltimeter } from "../ui/altimeter.js";
import { createHfStore } from "../ui/hfStore.js";

const shell = initShell();

const canvas = document.getElementById("canopy") as HTMLCanvasElement | null;
const scene = canvas ? mountCanopy(canvas, shell.smooth) : null;

if (shell.reducedMotion || !shell.smooth) {
  // Not a ride: the altimeter rests at the recovered reading, matching the
  // static bloomed canopy the scene renders (or the CSS poster).
  const el = document.getElementById("altimeter");
  el?.classList.add("is-recovered");
  const v = el?.querySelector(".altimeter-value");
  const b = el?.querySelector(".altimeter-band");
  if (v) v.textContent = "HF 1.6028";
  if (b) b.textContent = "RECOVERED";
} else {
  const hfStore = createHfStore();
  mountAltimeter(hfStore);
  if (scene) {
    armArrest({ smooth: shell.smooth, hfStore, uArrest: scene.uniforms.uArrest });
  }
}
