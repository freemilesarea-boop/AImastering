# M3-P-NEXT-1 — Panel Stories Matrix

> Which preset exercises which visual state of each panel.

---

## 1. LoudnessMeterPanelV2 — 9 stories

| Story | Preset | Visual state demonstrated |
|---|---|---|
| `Idle`           | `idle`           | All bars at -∞ floor.  Label "starting…" never appears (factory active). |
| `SpotifyLoud`    | `spotify-loud`   | -14 LUFS bars in green band; TP -1 dBTP; correlation ~0.78 |
| `WarmAcoustic`   | `warm-acoustic`  | Quiet content (-18 LUFS-I), wide LRA, low peak/RMS |
| `ClippingRisk`   | `clipping-risk`  | TP near 0 — TP bar near top, danger colour |
| `MonoSafe`       | `mono-safe`      | High correlation, very high M/S ratio |
| `BrokenPhase`    | `broken-phase`   | Negative correlation, M/S negative |
| `AIHarsh`        | `ai-harsh`       | Loud and dense — bars near full |
| `Loading`        | `loading`        | NaN values → panel shows "starting…" + bars at floor |
| `Disconnected`   | n/a (`session={null}`) | Empty state, no subscription |

---

## 2. SpectrumAnalyzerPanel — 6 stories

| Story | Preset | Visual state |
|---|---|---|
| `Idle`         | `idle`         | Grid lines only, no trace |
| `SpotifyLoud`  | `spotify-loud` | Modern pop curve — slight smile, gentle highs |
| `WarmAcoustic` | `warm-acoustic`| Dark-tilted curve, soft highs |
| `AIHarsh`      | `ai-harsh`     | Visible 3-5 kHz peak + sub rumble |
| `Loading`      | `loading`      | NaN bins — magnitude renders at -∞ (effectively no trace) |
| `Disconnected` | n/a            | Grid only |

Each story exercises the canvas-based RAF render loop.  Useful for
checking the peak-hold trace decay rate and the gradient under the
filled magnitude curve.

---

## 3. StereoScopePanel — 7 stories

| Story | Preset | Expected verdict |
|---|---|---|
| `Idle`         | `idle`          | "awaiting frames…" pill |
| `MonoSafe`     | `mono-safe`     | **Mono Safe** (green) |
| `SpotifyLoud`  | `spotify-loud`  | **Stereo Balanced** (zinc) |
| `WarmAcoustic` | `warm-acoustic` | **Mono Safe** (correlation 0.94 > 0.95 threshold near boundary) |
| `AIHarsh`      | `ai-harsh`      | **Wide** (M/S ratio low, correlation < 0.95) |
| `BrokenPhase`  | `broken-phase`  | **Phase Risk** (red — correlation -0.35) |
| `Disconnected` | n/a             | empty state, no verdict |

The verdict chip is the primary check — non-engineer-friendly
classification logic in `StereoScopePanel.classify()`.

---

## 4. AnalyzerPanelStack (V2) — 9 stories

The composite stack — Loudness + Spectrum + Stereo driven by **one**
mock session each.  Mirrors the production `<V2PanelStack>` that
ResultPage mounts when the WASM flag is on.

| Story | Preset | Show spectrum? | Show stereo? |
|---|---|:---:|:---:|
| `SpotifyLoud`        | spotify-loud   | ✓ | ✓ |
| `WarmAcoustic`       | warm-acoustic  | ✓ | ✓ |
| `AIHarsh`            | ai-harsh       | ✓ | ✓ |
| `BrokenPhase`        | broken-phase   | ✓ | ✓ |
| `ClippingRisk`       | clipping-risk  | ✓ | ✓ |
| `MonoSafe`           | mono-safe      | ✓ | ✓ |
| `Idle`               | idle           | ✓ | ✓ |
| `MeterOnly`          | spotify-loud   | ✗ | ✗ |
| `MeterAndSpectrum`   | spotify-loud   | ✓ | ✗ |

The last two stories exercise layout truncation — what does the page
look like when fewer panels are visible?  Catches alignment / spacing
issues that show up only with one or two panels.

---

## 5. Design System / Theme v1 — 2 stories

| Story | Purpose |
|---|---|
| `Tokens`  | Visual board — surface, text, meter colours, spacing, radius |
| `RawJson` | Raw token object as JSON — copy-paste for design hand-off |

---

## 6. Total story count

| Category | Count |
|---|---:|
| LoudnessMeterPanelV2     | 9 |
| SpectrumAnalyzerPanel     | 6 |
| StereoScopePanel          | 7 |
| AnalyzerPanelStack (V2)   | 9 |
| Theme v1                  | 2 |
| **Total**                 | **33 stories** across **5 indexed components** |

---

## 7. Story conventions

- One story per visual state — don't combine multiple states with a
  toggle (the args panel handles that).
- Default args make the most common state visible (typically
  `spotify-loud`).
- Disconnected / empty states are explicit stories (`Disconnected`)
  rather than shown via `session={null}` in an arg switch.
- Loading states use the `loading` preset so the timeline never
  produces real data — distinct from "no session" semantically.
- Story names are PascalCase (matches Storybook conventions); preset
  ids are kebab-case (data layer).
