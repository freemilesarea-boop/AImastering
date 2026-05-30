# M3-P-NEXT-4 — Design Verification Checklist

> Use this checklist when reviewing the slide-over + parameter panels
> in Storybook.

---

## 1. Open / close behaviour

In `Product / Module Slide-Over / Closed`:

- [ ] Page renders the 5 demo buttons centred, no panel visible
- [ ] No backdrop visible
- [ ] No focus ring on any button

Click `EQ`:
- [ ] Backdrop fades in over ~200 ms
- [ ] Panel slides from the right over ~280 ms (no jitter at 60 fps)
- [ ] After the slide finishes, focus is on the first interactive
      parameter (Low Cut slider) — not on the × button
- [ ] EQ button in the demo row gets the accent border

Press ESC:
- [ ] Panel slides out smoothly (no content blanking before the slide)
- [ ] Focus returns to the EQ button in the demo row
- [ ] Backdrop pointer events disabled after close

Click backdrop:
- [ ] Same close behaviour

Click ×:
- [ ] Same close behaviour

Re-click `EQ` (when already open):
- [ ] Panel closes (toggle)

---

## 2. Tab cycling inside the panel

Open EQ.  Tab through the panel:

- [ ] First Tab → Low Cut slider (auto-focused on open)
- [ ] Subsequent Tabs visit Low Shelf, Presence, Air, Output Gain,
      Adaptive toggle, × button in some order
- [ ] At the last focusable, Tab cycles back to the first
- [ ] Shift+Tab at the first focusable cycles to the last
- [ ] Tab never escapes to the underlying demo buttons

---

## 3. Per-panel content audit

### EqOpen

- [ ] EQ Curve section visible with the schematic curve
- [ ] Mode badge top-right reads "Adaptive" (default state)
- [ ] Five band rows visible in the Bands section
- [ ] Slider drag updates the curve preview live
- [ ] Output gain section shows the Adaptive toggle pill

### DynamicsOpen

- [ ] Gain Reduction meter at top, animated (random-walk mock)
- [ ] Four knobs in a row: Threshold / Ratio / Attack / Release
- [ ] Each knob's value updates the GR meter target (visible after a
      few seconds)
- [ ] Parallel section at bottom shows the Mix slider

### ImagerOpen

- [ ] Correlation section shows a Live badge + mirror meter
- [ ] Correlation drifts when Width slider is moved
- [ ] Stereo section with Width / Low Mono / Stereoize
- [ ] Width by Band section: 4 vertical bars + sliders + labels

### LimiterOpen

- [ ] Targets section: Target LUFS / TP Ceiling sliders + True-Peak toggle
- [ ] Ceiling badge top-right reflects current value + status colour
- [ ] Behaviour section: Lookahead slider + 4 Character cards (2×2)
- [ ] Active character has accent border
- [ ] Gain Reduction section at bottom, animated

### ExportOpen

- [ ] Format chip row: WAV / FLAC / MP3 / AIFF / OGG, single select
- [ ] Sample Rate chip row: 5 rates, "48 kHz" labelled "Default"
- [ ] Bit Depth chip row: 16 / 24 / 32, with hints
- [ ] Dither section with toggle pill (right side) + 3 mode chips
- [ ] Normalize Target section shows echoed LUFS / dBTP badges
- [ ] "Coming soon" notice visible at the bottom

---

## 4. Parameter primitive sanity

In `Product / Controls / Showcase / AllPrimitives`:

- [ ] Three knobs in the showcase row, one fully interactive, one disabled,
      one smaller (48 px)
- [ ] Knob arrow keys work, wheel works, drag works
- [ ] Slider row with hint subtitle renders the hint
- [ ] Toggle pill displays "On" / "Off" and the indicator dot
- [ ] Value badges in all 5 status colours render with appropriate
      backgrounds
- [ ] Mini meter (bar mode) animates over time
- [ ] Mini meter (mirror mode) animates over time, status colour
      switches based on value sign

---

## 5. Visual hierarchy

In any open panel:

- [ ] Section header labels (12-char uppercase) read as the dominant
      structural cue
- [ ] Parameter labels (14 px secondary text) read at second tier
- [ ] Value readouts (mono, 14 px primary) read as the third tier —
      most attention-grabbing per row
- [ ] Hint subtitles (12 px muted text) read as supporting context
- [ ] No row feels cramped or empty

---

## 6. Contrast audit (against `surface.panel = #0f0f12`)

| Element | Foreground | Contrast | Status |
|---|---|---|---|
| Knob centre value (text.primary)          | #fafafa | 17 : 1 | AAA |
| Knob label (text.muted)                   | #71717a | 3.5 : 1 | AA large |
| Slider label (text.secondary)             | #e4e4e7 | 14 : 1 | AAA |
| Slider value (text.primary)               | #fafafa | 17 : 1 | AAA |
| Section header (text.muted)               | #71717a | 3.5 : 1 | AA large |
| Toggle "On" indicator (meter.accent)      | #a78bfa | 7.0 : 1 | AA |
| Live value badge — danger (meter.danger)  | #ef4444 | 4.6 : 1 | AA |
| Live value badge — ok (meter.safe)        | #10b981 | 5.1 : 1 | AA |

All readable.

---

## 7. Responsive variants

In `Product / Module Slide-Over / NarrowLaptop`:

- [ ] Storybook canvas at 1024 × 720
- [ ] Slide-over takes 480 px on the right
- [ ] Demo button row still centred
- [ ] Backdrop covers the remaining 544 px
- [ ] No horizontal overflow on the canvas

---

## 8. Cross-story coherence

Compare EqOpen / DynamicsOpen / ImagerOpen / LimiterOpen / ExportOpen:

- [ ] Slide-over header height, padding, typography identical
- [ ] Section card chrome consistent across all 5 panels
- [ ] Right-side trailing elements (badge / pill) align consistently
- [ ] Panel body scroll bar style consistent (none / minimal)
- [ ] Numbers tabular-numbers everywhere

---

## 9. Open issues / follow-ups

| ID | Issue | Severity |
|---|---|---|
| M3-P4-W-A | Knob ring style ≠ native focus ring on other controls | Trivial |
| M3-P4-W-B | EQ curve preview is schematic, not the real transfer fn | Low |
| M3-P4-W-C | Mock GR / correlation animations don't reset on knob change | Low |
| M3-P4-W-D | No `prefers-reduced-motion` opt-out yet | Trivial |
| M3-P4-W-E | Touch-drag sensitivity not tuned for mobile | Future |
| M3-P4-W-F | Limiter character grid uses `<button>` not `role=radio` | Low |

---

## 10. Sign-off

When all checkboxes above are green, mark "M3-P-NEXT-4 verified" in
the design log.

Next milestone is M3-P-NEXT-5 (real engine bindings) — gated by
M2-full's Rust mastering chain.  Until that lands, this UI shell is
the deliverable.
