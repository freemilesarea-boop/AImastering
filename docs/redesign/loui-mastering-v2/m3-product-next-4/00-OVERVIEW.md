# M3-P-NEXT-4 — Module Slide-Over + Parameter Panel Shells

> Make the Module Strip cards open into real-feeling parameter editors —
> with the explicit constraint that no DSP value gets written this round.

---

## 1. What changed

M3-P-NEXT-3 shipped the Module Strip as a five-card visual rack with a
`onSelect(id)` callback that did nothing user-visible beyond
highlighting the clicked card.  M3-P-NEXT-4 wires that callback to a
right-anchored **slide-over** that hosts one of five module parameter
panel shells.

```
[ Module Strip ]                       Click "EQ"
                                       ────────────▶
┌────────────────────────────────────┐  ┌────────────────────────────┐
│  EQ │ Dyn │ Img │ Lim │ Exp        │  │  EQ            ✕           │
│         (active card highlighted)  │  │  Adaptive 7-band            │
└────────────────────────────────────┘  │  ──────────────             │
                                        │  [curve preview]            │
                                        │  Low Cut    32 Hz           │
                                        │  Low Shelf  +1.2 dB         │
                                        │  ...                        │
                                        └────────────────────────────┘
```

| New | Purpose |
|---|---|
| 6 parameter control primitives (`controls/`)            | Knob · Slider · Toggle · Badge · MiniMeter · SectionCard |
| 1 slide-over chrome (`LouiModuleSlideOver`)             | Right-anchored overlay with backdrop / ESC / focus-trap |
| 5 module parameter panel shells (`panels/`)             | EQ · Dynamics · Imager · Limiter · Export |
| ProductPage integration                                  | Click card → open; re-click → close; ESC / backdrop / × → close |
| 14 Storybook stories                                    | Closed / 5 open variants / narrow viewport / warning / disabled / primitives showcase |

---

## 2. What did NOT change

Same zero-regression contract as prior milestones:

| Untouched | Verification |
|---|---|
| DSP chain (`loui-dsp` Rust core) | `cargo test -p loui-dsp --lib` → 31/31 |
| EQ / compressor / limiter Rust code | None modified |
| Mastering pipeline (Python) | None modified |
| Export pipeline (`file:save-wav` IPC) | None modified |
| ResultPage (legacy) | Untouched |
| V2 analyzer panels                | Untouched (panels are reused inside the layout, no internal changes) |
| WASM analyzer flag                | Independent / orthogonal |
| Product-layout flag               | Same gate: ProductPage only mounts when flag is on |
| Engine API / preset system        | None modified |

Important constraint reiterated from the brief:
> 실제 DSP parameter write 는 아직 하지 않는다.

Every onChange handler in every panel updates **only local component
state**.  Every binding point is marked with a
`// TODO(M3-P-NEXT-5 binding): …` comment naming the engine parameter
that will eventually receive the write.

---

## 3. Files added

| Path | Lines | Purpose |
|---|---:|---|
| `components/product/controls/LouiKnob.tsx`         | ~190 | Circular knob with drag / keyboard / wheel |
| `components/product/controls/LouiSliderRow.tsx`    | ~120 | Labelled horizontal slider |
| `components/product/controls/LouiTogglePill.tsx`   |  ~95 | Binary switch pill |
| `components/product/controls/LouiValueBadge.tsx`   |  ~60 | Numeric chip with status colour |
| `components/product/controls/LouiMiniMeter.tsx`    | ~100 | Horizontal level bar |
| `components/product/controls/LouiSectionCard.tsx`  |  ~50 | Group wrapper for panel sections |
| `components/product/controls/index.ts`             |  ~20 | Barrel |
| `components/product/controls/LouiControls.stories.tsx` | ~120 | All-primitives showcase |
| `components/product/LouiModuleSlideOver.tsx`       | ~200 | Slide-over overlay with focus management |
| `components/product/LouiModuleSlideOver.stories.tsx` | ~190 | 8 stories |
| `components/product/panels/EqParameterPanel.tsx`        | ~200 | EQ — Low Cut · Low Shelf · Presence · Air · Output |
| `components/product/panels/DynamicsParameterPanel.tsx`  | ~140 | Compressor — Threshold · Ratio · Attack · Release · Mix |
| `components/product/panels/ImagerParameterPanel.tsx`    | ~210 | Width · Low Mono · Stereoize · Width-by-band |
| `components/product/panels/LimiterParameterPanel.tsx`   | ~200 | Target LUFS · Ceiling · Lookahead · Character · ISP |
| `components/product/panels/ExportParameterPanel.tsx`    | ~270 | Format · SR · Bit depth · Dither · Normalize echo |
| `components/product/panels/index.ts`                    |  ~12 | Barrel |
| `pages/ProductPage.tsx`                                 | +56  | Slide-over integration + toggle behaviour |
| `components/product/index.ts`                           | +12  | New exports |
| `docs/redesign/loui-mastering-v2/m3-product-next-4/*`   | 7 files | Design surface |

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm --filter @aimaster/desktop typecheck`     | clean |
| `pnpm --filter @aimaster/desktop build:renderer` | succeeds — 401 KB JS / 99 KB WASM (V1 + product layout) |
| `pnpm --filter @aimaster/desktop build-storybook` | **9 components / 57 stories** indexed |
| `cargo test -p loui-dsp --lib`                   | **31/31** |
| Flag OFF — ResultPage renders                    | manual: no flag → ResultPage path |
| Flag ON — ProductPage renders, modules clickable | manual: `__LOUI_PRODUCT_LAYOUT__ = true` |
| Slide-over open / close                          | ESC ✓ · backdrop click ✓ · close × ✓ · re-click card ✓ |
| Focus management                                 | Auto-focus first interactive on open · restore on close · trap inside |

---

## 5. Storybook coverage

Run `pnpm --filter @aimaster/desktop storybook` and visit:

- **Product / Module Slide-Over** — 8 stories: Closed, EqOpen, DynamicsOpen,
  ImagerOpen, LimiterOpen, ExportOpen, NarrowLaptop, PhaseWarning,
  ExportComingSoon
- **Product / Controls / Showcase** — `AllPrimitives` interactive showcase

Note: the existing **Product / ProductPage** stories continue to render
the strip without auto-opening a slide-over.  To exercise the
integration, click a card in any of those stories — the panel opens
in-context.

---

## 6. Design rules upheld

The new components extend the M3-P-NEXT-3 theme application:

- **Zero Tailwind** in product components — all styling via inline `style`
  prop + `loui-theme` tokens
- **No new colour additions** — every colour drawn from `meter.*` / `text.*` / `surface.*`
- **Tabular numbers everywhere** — `font-variant-numeric: tabular-nums` on
  every live value readout
- **Motion**: 100–280 ms ease-out for chrome, 100 ms linear for value
  follow (meter fills)

---

## 7. Open issues / next steps

`07-NEXT-STEPS.md` lists follow-ups in detail; the highlights:

1. **M3-P-NEXT-5** — Real engine parameter writes (replaces every TODO
   binding comment with concrete code).  Depends on M2-full landing.
2. **M3-P-NEXT-6** — ProductPage default promotion (flag ON by default).
3. **Slide-over polish** — focus visualisation when keyboard-navigating
   to a knob, smoother SVG curve in the EQ preview, mobile-aware width.

All of these are decoupled from this milestone — the shells are stable
enough to ship.
