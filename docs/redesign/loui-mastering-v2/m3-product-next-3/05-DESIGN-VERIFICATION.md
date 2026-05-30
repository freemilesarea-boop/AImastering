# M3-P-NEXT-3 — Design Verification Checklist

> Use this checklist when reviewing ProductPage in Storybook.

---

## 1. Storybook → Product / ProductPage / SpotifyLoud

Default story.  Should look like a finished audio product, not a
developer demo.

- [ ] Top bar reads "Loui Mastering · Result" with an engine chip
- [ ] Preset header shows 7 chips; "Streaming Loud" is highlighted at first
- [ ] Spectrum canvas fills the centre with a green "live" pulse top-right
- [ ] Right rail has two panel shells (Loudness / Stereo)
- [ ] Module strip shows 5 cards with mixed states
- [ ] Status bar at the bottom reports 48 kHz / Stereo / 4× / target chips
- [ ] No accidental scroll bars on the main viewport (1440 × 900)

---

## 2. Storybook → ProductPage viewport variants

Switch via the viewport dropdown to "Desktop 1280px" and "Narrow laptop 1024":

- [ ] At **1440 px**: spectrum has ~720 px width; module strip cards are
      wide enough to read both rows
- [ ] At **1280 px**: spectrum compresses to ~560 px; layout remains
      readable; preset chips don't wrap
- [ ] At **1024 px**: module strip uses minWidth (168 px × 5);
      horizontal scroll appears on preset header (not the page)

The page never overflows vertically — the analyzer canvas + meter rail
flex to fit the remaining height after fixed regions.

---

## 3. Contrast audit

Against `surface.background = #09090b`:

| Foreground | Contrast | WCAG |
|---|---|---|
| `text.primary` (#fafafa) on `surface.panel` (#0f0f12)         | 17.6 : 1 | AAA |
| `text.secondary` (#e4e4e7)                                    | 14.5 : 1 | AAA |
| `text.tertiary` (#a1a1aa)                                     |  6.3 : 1 | AA  |
| `text.muted` (#71717a)                                        |  3.4 : 1 | AA  (large only) |
| `meter.safe.foreground` (#10b981)                             |  5.1 : 1 | AA  |
| `meter.danger.foreground` (#ef4444)                           |  4.6 : 1 | AA  |
| `meter.accent.foreground` (#a78bfa)                           |  7.0 : 1 | AA  |

Action: keep `text.muted` at `size.xs` (10 px) only for non-critical
labels (status-bar cells, helper text).

---

## 4. Typography hierarchy

Open the SpotifyLoud story and zoom to 200 %:

- [ ] Top-bar wordmark reads as the most prominent label (16 px semi-bold)
- [ ] Panel headers (14 px semi-bold) are visibly larger than panel body
- [ ] Module card titles match panel headers — 14 px semi-bold
- [ ] All live numbers (status bar, transport time, meter readouts) use
      mono with `tabular-nums` — no digit jitter on value changes
- [ ] Section labels ("TARGET", "MODULE CHAIN") are 10 px medium uppercase
      with 0.16 em letter-spacing

---

## 5. Colour usage sanity

For each meter colour:

- [ ] `meter.safe`     appears on: live pulse, status-bar running dot,
      Dynamics card "Linear-knee-flatten" curve, Module "On" pill
- [ ] `meter.warn`     appears on: Limiter card triangle waveform,
      Module "Locked" pill
- [ ] `meter.danger`   appears on: Limiter card ceiling dashes (and
      embedded V2 panels' verdict chips when state warrants)
- [ ] `meter.accent`   appears on: Export emphasis button, active preset
      chip border + tone tag, EQ card curve, Module "Soon" pill, selected
      module card border

If any meter colour appears in a place not in this list, it's a
violation of the "red is reserved for safety" guideline.

---

## 6. Animation smoothness

In the SpotifyLoud story:

- [ ] Live pulse fade between active/idle uses 120 ms ease-out — feels
      snappy but not abrupt
- [ ] Hovering top-bar buttons swaps background in ~120 ms
- [ ] Preset chip hover/active transition is smooth — no flicker
- [ ] Transport scrubber fill animates 100 ms linear (not visible in
      Storybook without media, but inspect the inline style)
- [ ] Module card hover lifts the surface from `panel` → `well` smoothly

---

## 7. Module strip semantics

In the "Default" Module Strip story:

- [ ] EQ + Dynamics + Limiter cards are at full opacity (active)
- [ ] Imager card is at 0.78 opacity with "Bypass" pill
- [ ] Export card is at 0.72 opacity with violet "Soon" pill
- [ ] Clicking any card highlights its border with the accent colour
- [ ] Helper text reads "Click a module to open its parameters (coming soon)"

In the "AllLocked" story:

- [ ] Every card has the amber "Locked" pill (looks consistent with a
      future trial/restricted-licence visualisation)

---

## 8. Cross-story coherence

Inspect SpotifyLoud, AIHarsh, ClippingRisk, BrokenPhase, and Idle
side-by-side:

- [ ] Same row heights / paddings across all stories — no jitter
- [ ] Loudness and stereo panels swap their internal verdict chips
      correctly (Mono Safe / Wide / Phase Risk / etc.)
- [ ] Spectrum visualisation reflects each preset's shape (mock data
      drives the curve; AI Harsh shows the 3–5 kHz peak)
- [ ] Module strip is identical across stories — its data is layout-only,
      not preset-driven, in this milestone

---

## 9. "Does it look commercial?" — subjective check

Side-by-side with Ozone screenshots:

- [ ] Spacing breathes — no cramped chrome
- [ ] Hierarchy is clear at a 3-foot reading distance (numbers readable)
- [ ] Colour palette is restrained — no rainbow, no neon
- [ ] No gaming-UI tropes (scanlines, glow, chromatic aberration)
- [ ] Preset chips read as "settings", not "buttons"
- [ ] Module cards read as "this is what the audio is going through" —
      not as "controls"

---

## 10. Open issues / follow-ups

| ID | Issue | Severity | Owner |
|---|---|---|---|
| M3-P3-W-A | Module Strip click does nothing — no parameter panel yet | Trivial | M3-P-NEXT-4 |
| M3-P3-W-B | Storybook viewport switcher needs `@storybook/addon-viewport` for full UX | Trivial | optional add-on |
| M3-P3-W-C | Preset chips don't persist selection across reloads — state is local | Low | M3-P-NEXT-4 |
| M3-P3-W-D | Transport scrubber is keyboard-inaccessible (no arrow-key seek) | Low | a11y pass M3-P-NEXT-5+ |
| M3-P3-W-E | Engine chip in TopBar duplicates the StatusBar engine label | Trivial | dedupe in a future polish PR |

---

## 11. Sign-off

When the boxes above are green, mark this milestone "M3-P-NEXT-3
verified" in the design log.  Next: M3-P-NEXT-4 (hook Module Strip
cards to real parameter slide-overs, promote ProductPage to default).
