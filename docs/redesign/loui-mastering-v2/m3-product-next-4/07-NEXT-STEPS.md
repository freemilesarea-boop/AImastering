# M3-P-NEXT-4 — Next Steps

> What comes after the slide-over + parameter panel shells.

---

## 1. Immediate follow-ups

### M3-P-NEXT-5 — Real engine parameter writes

Replace every `// TODO(M3-P-NEXT-5 binding)` comment with concrete
engine bindings.  Three sub-tasks:

1. **`useEngineParameter` hook** — Zustand-backed parameter store with
   read/write/subscribe semantics.  One hook, one truth source.
2. **Live read subscriptions** — wire `useEngineGr('glueComp', '30Hz')`
   and `useEngineGr('limiter', '30Hz')` for the live GR meters.
3. **Export descriptor wiring** — extend `file:save-wav` IPC to accept
   `{ format, sampleRate, bitDepth, dither }` and route the
   ExportParameterPanel state into it.

Depends on **M2-full** (Rust mastering chain) for the GR streams and
the parameter write path.  Until M2-full, panels can still be hooked
to the Python pipeline's analysis report — read-only mirror until the
write path opens.

### M3-P-NEXT-6 — ProductPage as default

Flip `VITE_LOUI_PRODUCT_LAYOUT` to `true` in default builds once:
- M3-P-NEXT-5 ships
- One full release cycle of opt-in stability
- Design verification (M3-P-NEXT-4 § 6) signs off

ResultPage stays as the flag-off fallback for one more release after.

### M3-P-NEXT-7 — Remove ResultPage

After one full release with ProductPage as default, delete:
- `pages/ResultPage.tsx`
- `App.tsx` flag check
- `audio/product-layout-flag.ts`

The old Tailwind-based card stack becomes git history at that point.

---

## 2. Slide-over polish (within M3-P-NEXT-5 if time permits)

### Unified focus ring

Replace the knob's custom `box-shadow` ring with the same Loui-themed
ring used by all controls.  Standardise on:

```css
:focus-visible {
  outline: 2px solid var(--loui-accent);
  outline-offset: 2px;
}
```

Applied globally to slide-over interactive elements only — the rest of
the app (V1 path, ResultPage) keeps native rings.

### Reduced-motion opt-out

```css
@media (prefers-reduced-motion: reduce) {
  .loui-slideover-panel,
  .loui-slideover-backdrop { transition: none !important; }
}
```

### Curve preview accuracy (EQ)

The EQ preview is currently a schematic polyline.  Once M3-P-NEXT-5
wires `engine.eq.transferFunction`, replace the polyline with the
actual computed response.

### Touch-friendly knob sensitivity

```ts
const sensitivity = window.matchMedia('(pointer: coarse)').matches
  ? 400   // px per range
  : 200;  // px per range (desktop)
```

---

## 3. Storybook follow-ups

### Story-driven E2E (Playwright)

M3-P-NEXT-2's groundwork now applies to a much larger surface:
- 31 `Audio Panels / *` stories
- 9 `Product / *` stories from M3-P-NEXT-3
- 5 `Product / Module Strip` stories
- 14 `Product / Module Slide-Over` stories from this milestone
- 1 `Product / Controls / Showcase` story

The visual regression diff would catch every layout / theme drift.

### Live preset toolbar for the slide-over

A Storybook decorator that adds:
```
[ Open: EQ ▾ ]
```
to the toolbar.  Selecting fires `setSelected(id)` in the story host —
faster iteration than re-rendering via args.

### Per-panel solo stories

Currently the parameter panels are stories of the slide-over.
Adding pure-content stories that render the panels without the
slide-over chrome would be useful for designers iterating on
panel-only details (typography, knob alignment).

---

## 4. Parameter store extraction

Each panel today owns its state via `useState`.  Once two panels need
to share a value (e.g. ExportParameterPanel reading
LimiterParameterPanel's `targetLufs`), this won't scale.

Plan (M3-P-NEXT-5):
1. Introduce `stores/masteringParameters.ts` (Zustand)
2. Each panel selects its slice
3. Cross-panel echoes (Export ← Limiter target) become first-class
4. Parameter writes hit the engine bridge from the store actions, not
   from per-panel callbacks

This refactor preserves the existing panel APIs — they just swap the
backing state from `useState` to `useStore(selectMyPanelSlice)`.

---

## 5. Engine binding (M2-full prerequisites)

Real DSP writes need:

1. **Rust mastering chain** — `loui-mastering-rust` crate exposing EQ,
   Glue Comp, Imager, Limiter as separate stages with a parameter API
2. **Live GR streams** — both compressor stages emit `grDb` at 30 Hz
3. **Atomic parameter snapshot** — `engine.applyParameters({...})`
   accepts the full descriptor in one call (avoids partial writes
   during long DSP frames)
4. **Bidirectional sync** — adaptive engine moves echo back to the UI
   when `adaptive` is on

All of these are M2-full deliverables.  Until they land, the panels
remain UI shells.

---

## 6. Accessibility / a11y pass

Tracked separately as a milestone-spanning task:

| Item | Trigger |
|---|---|
| Unified focus ring                       | M3-P-NEXT-5 |
| `role="radiogroup"` on character cards   | M3-P-NEXT-5 |
| Reduced-motion opt-out                   | M3-P-NEXT-5 |
| `axe-core` audit clean (no contrast / aria errors) | M3-P-NEXT-6 prep |
| High-contrast mode screenshots           | M3-P-NEXT-6 prep |
| Keyboard tour video for testers          | M3-P-NEXT-6 prep |

---

## 7. Documentation hand-off

The seven docs in `docs/redesign/loui-mastering-v2/m3-product-next-4/`
are the design contract for this milestone.  When M3-P-NEXT-5 ships,
update:

- `02-MODULE-PANELS.md` — replace "live mock" with "live engine read"
- `05-FUTURE-DSP-BINDING.md` — strike "future" — move to a sibling
  `bindings.md` in the engine-bridge milestone

The other docs (`01-SLIDEOVER-SPEC.md`, `03-PARAMETER-PRIMITIVES.md`,
`04-INTERACTION-NOTES.md`, `06-DESIGN-VERIFICATION.md`) remain
authoritative beyond the binding work.

---

## 8. The bigger picture

Three milestones of "make Loui Mastering feel like a product" stack
neatly:

| Milestone | Layer | What lands |
|---|---|---|
| M3-P-NEXT-1 | Foundation        | Storybook + mock session + theme v1 tokens |
| M3-P-NEXT-3 | Layout            | Ozone-style ProductPage behind feature flag |
| M3-P-NEXT-4 | Interaction       | Slide-over + parameter panel shells (this milestone) |

Combined, these get the user to **"I can navigate a designed audio
product"**.  M3-P-NEXT-5 unlocks **"I can change the sound"**.
M3-P-NEXT-6 makes it default.  M3-P-NEXT-7 retires the old path.

After M3-P-NEXT-7, the new design surface is the only thing users
see — and the codebase has only one result-page implementation to
maintain.
