# M2-PRESET-NEXT-1 (follow-up) — Preset Browser Entry Points

> The browser was implemented + wired but only reachable on ProductPage's
> header (post-master).  This follow-up exposes it on both screens with
> role separation, per user direction.

---

## 1. Role separation

| Screen | Role | Entry | Apply path |
|---|---|---|---|
| **HomePage** (pre-master setup) | quick **style selection** before mastering | "전체 프리셋 둘러보기" button next to 빠른 프리셋 | `louiPresetToMasteringOptions` → `updateOptions` (style / LUFS / TP / width / limiter strength) |
| **ProductPage** (post-master result) | result-based **compare / detailed tuning** | "Browse Presets" button in the preset header (already wired) | `applyPreset` → parameter state + realtime config push (no graph rebuild) |

Both open the same `LouiPresetSlideOver`.  The HomePage path maps the
preset to the legacy options model (the same renderable subset the export
honours — no preview/export drift); the ProductPage path drives the full
parameter state.

---

## 2. Why HomePage uses a different apply path

HomePage masters via `audioStore.options` (MasteringStyle / targetLufs /
…), not the ProductPage parameter-state provider.  So selecting a Loui
preset there maps into those options via
`audio/presets/preset-to-options.ts` (`louiPresetToMasteringOptions`):

- `style` ← best-fit MasteringStyle per preset id
- `targetLufs` ← limiter.targetLufs
- `targetTp` ← limiter.ceilingDbtp
- `stereoWidth` ← imager.widthPct / 100 (engine space)
- `limiterStrength` ← derived from loudness + limiter character

Selecting does NOT trigger a master — the user still presses Master.

---

## 3. UX polish (both screens)

- Active preset card now has a subtle accent **glow** (unmistakable).
- **AI Special** category label is accented + tagged "fixes AI-music
  artefacts".
- "Last used" badge is now a filled, higher-contrast chip.
- HomePage entry is a secondary (outlined, muted) button — visually
  weaker than the primary quick-preset chips, dark-theme consistent.

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + preset selftests | no regression (22/22 · 14/14 · 11/11) |
| ProductPage header Browse button | renders (wired via `onBrowsePresets`) |
| ESC / backdrop / X / focus-trap | inherited from `LouiModuleSlideOver` |

---

## 5. Constraints honoured

- No ProductPage layout overhaul (button added to existing header; a
  secondary button added to HomePage's existing preset block).
- No DSP / preset-tuning / export-pipeline changes.
- Realtime flag default unchanged (OFF).
- No auto re-render / auto master on preset select.
- ResultPage/V1 fallback intact.
