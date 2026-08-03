/**
 * Page transitions — the canopy wipe. An orange overlay with a canopy-arc
 * leading edge sweeps up on internal navigation, then the destination page
 * wipes it away on arrival (flagged via sessionStorage). Navigation itself is
 * NATIVE — real <a href>, no router, nothing to break. Modified clicks, new
 * tabs, downloads, hashes and reduced motion all skip the theatre.
 */

import { gsap } from "gsap";

const FLAG = "ripcord:wipe";

function buildOverlay(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "wipe";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    '<svg class="wipe-arc" viewBox="0 0 100 12" preserveAspectRatio="none">' +
    '<path d="M0 12 Q 50 -12 100 12 Z" fill="currentColor"/></svg>' +
    '<div class="wipe-body"></div>';
  document.body.appendChild(el);
  gsap.set(el, { yPercent: 112 }); // parked offscreen; gsap owns position (see components.css)
  return el;
}

export function initTransitions(reducedMotion: boolean): void {
  if (reducedMotion) {
    sessionStorage.removeItem(FLAG);
    return;
  }

  const overlay = buildOverlay();

  // Arrival: if the previous page wiped out, wipe in (reveal the new page).
  if (sessionStorage.getItem(FLAG) === "1") {
    sessionStorage.removeItem(FLAG);
    gsap.fromTo(
      overlay,
      { yPercent: 0 },
      { yPercent: -112, duration: 0.6, ease: "expressive", delay: 0.05 },
    );
  }

  // Departure: same-origin, same-tab page links get the wipe.
  document.addEventListener("click", (ev) => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = (ev.target as Element | null)?.closest?.("a");
    if (!a) return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.hash) return; // in-page anchor

    ev.preventDefault();
    sessionStorage.setItem(FLAG, "1");
    gsap.fromTo(
      overlay,
      { yPercent: 112 },
      {
        yPercent: 0,
        duration: 0.38,
        ease: "power3.in",
        onComplete: () => {
          location.href = url.href;
        },
      },
    );
  });

  // Hide latency behind the wipe: prefetch page links on intent.
  const prefetched = new Set<string>();
  document.addEventListener(
    "pointerenter",
    (ev) => {
      const a = (ev.target as Element | null)?.closest?.("a[href$='.html'], a[href='/']");
      if (!a) return;
      const href = (a as HTMLAnchorElement).href;
      if (!href.startsWith(location.origin) || prefetched.has(href)) return;
      prefetched.add(href);
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = href;
      document.head.appendChild(link);
    },
    true,
  );
}
