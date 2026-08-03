# Ripcord — brand system

One page. If a use isn't covered here, default to quiet: void background, silk
text, and save the orange for the pull.

## The idea

Ripcord fuses two worlds that share one physics: skydiving instrumentation and
position telemetry. The altimeter reads Health Factor. The policy bands are
pull altitudes. The signature texture is **ripstop** — the fabric woven so a
tear stops at the next thread, which is the product's whole thesis rendered as
cloth. The one loud thing anywhere it appears is **the pull**: blaze orange,
the color of a real ripcord handle.

## Color

| Token | Hex | Use |
|---|---|---|
| `--void` | `#0A0B10` | background — night-jump sky, instrument-panel black |
| `--silk` | `#EDEAE3` | text on dark — ripstop nylon off-white |
| `--handle` | `#FF4F00` | THE accent. CTAs, the act band, the pull, live links. Never decorative fills |
| `--phosphor` | `#7CF5C4` | state color only: the altimeter's "safe" reading after a save |
| `--hairline` | `#23262F` | rules, dividers, card strokes |
| `--dim` | `#8A8F9C` | secondary text, labels |

Rules: near-monochrome, one accent. `--phosphor` never appears unless something
was actually saved/verified. Body text ≥ 4.5:1 on void; `--handle` at display
sizes only.

Film: grain overlay at ~4% + the ripstop grid (12px fine weave, 96px
reinforcement) at 1.5–2.5% silk. Both live in `web/src/styles/base.css`.

## Type

| Role | Face | Notes |
|---|---|---|
| Display | Clash Display 600 | headlines, uppercase for hero-scale; tracking −0.02 to −0.03em |
| Body | Satoshi 400/500 | sentence case, quiet |
| Instrument | Space Mono 400 | the altimeter voice: labels (caps, +0.12em), telemetry, tx hashes, rule ids |

Anything that is a *measurement* — an HF value, a hash, a rule id, a price —
is set in Space Mono. That contrast is the identity.

Faces are self-hosted subset woff2 in `web/public/fonts/` (Fontshare ITF Free
Font License for Clash Display/Satoshi; OFL for Space Mono).

## Assets (`web/public/brand/`)

- `wordmark.svg` — the lockup: handle mark + RIPCORD in Clash Display 600
  outlines with **the rip** — a slash through the second R, tail slipped
  14/26 units — the tear, caught. Regenerate outlines with fonttools
  (`TTFont` → `SVGPathPen`) if the face ever changes.
- `mark.svg` — the pull handle: orange stadium D-ring, three silk cords.
- `favicon.svg` — simplified mark (ring + one cord) on a void rounded square.
- `og.png` — 1200×630 social card. Regenerate:
  `"…/Google Chrome" --headless=new --window-size=1200,630 --hide-scrollbars
  --screenshot=web/public/brand/og.png web/scripts/og.html`

## Motion

- Ease: `cubic-bezier(0.16, 1, 0.3, 1)` ("expressive") for reveals; linear only
  for ambient loops. State toggles: `cubic-bezier(0.65, 0, 0.35, 1)`.
- Micro 0.2–0.4s · reveals 0.6–1.0s · hero 0.9–1.4s · sibling stagger 0.05–0.12s.
- One loud moment per page. On the landing it is THE PULL; nothing else may
  compete with it.
- `prefers-reduced-motion`: static bloomed canopy, opacity-only fades, native
  scroll. Always.

## Voice

Plain verbs, sentence case, specific over clever. Numbers only when real and
sourced (see `web/src/data/telemetry.ts` — every figure carries its source
ref). Never claim a capability the code doesn't have; the honest limitation,
stated plainly, is on-brand ("What Ripcord is not", system.html).

## Do / don't

- DO set measurements in mono; DO use the band thresholds as structural markers.
- DO let the void breathe — negative space is the luxury.
- DON'T use `--handle` for decoration, backgrounds, or long text.
- DON'T show `--phosphor` before a save exists.
- DON'T add a second accent, a gradient brand wash, or a light theme.
