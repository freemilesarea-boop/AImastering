# M3-P-NEXT-1 — Theme v1

> Loui Mastering's first design token surface — the colour, spacing,
> typography, and motion scales that future panel refactors consume.

---

## 1. Design philosophy

The brief specified four reference points and three guardrails:

**References**: Ozone, Ableton, Teenage Engineering, Apple Pro Apps

**Guardrails**:
- No neon RGB — restrained saturation
- No gaming UI tropes — no scanlines, no shadow-glow, no chromatic aberration
- Approachable to non-engineers — verdict labels in plain English

Tokens land in this v1:
- **Surface**: 5-step near-black ramp (Apple Pro Apps influence)
- **Text**: 5-step neutral text scale
- **Meter colours**: 6 named statuses (safe / warn / hot / danger / cool / accent)
- **Spacing**: 6-step 4-px grid (matches Tailwind 1–6)
- **Radius**: 3-step (bar / chip / panel)
- **Elevation**: tonal only (no shadows — Material's tonal-elevation model)
- **Typography**: sans + mono families, 4 sizes, 3 weights
- **Motion**: 4 named durations, linear for meters, ease-out elsewhere

---

## 2. Surface ramp

| Token | Value | Where it appears |
|---|---|---|
| `surface.background` | `#09090b` | Page / app background |
| `surface.panel`      | `#0f0f12` | Card / panel body |
| `surface.well`       | `#18181b` | Inset wells, secondary surfaces |
| `surface.overlay`    | `#3f3f46` | Hover / focus inset |
| `surface.border`     | `#27272a` | Hairline borders |

Each step rises in luminance only — no hue shift.  Pure tonal elevation,
matches the look of Apple's Pro Apps (Logic, Final Cut).

---

## 3. Text ramp

| Token | Hex | Use |
|---|---|---|
| `text.primary`   | `#fafafa` | Headlines, key numbers |
| `text.secondary` | `#e4e4e7` | Body, panel content |
| `text.tertiary`  | `#a1a1aa` | Sub-labels, captions |
| `text.muted`     | `#71717a` | Time stamps, hints |
| `text.disabled`  | `#52525b` | Inactive controls |

5-step scale gives just enough hierarchy without over-using lower-emphasis text.

---

## 4. Meter colour ramp

The meter ramp is the **most differentiated** part of the theme — these
colours appear on bar fills, verdict chips, and status indicators in
real time during playback.

| Token | Foreground | Background (18-22% alpha) | When |
|---|---|---|---|
| `meter.safe`    | `#10b981` (emerald) | rgba(16,185,129,0.18) | LUFS in target band |
| `meter.warn`    | `#f59e0b` (amber)    | rgba(245,158,11,0.22)  | Hot transients, approaching ceiling |
| `meter.hot`     | `#fb923c` (orange)   | rgba(251,146,60,0.20)   | Over typical streaming targets |
| `meter.danger`  | `#ef4444` (red)      | rgba(239,68,68,0.22)    | TP at ceiling, phase risk |
| `meter.cool`    | `#3b82f6` (blue)     | rgba(59,130,246,0.18)   | Quiet content / acoustic targets |
| `meter.accent`  | `#a78bfa` (violet)   | rgba(167,139,250,0.55)  | Spectrum fill, chart highlights |

**Restraint**: alpha kept ≤ 22% on background variants.  Bars never go
fully saturated against the panel surface.

**Red is reserved** for safety violations only — true-peak overshoot,
phase risk, hard clipping.  This makes red genuinely meaningful in the
UI.

---

## 5. Spacing scale

```
1 →  4 px   chip / pill padding
2 →  8 px   meter row gap
3 → 12 px   panel inner padding (default)
4 → 16 px   panel-to-panel gap
5 → 20 px   page section
6 → 24 px   page-level margin
```

Six steps, all multiples of 4 px.  Avoids the typical Tailwind 1-px
fractional values that don't align on a real grid.

---

## 6. Radius scale

| Token | Value | Use |
|---|---|---|
| `radius.bar`   | 2 px | meter bars, status pills |
| `radius.chip`  | 6 px | verdict chips, button rounding |
| `radius.panel` | 12 px | card / panel container |

Three tiers — no more.  Avoids the design-system pitfall of "every size needs its own radius".

---

## 7. Elevation (tonal, no shadows)

```ts
elevation = {
  0: surface.background,   // page
  1: surface.panel,         // card / panel
  2: surface.well,          // inset
  3: surface.overlay,       // hover / focus
};
```

Material 3-style tonal elevation: brighter surface = higher elevation.
No drop shadows anywhere in the app — they look gimmicky in a
near-black UI.

---

## 8. Typography

Families:
- Sans: `ui-sans-serif, system-ui, ...` — matches OS body text
- Mono: `ui-monospace, SFMono-Regular, Menlo, ...` — for any live number

The mono family is critical for meter readouts: tabular-nums variants
keep digit positions stable as values change.

Sizes:
- `xs` 10 px → meter row labels
- `sm` 12 px → panel body (default)
- `md` 14 px → panel headers
- `lg` 16 px → top bar title

Weights: `normal` 400, `medium` 500, `semi` 600.  No light weights at
small sizes (would be unreadable on dark surfaces).

---

## 9. Motion

| Token | Duration / curve | Use |
|---|---|---|
| `meterFollow`    | `100ms linear`   | meter bar width animations |
| `chipSwap`       | `150ms ease-out` | verdict chip text swap |
| `pageTransition` | `200ms ease-out` | page / modal transitions |
| `spectrumRender` | `0ms`            | spectrum is DSP-smoothed; CSS adds nothing |

The biggest design choice here: **meter bars use linear curves**.
Eased curves feel laggy because the user expects bars to snap with the
audio.  Easing is reserved for UI transitions that don't represent
realtime data.

---

## 10. Migration path

The theme module is **additive only** — V2 panels currently use Tailwind
utilities directly, and that continues to work.

Future migration (M3-P-NEXT-3 or later):
1. Add a Tailwind plugin that maps `bg-loui-panel` → `surface.panel`, etc.
2. Component-by-component, refactor inline class names to use token-backed utilities.
3. Token changes propagate to all panels automatically.

For now, the theme exists as the **single source of truth** that future
refactors will pull from, and as the documentation surface for visual
design hand-off.

---

## 11. Compared to the references

| Aspect | Loui Theme v1 | Ozone | Ableton | TE | Apple Pro |
|---|---|---|---|---|---|
| Surface | Near-black, 5 steps | Dark grey, 4 steps | Dark grey, 5 steps | Off-white + colour blocks | Near-black, 6+ steps |
| Accent | Violet (meter.accent) | Blue / yellow | Cyan / yellow | Strong blue / orange | System accent |
| Red usage | Safety only | Safety + alerts | Sparingly | Limited | Sparingly |
| Animation | Linear for meters | Eased everywhere | Linear-ish | Minimal | Eased |
| Shadows | None | None | Subtle | None | None |
| Sat. policy | Muted | Moderate | Moderate | Bright primaries | Muted |

Closest aesthetic cousin: **Apple Pro Apps**.  Closest functional cousin:
**Ozone** (meter-first information density).
