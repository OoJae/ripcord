import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/pages.css";
import { initShell } from "../shell/shell.js";
import { mountAltimeter } from "../ui/altimeter.js";
import { createHfStore } from "../ui/hfStore.js";

const shell = initShell();

const canvas = document.getElementById("canopy") as HTMLCanvasElement | null;

// The altimeter is text and must not wait on WebGL.
let hfStore: ReturnType<typeof createHfStore> | null = null;

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
  hfStore = createHfStore();
  mountAltimeter(hfStore);
}

// Three.js is ~122KB and decorative. Loading it in the entry chunk put the
// hero headline — the single most important line of copy on the site — behind
// it on a slow connection. Split it out: the page reads immediately, the
// canopy arrives when it arrives.
if (canvas) {
  void (async () => {
    const [{ mountCanopy }, { armArrest }] = await Promise.all([
      import("../scene/canopy.js"),
      import("../motion/arrest.js"),
    ]);
    const scene = mountCanopy(canvas, shell.smooth);
    if (scene && hfStore && shell.smooth) {
      armArrest({ smooth: shell.smooth, hfStore, uArrest: scene.uniforms.uArrest });
    }
  })();
}
