/**
 * Footage capture for the demo film. Drives the LIVE site with real wheel
 * events so Lenis smooths the scroll exactly as a human would, records 1080p,
 * and transcodes to h264 for the composition.
 *
 * Lives in the project (not a temp dir) so a cleaned scratchpad can't destroy
 * the footage the film depends on.
 *
 *   node tools/capture.mjs [clip|all]
 */
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "https://oojae.github.io/ripcord/";
const OUT = "assets/footage";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ w = 1920, h = 1080 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      `--window-size=${w},${h}`,
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--enable-unsafe-swiftshader",
      "--force-color-profile=srgb",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  return { browser, page };
}

/** Real wheel input, eased — Lenis turns this into its own smooth motion. */
async function wheelTo(page, total, ms, steps = 70) {
  const dt = ms / steps;
  const e = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: (e((i + 1) / steps) - e(i / steps)) * total });
    await sleep(dt);
  }
}

async function goto(page, path = "") {
  await page.goto(BASE + path, { waitUntil: "networkidle0" });
  await sleep(2600); // fonts + the load choreography settle
}

async function stage(page, sel, offset = 0) {
  await page.evaluate(
    (s, o) => {
      const el = document.querySelector(s);
      if (el) {
        window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top + o, behavior: "instant" });
      }
    },
    sel,
    offset,
  );
  await sleep(1800);
}

async function clip(page, name, fn) {
  const rec = await page.screencast({ path: `${OUT}/${name}.webm` });
  await fn();
  await rec.stop();
  console.log(`  ✓ ${name}`);
}

const CLIPS = {
  // Scene 02 — hero at rest, the silk breathing. No scroll.
  async hero() {
    const { browser, page } = await launch();
    await goto(page);
    await clip(page, "hero", () => sleep(9000));
    await page.screenshot({ path: `${OUT}/still-hero.png` });
    await browser.close();
  },
  // Scene 05 — the descent: 1.60 → 1.50 → 1.25, altimeter ticking.
  async descent() {
    const { browser, page } = await launch();
    await goto(page);
    await clip(page, "descent", async () => {
      await sleep(700);
      await wheelTo(page, 2600, 8000, 100);
      await sleep(1000);
    });
    await browser.close();
  },
  // Scene 06 — THE PULL. The one loud moment.
  async pull() {
    const { browser, page } = await launch();
    await goto(page);
    await stage(page, '[data-flight="act"]');
    await clip(page, "pull", async () => {
      await sleep(900);
      await wheelTo(page, 1500, 6000, 90);
      await sleep(4500); // hold on the bloomed canopy + the receipt
    });
    await page.screenshot({ path: `${OUT}/still-receipt.png` });
    await browser.close();
  },
  // Scene 11 — the Guard manifest, rule chips stamping in.
  async guard() {
    const { browser, page } = await launch();
    await goto(page);
    await stage(page, ".guard-manifest", -640);
    await clip(page, "guard", async () => {
      await wheelTo(page, 720, 3400, 55);
      await sleep(2600);
    });
    await browser.close();
  },
  // Scene 12 — the three modes.
  async modes() {
    const { browser, page } = await launch();
    await goto(page);
    await stage(page, ".modes", -640);
    await clip(page, "modes", async () => {
      await wheelTo(page, 720, 3400, 55);
      await sleep(2600);
    });
    await browser.close();
  },
  // Scene 14 — the flight log, x402 receipts.
  async evidence() {
    const { browser, page } = await launch();
    await goto(page, "evidence.html");
    await clip(page, "evidence", async () => {
      await sleep(800);
      await wheelTo(page, 2000, 7000, 90);
      await sleep(900);
    });
    await stage(page, "#log-x402");
    await page.screenshot({ path: `${OUT}/still-x402.png` });
    await browser.close();
  },
};

const which = process.argv[2] ?? "all";
for (const n of which === "all" ? Object.keys(CLIPS) : [which]) {
  console.log(`▶ ${n}`);
  await CLIPS[n]();
}
console.log("done");
