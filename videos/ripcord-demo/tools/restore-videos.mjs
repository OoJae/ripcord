/**
 * assemble-index HOISTS approved <video> elements out of the frame files and
 * into index.html — mutating the frames in place. That makes assembly
 * NON-IDEMPOTENT: a second run sees frames with no video and silently emits an
 * index with no footage at all.
 *
 * This restores the four clips into their frames so assembly can be re-run
 * safely. Frames stay the source of truth; index.html is fully derived.
 *
 *   node tools/restore-videos.mjs && node …/assemble-index.mjs … && …/transitions.mjs inject …
 */
import { readFileSync, writeFileSync } from "node:fs";

const MARK = "<!-- approved frame video hoisted by assemble-index";

// id, file, duration (must cover the frame's CURRENT root duration, which the
// transition injector extends), aria, loop, media-start
const SPEC = [
  ["02-the-slow-leak", "slowleak02-hero", "hero.mp4", 18.72, "Ripcord live site, hero", true, null],
  ["05-the-fall", "f05fall-descent", "descent.mp4", 7.88, "Ripcord live site scrolling past its policy bands", false, "3.4"],
  ["06-the-pull", "f06pull-canopy", "pull.mp4", 13.94, "The Ripcord canopy blooming on the live site", false, "3"],
  ["14-it-earns", "f14-earns-evidence", "evidence.mp4", 10.82, "Ripcord flight log, scrolling", false, null],
];

for (const [cid, id, src, dur, aria, loop, mediaStart] of SPEC) {
  const path = `compositions/frames/${cid}.html`;
  const html = readFileSync(path, "utf8");
  if (html.includes("<video")) {
    console.log(`  ${cid}: already present`);
    continue;
  }
  const i = html.indexOf(MARK);
  if (i === -1) {
    console.log(`  ${cid}: NO hoist marker — cannot restore`);
    continue;
  }
  const end = html.indexOf("-->", i) + 3;
  const tag =
    `<video\n      id="${id}"\n      class="clip"\n      src="assets/footage/${src}"\n` +
    `      preload="auto"\n      aria-label="${aria}"\n      muted\n      playsinline\n` +
    (loop ? "      loop\n" : "") +
    `      data-frame-video="approved"\n` +
    (mediaStart ? `      data-media-start="${mediaStart}"\n` : "") +
    `      data-start="0"\n      data-duration="${dur}"\n      data-track-index="1"\n` +
    `      data-frame-video-x="0"\n      data-frame-video-y="0"\n` +
    `      data-frame-video-width="1920"\n      data-frame-video-height="1080"\n` +
    `      data-frame-video-fit="cover"\n    ></video>`;
  writeFileSync(path, html.slice(0, i) + tag + html.slice(end));
  console.log(`  ${cid}: restored ${src}${mediaStart ? ` @${mediaStart}s` : ""}${loop ? " loop" : ""}`);
}
