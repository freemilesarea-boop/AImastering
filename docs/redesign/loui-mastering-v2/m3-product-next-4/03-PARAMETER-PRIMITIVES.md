# M3-P-NEXT-4 — Parameter Control Primitives

> Six reusable primitives that compose every parameter panel.

---

## 1. Primitive matrix

| Primitive | File | Visual | Best for |
|---|---|---|---|
| LouiKnob        | `controls/LouiKnob.tsx`        | 64 × 64 circular dial | Continuous values where the visual mapping to angle matters (Threshold, Ratio, Attack, Release, Output Gain) |
| LouiSliderRow   | `controls/LouiSliderRow.tsx`   | Label · track · value | Linear continuous values where you want a wide visual range (Lookahead, Width, Lukewarm slider-y things) |
| LouiTogglePill  | `controls/LouiTogglePill.tsx`  | Label · pill          | Binary on/off (Adaptive, ISP, Stereoize, Dither) |
| LouiValueBadge  | `controls/LouiValueBadge.tsx`  | Mono chip             | Read-only value chips (target echoes, status, mode labels) |
| LouiMiniMeter   | `controls/LouiMiniMeter.tsx`   | Bar / mirror          | Live signal indicators (GR meter, correlation, limiter activity) |
| LouiSectionCard | `controls/LouiSectionCard.tsx` | Group container       | Wrapping every group of related controls inside a panel |

---

## 2. LouiKnob — API

```ts
interface LouiKnobProps {
  value:    number;
  min:      number;
  max:      number;
  step?:    number;                         // default: (max-min)/100
  label?:   string;                         // drawn under the knob
  unit?:    string;                         // drawn after the value
  format?:  (v: number) => string;          // default: v.toFixed(1)
  size?:    number;                         // default 64 px
  disabled?: boolean;
  onChange?: (v: number) => void;
}
```

### Interaction surface

| Input | Effect |
|---|---|
| Pointer drag (vertical)        | `dy → value change` (200 px = full range) |
| ArrowUp / ArrowRight           | `value + step` |
| ArrowDown / ArrowLeft          | `value - step` |
| PageUp                         | `value + step × 10` |
| PageDown                       | `value - step × 10` |
| Home                           | `min` |
| End                            | `max` |
| Wheel up                       | `value + step` (with `preventDefault`) |
| Wheel down                     | `value - step` |
| Focus                          | 2 px accent box-shadow ring |

### Accessibility

```html
<button
  role="slider"
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  aria-orientation="vertical"
  aria-disabled={disabled}
/>
```

Screen readers narrate "Threshold slider, vertical, -14, range -30 to 0".

### Visual breakdown

```
       ╭─ track (full sweep, dimmed)
       │       ╭─ fill (accent)
       ▼       ▼
     ╲╲╲╲╲ ╱╱╱╱╱
    ╲╲     ▌    ╱╱  ← indicator line
    ╲      ●      ╱  ← centre dot
     ╲   value   ╱
      ╲ readout ╱
       ╲─label─╱
```

The arc spans 270° (from -135° to +135°, with the "open" 90° gap at
6 o'clock).  Accent arc fills from start to the current angle.

---

## 3. LouiSliderRow — API

```ts
interface LouiSliderRowProps {
  label:     string;
  value:     number;
  min:       number;
  max:       number;
  step?:     number;
  unit?:     string;
  format?:   (v: number) => string;
  disabled?: boolean;
  hint?:     string;
  onChange?: (v: number) => void;
}
```

### Composition

```
┌─ 120 px ─┬───────────── flex ─────────────┬─ 64 px ─┐
│ Label    │  ────●────                     │ +1.2 dB │
│ hint     │  fill = accent                 │         │
└──────────┴────────────────────────────────┴─────────┘
```

Uses a native `<input type="range">` overlaid invisibly on the visual
track — this gives keyboard navigation, drag-to-set, and screen-reader
support for free.

---

## 4. LouiTogglePill — API

```ts
interface LouiTogglePillProps {
  label:     string;
  value:     boolean;
  hint?:     string;
  offLabel?: string;     // default 'Off'
  onLabel?:  string;     // default 'On'
  disabled?: boolean;
  onChange?: (v: boolean) => void;
}
```

Renders as a label/hint column + a pill button:

```
Adaptive          [ ● On ]    ← when on: accent border + tinted bg
Auto-tune EQ
```

Uses `role="switch"` with `aria-checked`.  Keyboard: Space/Enter
toggles via the native button.

---

## 5. LouiValueBadge — API

```ts
interface LouiValueBadgeProps {
  children: ReactNode;
  status?:  'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
  label?:   string;                  // small uppercase prefix
}
```

| Status | Foreground | Background | Border |
|---|---|---|---|
| `neutral`  | `text.tertiary`       | `surface.well`         | `surface.border` |
| `ok`       | `meter.safe.fg`       | `meter.safe.bg`        | rgba(16,185,129,0.45) |
| `warn`     | `meter.warn.fg`       | `meter.warn.bg`        | rgba(245,158,11,0.45) |
| `danger`   | `meter.danger.fg`     | `meter.danger.bg`      | rgba(239,68,68,0.45) |
| `accent`   | `meter.accent.fg`     | rgba(167,139,250,0.16) | rgba(167,139,250,0.45) |

Compact (22 px tall) — designed to live inline next to or above
controls.  Mono font, tabular nums.

---

## 6. LouiMiniMeter — API

```ts
interface LouiMiniMeterProps {
  value:    number;                            // 0..1 (bar) or -1..+1 (mirror)
  label?:   string;
  readout?: string;
  mode?:    'bar' | 'mirror';                  // default 'bar'
  height?:  number;                            // default 8 px
  status?:  'accent' | 'ok' | 'warn' | 'danger';
}
```

### Modes

- **bar**: fill grows from left to right
  ```
  ████████░░░░░░░░░░░
  ```
- **mirror**: signed value, fill grows outward from centre (used for
  stereo correlation, balance indicators)
  ```
  ░░░░░░██████░░░░░░░░
            ↑ centre
  ```

Fill colour driven by `status`.  100 ms linear width transition keeps
the meter snappy.

---

## 7. LouiSectionCard — API

```ts
interface LouiSectionCardProps {
  title:    string;
  trailing?: ReactNode;     // right-side header element
  children: ReactNode;
  dimmed?:  boolean;        // 0.7 opacity for bypassed sections
}
```

### Composition

```
┌─── HEADER (28 px, surface.well bg) ──────────────┐
│ TITLE                                  [trailing]│
├──────────────────────────────────────────────────┤
│ space.4 padding                                  │
│ space.3 gap between direct children              │
│                                                  │
└──────────────────────────────────────────────────┘
```

Used as the only level-1 grouping inside parameter panels.  All
sections share the same outer chrome so panels feel uniform.

---

## 8. Visual coherence rules

Every primitive consumes only:
- `surface.{background, panel, well, border, overlay}` — chrome
- `text.{primary, secondary, tertiary, muted, disabled}` — typography
- `meter.{safe, warn, hot, danger, cool, accent}` — status
- `space.{1..6}` — spacing
- `radius.{bar, chip, panel}` — roundness
- `typography.{family, size, weight}` — type ramp

No magic colours.  No `#xxxxxx` hex codes outside the theme module.
Exceptions are documented in the file headers (e.g. semitransparent
accent variants like `rgba(167,139,250,0.10)` for tinted hover states).
