# M3-P-NEXT-4 — Interaction & Accessibility Notes

> How users move through ProductPage + slide-over with mouse, keyboard,
> and assistive technology.

---

## 1. Slide-over open / close sequences

### Sequence: open via mouse

```
1. User clicks "EQ" card in LouiModuleStrip
2. ProductPage.onSelectModule('eq') → setSelectedModule('eq')
3. LouiModuleStrip card border flips to accent (visual feedback)
4. LouiModuleSlideOver receives `open=true`
   • Backdrop fades 0 → 1 (200 ms)
   • Panel slides translateX(480px) → 0 (280 ms)
5. After ~50 ms timer, useEffect focuses the panel's second focusable
   element (skips the × button to land on first parameter)
6. User starts interacting
```

### Sequence: close via ESC

```
1. User presses ESC while a focusable element inside the panel has focus
2. document-level keydown listener (capture phase) fires
3. props.onClose() → ProductPage.setSelectedModule(undefined) via toggle
4. LouiModuleSlideOver receives `open=false`
   • Backdrop fades 1 → 0 (200 ms)
   • Panel slides 0 → translateX(480px) (280 ms)
5. useEffect on close: lastFocusRef.current.focus() restores focus to
   the original trigger (the EQ card in LouiModuleStrip)
```

### Sequence: close via backdrop

Identical to ESC except the trigger is `onClick` on the backdrop div.

### Sequence: close via re-click

```
1. User clicks "EQ" card again (was active)
2. onSelectModule('eq') → setSelectedModule(prev => prev === 'eq' ? undefined : 'eq')
3. Selected becomes undefined → SlideOver receives open=false
4. Same close animation + focus restore
```

---

## 2. Keyboard map

### Inside the slide-over

| Key | Effect |
|---|---|
| **ESC**         | Close the slide-over |
| **Tab**         | Move focus to next focusable inside the panel (wraps) |
| **Shift+Tab**   | Move focus to previous focusable (wraps) |
| **Space / Enter** | Activate the focused button / chip / pill |

### Inside a `LouiKnob`

| Key | Effect |
|---|---|
| **↑ / →**       | `value + step` |
| **↓ / ←**       | `value - step` |
| **PageUp**      | `value + step × 10` |
| **PageDown**    | `value - step × 10` |
| **Home**        | `min` |
| **End**         | `max` |
| **Tab**         | Move focus to next element |

### Inside a `LouiSliderRow`

Uses the native `<input type="range">` so keyboard behaviour matches
the browser default:

| Key | Effect |
|---|---|
| ↑ / →           | `value + step` |
| ↓ / ←           | `value - step` |
| PageUp          | `value + step × 10` |
| PageDown        | `value - step × 10` |
| Home            | `min` |
| End             | `max` |

---

## 3. Pointer interactions

### Module Strip cards

- Click anywhere on the card → opens the panel (toggle if same)
- Hover → background swaps from `surface.panel` → `surface.well`
- Selected → 1 px accent border

### Slide-over header

- ✕ button click → close
- Hover on ✕ → background swap + colour shift

### Slide-over backdrop

- Click anywhere → close
- `pointerEvents` toggles to `'none'` when closed so the backdrop
  doesn't intercept clicks meant for the underlying ProductPage

### Knobs

- Pointer-down inside knob → captures pointer, begins drag
- Pointer-move → vertical delta scales to value (200 px = full range)
- Pointer-up → releases capture
- Cursor changes to `ns-resize` to advertise vertical drag affordance

### Sliders / chips / pills

Native input + button behaviour — no custom drag logic needed.

---

## 4. ARIA semantics summary

| Element | Role / attributes |
|---|---|
| Slide-over root            | `role="dialog"`, `aria-modal="true"`, `aria-label={title}`, `aria-hidden={!open}` |
| Slide-over close button    | `aria-label="Close"` |
| LouiKnob                   | `role="slider"`, `aria-valuemin / max / now`, `aria-orientation="vertical"`, `aria-disabled` |
| LouiSliderRow              | `<input type="range" aria-label={label}>` |
| LouiTogglePill             | `role="switch"`, `aria-checked`, `aria-disabled` |
| Limiter character cards    | native `<button>` (one-of-N selection group; future: `role="radio"` + `role="radiogroup"`) |
| Export format chip row     | `role="radiogroup"`, each chip `role="radio"` + `aria-checked` |

---

## 5. Focus visualisation

When a control receives keyboard focus:

- **LouiKnob**: 2 px box-shadow ring in `meter.accent.foreground`
- **LouiSliderRow**: native browser focus ring on the underlying `<input>`
- **LouiTogglePill**: native browser focus ring on the `<button>`
- **Module card / chip / character button**: native browser focus ring

The decision to keep native focus rings everywhere except the knob is
deliberate — native rings are robust against browser zoom and
high-contrast modes.  The knob needs an explicit ring because the
focusable element (a `<button>`) is sized like a 64 × 64 square,
making the browser default ring visually disconnected from the
circular dial.

Future polish (M3-P-NEXT-5+): replace browser-default rings with a
unified Loui-themed ring style across all controls.  Out of scope here.

---

## 6. Screen reader narration examples

### Opening the EQ panel via VoiceOver

```
"EQ button"                     ← click
"EQ dialog"                     ← slide-over opens, focus moves
"Low Cut slider, vertical, 32, range 20 to 120"
                                ← (first parameter focus)
```

### Adjusting a knob

```
↑ key
"Threshold slider, vertical, -13.5, range -30 to 0"
                                ← live narration on every step
```

### Toggling Adaptive

```
Space key
"Adaptive switch, on"
```

---

## 7. Touch behaviour

The slide-over works on touch devices but the parameter primitives are
optimised for pointer input:

- **Knobs**: pointer drag works with touch but the 200 px / full-range
  ratio is too tight on small screens.  Future M3-P-NEXT-5 tweak:
  reduce sensitivity on coarse-pointer media query.
- **Sliders**: native `<input type="range">` provides good touch UX
  out of the box.
- **Backdrop tap**: closes the panel.
- **Pinch-zoom**: not blocked.

---

## 8. Reduced motion

The slide-over animation is a single `transition: transform 280ms ease-out`.
Browsers honouring `prefers-reduced-motion` will still execute this
transition unless we add a media-query opt-out — added in
M3-P-NEXT-5+ as a polish step:

```css
@media (prefers-reduced-motion: reduce) {
  .loui-slideover { transition: none; }
}
```

---

## 9. Known gaps / non-goals

| Item | Status |
|---|---|
| Focus ring unification (knob ring style vs native browser) | Future |
| Reduced-motion opt-out | Future |
| Touch sensitivity tuning for knob drag | Future |
| High-contrast mode survey | Future |
| RTL layout (Arabic / Hebrew) | Not planned for V2 GA |
| Mobile-aware width below 480 px | `min()` based scaling — adequate but not optimised |
| Initial focus customisation per panel | Generic "second focusable" rule covers all 5 panels today |

These are documented for completeness — none block this milestone.
