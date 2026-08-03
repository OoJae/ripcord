/**
 * Per-page bootstrap. Every page calls initShell() first.
 * Owns the global concerns: reduced-motion branch, smooth scroll,
 * page transitions, and the altimeter mount. Pages then layer their
 * own choreography on top.
 */

export interface ShellContext {
  /** True when the user asked for reduced motion — the whole site honors it. */
  reducedMotion: boolean;
}

export function initShell(): ShellContext {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return { reducedMotion };
}
