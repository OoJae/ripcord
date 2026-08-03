/**
 * Text reveals — lines rise out of an overflow mask, once, near the viewport.
 *
 * Hand-rolled line splitter: wait for fonts (line breaks depend on them),
 * wrap words, group by offsetTop into lines, mask each line, animate the
 * inner span. After the reveal the element is un-split back to plain text so
 * later resizes cost nothing. Reduced motion: no splitting, opacity only.
 * Headlines reveal by line, not by letter — per the motion doctrine.
 */

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

interface SplitResult {
  lines: HTMLElement[];
  restore(): void;
}

function buildLine(text: string): { line: HTMLElement; inner: HTMLElement } {
  const line = document.createElement("span");
  line.className = "line";
  line.style.display = "block";
  line.style.overflow = "hidden";
  line.setAttribute("aria-hidden", "true"); // the element's aria-label carries the text
  const inner = document.createElement("span");
  inner.className = "line-inner";
  inner.style.display = "block";
  inner.textContent = text;
  line.appendChild(inner);
  return { line, inner };
}

function splitLines(el: HTMLElement): SplitResult {
  const original = el.innerHTML;
  // <br> is an authored line break (the hero title) — honor it; textContent
  // alone would glue "Pull<br>before" into "Pullbefore".
  const authored = original
    .split(/<br\s*\/?>/i)
    .map((chunk) =>
      chunk
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  el.setAttribute("aria-label", authored.join(" "));

  const lines: HTMLElement[] = [];

  if (authored.length > 1) {
    // Explicit breaks: each chunk IS a line — no measurement needed.
    el.innerHTML = "";
    for (const text of authored) {
      const { line, inner } = buildLine(text);
      el.appendChild(line);
      lines.push(inner);
    }
  } else {
    // Natural wrapping: wrap words, group by rendered offsetTop.
    const words = (el.textContent ?? "").split(/\s+/).filter(Boolean);
    el.innerHTML = words.map((w) => `<span class="w">${w}</span>`).join(" ");
    const spans = Array.from(el.querySelectorAll<HTMLElement>("span.w"));
    const byTop = new Map<number, HTMLElement[]>();
    for (const s of spans) {
      const bucket = byTop.get(s.offsetTop);
      if (bucket) {
        bucket.push(s);
      } else {
        byTop.set(s.offsetTop, [s]);
      }
    }
    el.innerHTML = "";
    for (const [, ws] of [...byTop.entries()].sort((a, b) => a[0] - b[0])) {
      const { line, inner } = buildLine(ws.map((w) => w.textContent).join(" "));
      el.appendChild(line);
      lines.push(inner);
    }
  }

  return {
    lines,
    restore() {
      el.innerHTML = original;
      el.removeAttribute("aria-label");
      // The CSS pre-hide (html.js [data-reveal]) still applies to the parent;
      // the .line children that made it visible are gone now, so pin it open.
      el.style.visibility = "visible";
    },
  };
}

/** Elements whose markup must survive (links, spans) fade as a block instead. */
function hasMarkup(el: HTMLElement): boolean {
  return el.children.length > 0;
}

export async function initReveals(reducedMotion: boolean): Promise<void> {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (targets.length === 0) return;

  if (reducedMotion) {
    // Opacity only, no motion, no splitting.
    for (const el of targets) {
      gsap.fromTo(
        el,
        { autoAlpha: 0 },
        {
          autoAlpha: 1,
          duration: 0.4,
          scrollTrigger: { trigger: el, start: "top 92%", once: true },
        },
      );
    }
    return;
  }

  await document.fonts.ready;

  // Above-the-fold content (hero / page head) is the page-load choreography:
  // one staged sequence on arrival, not scroll-gated — a CTA sitting at the
  // fold must never be hostage to a trigger line. Everything else reveals
  // once near the viewport.
  let loadStagger = 0;

  for (const el of targets) {
    const isHero = el.dataset.reveal === "hero";
    const duration = isHero ? 1.2 : 0.8;
    const onLoad = el.closest(".hero, .page-head") !== null;
    const delay = onLoad ? 0.15 + loadStagger : 0;
    if (onLoad) loadStagger += 0.14;

    const scrollTrigger = onLoad
      ? undefined
      : ({ trigger: el, start: "top 85%", once: true } as const);

    if (hasMarkup(el) && el.tagName !== "H1" && el.tagName !== "H2") {
      // Blocks with inline markup (receipt, tables, buttons): rise as one.
      // fromTo, not from: the CSS pre-hide leaves computed visibility hidden,
      // and .from() would faithfully restore that at the end. Explicit end
      // values pin the element open.
      gsap.fromTo(
        el,
        { autoAlpha: 0, y: 28 },
        { autoAlpha: 1, y: 0, duration, delay, ease: "expressive", scrollTrigger },
      );
      continue;
    }

    const split = splitLines(el);
    gsap.fromTo(
      split.lines,
      { yPercent: 110 },
      {
        yPercent: 0,
        duration,
        delay,
        ease: "expressive",
        stagger: isHero ? 0.09 : 0.06,
        scrollTrigger,
        onComplete: () => split.restore(),
      },
    );
  }

  // Splitting changed layout heights after triggers were measured.
  ScrollTrigger.refresh();
}
