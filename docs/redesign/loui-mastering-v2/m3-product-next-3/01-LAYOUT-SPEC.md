# M3-P-NEXT-3 — Layout Specification

> Pixel-level layout rules for the Loui Mastering ProductPage.

---

## 1. Grid

ProductPage is a single column of horizontal rows.  The middle row is a
two-column grid (analyzer canvas + meter rail).

```
┌─────────────────────────────────────────────── 48 px ───┐
│ LouiTopBar                                              │
├─────────────────────────────────────────────── 80 px ───┤
│ LouiPresetHeader                                        │
├──────────────────────────────────────── (optional) 40 px┤
│ Transport strip (play · scrubber · time)                │  ← production path only
├──────────────────────────────────────────── 12 px gap ──┤
│   ┌──────────────────────────┐  ┌────────────────────┐  │
│   │                          │  │                    │  │
│   │  LouiAnalyzerCanvas      │  │ LouiMeterColumn    │  │
│   │  (Spectrum)              │  │ (Loudness + Stereo)│  │
│   │  flex-1                  │  │ width 320 px       │  │
│   │                          │  │                    │  │
│   └──────────────────────────┘  └────────────────────┘  │
├─────────────────────────────────────────── 140-160 px ──┤
│ LouiModuleStrip                                         │
├──────────────────────────────────────────────── 28 px ──┤
│ LouiStatusBar                                           │
└─────────────────────────────────────────────────────────┘
```

CSS:

```css
ProductPage:        display: flex; flex-direction: column; height: 100vh;
TopBar:             height: 48px;  flex-shrink: 0;
PresetHeader:       height: 80px;  flex-shrink: 0; overflow-x: auto;
Transport:          height: 40px;  flex-shrink: 0; (rendered only when onPlayPause set)
MainGrid:           flex: 1;       display: grid;
                    grid-template-columns: minmax(0, 1fr) 320px;
                    gap: var(--space-3); padding: var(--space-3);
ModuleStrip:        flex-shrink: 0; padding-block: var(--space-3);
StatusBar:          height: 28px;  flex-shrink: 0;
```

---

## 2. Sizing rules

| Region | Min width | Behaviour |
|---|---|---|
| TopBar          | 1024 px  | All buttons stay; brand wordmark never wraps |
| Preset Header   | full     | `overflow-x: auto` for chip row; chips never wrap |
| Main grid       | 800 px   | Below 800 px wide the right rail still claims 320 px and the canvas compresses |
| Meter column    | 320 px   | Fixed.  At narrow widths it stays in place; the canvas shrinks |
| Module Strip    | 1024 px  | 5 × 168 px cards + 4 × 12 px gaps = 840 px content + 32 px outer padding |

### Narrow-laptop fallback

At 1024 px wide:
- Module Strip cards hit their `minWidth: 168px` floor → strip is 840 px wide
- The right meter rail (320 px) + spectrum canvas (≥ 480 px) leaves enough room
- Below 1024 px Storybook stories don't shrink further — the layout
  is desktop-class

---

## 3. Component-level rules

### LouiTopBar
- Brand wordmark: `text.primary`, `typography.size.lg`, `weight.semi`
- Engine chip: monospaced, uppercase, tertiary text, `space.2` margin
- Right buttons: 28 px tall, `radius.chip`, hover swaps background to `surface.well`
- Export button: emphasised with accent-tinted background

### LouiPresetHeader
- Section label: 12-char uppercase, 0.16 em letter-spacing, `text.muted`
- Chip: 56 × ≥132 px, two-line label + LUFS / TP readout
- Active chip: 1 px accent border, accent-tinted background, accent tone tag
- Row scrolls horizontally on narrow screens (always visible)

### LouiAnalyzerCanvas
- Header: 14 px title + 12 px subtitle, live pulse on the right
- Pulse: 6 px green dot when active (with glow), grey when idle
- Body: hosts `<SpectrumAnalyzerPanel>` with `space.3` inset padding
- Footer legend: 28 px tall, mono, hairline frequency + dB ranges

### LouiMeterColumn
- Two stacked panel shells with `space.3` gap
- Each shell: 14 px title + 12 px subtitle, panel border, `space.3` inset
- Scrollable when content exceeds visible height

### LouiModuleStrip
- Outer: `space.4` horizontal padding, `space.3` vertical
- Strip header row: 12-char uppercase label + short helper text
- Cards: 5 × flex-1 with `minWidth: 168 px`, 124 px tall
- Card states: active / bypass / locked / coming-soon (see `03-MODULE-STRIP.md`)

### LouiStatusBar
- 28 px tall, single row of label : value pairs
- Mono digits with `tabular-nums`
- Right side: running indicator (green dot when active) + engine label

---

## 4. Spacing rhythm

All inter-region gaps and inner padding pull from `loui-theme.space.*`:

```
space.2  =  8 px  inside-chip gap / meter row gap
space.3  = 12 px  panel inner padding / grid gap / main padding
space.4  = 16 px  panel-to-panel horizontal / top-bar inset
```

No magic numbers are used; the only hard-coded constants in product
components are:
- Card heights (124 px) — determined by content (3 rows of typography +
  visual placeholder)
- Right rail width (320 px) — locks the analyzer canvas's aspect ratio

These are documented exceptions per `04-THEME-APPLICATION.md` §5.

---

## 5. Z-stacking

ProductPage is flat — no overlays, no modals.  The `<UpdateToast>` and
`<Toast>` from App.tsx remain on top via `position: fixed`.  Module Strip
clicks fire `onSelectModule` (state-only); they don't open anything
in this milestone.

---

## 6. Accessibility

- All interactive controls (top-bar buttons, preset chips, module cards,
  transport play/pause) are `<button>` elements — keyboard-reachable.
- The play/pause button has an `aria-label` reflecting its current state.
- The settings icon button has `aria-label="Settings"`.
- Colour contrast (against `surface.background = #09090b`): see
  `05-DESIGN-VERIFICATION.md` §3 for the WCAG audit.

Future a11y work (M3-P-NEXT-5+):
- Add focus rings (`outline: 2px solid ${meter.accent.foreground}`) on
  every interactive element
- Add `aria-current="true"` on the active preset chip
- Add `role="status"` + `aria-live="polite"` on the engine status chip
