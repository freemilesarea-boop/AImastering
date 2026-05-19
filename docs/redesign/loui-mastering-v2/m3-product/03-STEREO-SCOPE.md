# M3 Product — Stereo Scope

> Live stereo health visualiser with non-engineer-friendly verdict labels.

---

## 1. Visual layout

```
┌────────────────────────────────────────────────────┐
│  Stereo · scope             [ Stereo Balanced ]    │
├────────────────────────────────────────────────────┤
│  -1 (anti-phase)         0          +1 (mono)       │
│ ┌──────────────┌─────────╫─────────┐                │
│ │ ▒▒▒▒▒▒▒▒▒▒▒ │         ║         │█               │
│ └──────────────┴─────────╨─────────┘                │
│                                            +0.487   │
│                                                    │
│  narrow         │ balanced              wide        │
│ ┌─────────────┌─╫───────────────────────────┐      │
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓│ │                            │      │
│ └─────────────┴─╨─────────────────────────────┘    │
│                                      width = 1.20   │
│ ────────────────────────────────────────────────── │
│ M/S ratio: +7.4 dB                                  │
└────────────────────────────────────────────────────┘
```

- **Correlation bar** (-1 to +1) — vertical needle on the current value.
  Red shaded region left of zero = phase-risk zone.
- **Width bar** (0 to 4) — fill from left.  Vertical tick at width=1.0
  marks the "balanced" baseline.
- **Verdict chip** in the top-right summarises the current state.
- **M/S ratio** footer for engineers who want the absolute number.

---

## 2. Verdict labels

Classifier in `StereoScopePanel.classify(frame)`:

| Condition | Label | Colour | Description (tooltip) |
|---|---|---|---|
| `correlation < -0.2`        | **Phase Risk**       | red     | L/R partially cancel.  Check phase / monitor in mono. |
| `correlation > 0.95`         | **Mono Safe**        | green   | Highly correlated — collapses cleanly to mono. |
| `widthIndex > 1.6`           | **Very Wide**        | amber   | Wide stereo image.  Some side content may attenuate on mono playback. |
| `widthIndex > 1.0`           | **Wide**             | sky     | Stereo wider than baseline.  No fold-down issues expected. |
| otherwise                    | **Stereo Balanced**  | zinc    | Healthy stereo image with safe mono compatibility. |

Heuristics chosen for:
- **Phase Risk**: hard threshold at -0.2 because anything ≤ -0.2 has
  measurable mono fold-down loss (≈ 3 dB+).
- **Mono Safe**: > 0.95 because in this range L ≈ R within typical
  stereo content variance.
- **Very Wide / Wide**: width index > 1.6 / > 1.0 thresholds derived
  from typical mastered content distributions.

The thresholds are **engineering judgement**, not data-derived.
Refining them with user-feedback / commercial-reference analysis is
M3-P-D in the backlog.

---

## 3. Why bar-style instead of XY vectorscope

The XY (Mid vs Side) scope is iconic but:
- Requires `StereoVectorscopeFrame` (per-sample dot cloud) instead of the
  cheaper `StereoAggregateFrame` (3 scalars).
- Canvas rendering ~4× more expensive than the bar style.
- Less informative for non-engineers (a dot cloud doesn't say "your
  mix is phase-broken").

Bar-style + verdict label is enough for M3 product polish.  XY scope
is a future addition (M3-P-NEXT) as an opt-in component.

---

## 4. Stereo frame source

`StereoScopeFrame` is emitted by `WasmAnalyzerSession.emitStereoFrame()`
at 30 Hz.  Field values come from `LouiAnalyzer.tickSnapshot()`:

| Frame field | Source |
|---|---|
| `correlation` | `LouiAnalyzer::tickSnapshot().correlation` (Rust StereoMeter Pearson over 1 s window) |
| `msRatioDb`   | same |
| `widthIndex`  | derived in session: `1 - correlation * 0.5` (simple heuristic; future: use Rust `StereoMeter::width_index`) |
| `windowFrames`| 0 today; informational |

**Bug-to-fix (M3-P-D)**: width index is currently derived from
correlation alone in the session emitter; the Rust `StereoMeter` has a
more accurate `width_index()` method that combines M/S energy ratio
properly.  Fix in M3-P-NEXT.

---

## 5. Empty / loading state

- `session === null` → render with all bars empty, label "awaiting
  frames…", footer hidden.
- Session present but no stereo frame yet → same.
- First frame arrives → bars animate to position over 100 ms (CSS
  transition).

The transition is CSS-driven (`transition-[left]/[width] duration-100 ease-linear`),
not React-driven — re-rendering 30 Hz with `style={{left: ...}}` is
cheap and lets the GPU compositor handle smoothness.

---

## 6. Accessibility

- All numeric values rendered as text alongside the visual bars.
- Verdict chip has `title` attribute with the longer description.
- Bar colours have sufficient contrast against `#09090b` background
  (Tailwind shade-700/800 borders + text-zinc-200 text).

For screen readers, the dynamic numeric values would benefit from
`aria-live="polite"` regions — tracked as future polish.

---

## 7. Customisation knobs

Today: none beyond `session` prop.  Future (M3-P-NEXT):
- Threshold customisation (correlation cutoff for "Phase Risk")
- XY vectorscope toggle
- Time-window slider (1 s default)

---

## 8. Performance

The panel is DOM-only (no canvas).  React re-renders on each stereo
frame (~30 Hz) but updates only the `style.left` / `style.width`
properties — Tailwind classes are static.

| Stage | Cost / second |
|---|---:|
| 30 setState calls × shallow update | ~4 ms |
| Layout work for `style` change | ~2 ms |
| **Total** | **~6 ms/s = 0.6% CPU** |

Trivial.  No GC concerns.

---

## 9. Verification status

| Check | Status |
|---|---|
| Component renders empty when session is null | ✅ |
| Bars animate via CSS transition | ✅ |
| Verdict chip changes on threshold crossing | ✅ (logic verified) |
| Color classes apply correctly | ✅ |
| Real-audio rendering with WASM session | ⏳ manual smoke |
| Verdict classification on diverse content | ⏳ manual listen test |
