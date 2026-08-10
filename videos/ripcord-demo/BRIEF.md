---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Ripcord already caught a real position on mainnet — autonomously, and you can audit every step"
destination: youtube
aspect: 1920x1080
language: en
length: 140s
angle: proof-first
audience: "DoraHacks judges for the KeeperHub Agents Onchain hackathon, and DeFi power users"
---

## Intent

A hackathon demo film for Ripcord: an autonomous, MEV-aware liquidation-protection
agent for Aave V3 on Base. The film has to do two jobs at once — make a judge
*feel* the save (freefall arrested) and prove it actually happened with real
on-chain evidence.

Tone: measured, dry, expensive. The numbers sell; the voice stays calm. Restraint
over flash — one loud moment (THE PULL) and everything around it disciplined and
quiet. This must not read as an AI-template product video.

The angle is taken from the site's own dramaturgy so the film and the landing page
tell one story: **freefall → the pull → under canopy**.

## Assets

- ../../docs/video/ripcord vo.m4a — the finished voice-over, 140.1s. VERBATIM; the
  film is cut to this waveform, never the reverse.
- ../../docs/video/SCRIPT.md — the VO script + shot list this was recorded from.
- Captured 1080p footage of the LIVE site (scratchpad capture/mp4/): hero-idle,
  descent, the-pull (the money shot), guard, modes, evidence, system-loop,
  mobile-descent. Recaptured after the QA fixes, so they match what is live now.
- Terminal logs (scratchpad capture/terminal/): the mock decision loop descending
  1.82 → 1.09, a REAL Guard block (`arm-flag`) that even panic cannot bypass, the
  clean dry-run payload with all 15 checks, 322 passing tests, and live status.
- Basescan page for the hero tx 0x6e314ece…9cd05.

## Customizations

- VO_MODE: verbatim. The audio is already recorded — every scene is timed to the
  real waveform, not to an estimate.
- Terminal output is TYPESET in-brand (Space Mono on void, handle accents) rather
  than screen-recorded with Terminal.app chrome. Designed, not filmed.
- The site's own palette and type are the film's design system — the brand kit
  already exists (docs/brand/BRAND.md): void #0A0B10, silk #EDEAE3, handle
  #FF4F00, phosphor #7CF5C4. If it is a number, it is set in mono.
- Real footage only. No mocked-up screens, no invented numbers.

## Notes

- Every figure in the VO is sourced; docs/video/SCRIPT.md carries the source table.
  Two claims were corrected after an adversarial QA sweep caught them: the save is
  21s sense→landed (10.7s was the KeeperHub run's internal time), and autopilot's
  cancel window is opt-in, not unconditional.
- The hero run logged 12/12 Guard checks against the Guard as it stood that day;
  it is 14 rules now. Never conflate the two on screen.
- Signed out of HeyGen: no TTS needed (VO supplied); BGM via local MusicGen if a
  bed earns its place, otherwise ship silent under the voice.
- Deadline Aug 13 2026 12:00 UTC+2. This film is the critical path.
