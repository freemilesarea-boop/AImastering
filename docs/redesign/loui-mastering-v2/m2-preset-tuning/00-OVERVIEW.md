# M2-PRESET-TUNING — Loui Preset Tuning Framework + AI Music Character

> Turn presets from cosmetic chips into a real **product preset
> framework**: rich metadata + hand-tuned, AI-music-optimized DSP per
> preset, applied to the live chain without a graph rebuild.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Preset system audit | `PRESET_SYSTEM_AUDIT.md` | ✓ |
| 2 | Preset metadata framework | `audio/presets/loui-presets.ts` (`LouiPreset`) | ✓ |
| 3 | Official lineup (Core/Character/AI-special, 13) | `loui-presets.ts` `LOUI_PRESETS` | ✓ |
| 4 | AI-special tuning | ai-vocal-cleaner / cymbal-smooth / stereo-repair / mono-safe-shorts | ✓ |
| 5 | Compare harness + apply path | `preset-compare.ts`, `applyPreset`, `preset-tuning-selftest.ts` | ✓ |
| 6 | Preset browser polish | `LouiPresetBrowser` + stories; header badges + lineup feed | ✓ |
| 7 | QA / listening workflow | `PRESET_QA_MATRIX.md`, `LISTENING_NOTES_TEMPLATE.md` | ✓ |
| 8 | Benchmark listening notes | `PRESET_BENCHMARK_NOTES.md` | ✓ |
| 9 | Rollout recommendation | `ROLLOUT_RECOMMENDATION.md` | ✓ |

---

## 2. How it works

```
select preset → applyPreset(plan)         (validated + clamped, one state update)
   ├─ realtime flag ON  → new config to the SAME worklet node (no graph rebuild)
   └─ realtime flag OFF → renderable params staged for re-render / export
```

A `LouiPreset` carries product metadata (category, intendedPlatform,
loudnessProfile, tonalBalance, aiOptimized, monoSafe, recommendedGenres,
accent, version) **plus** a real per-module DSP tuning.  Preview and
export read the same state → no parameter drift.

---

## 3. The lineup (v1.0.0)

- **Core:** AI Pop · KPOP Loud · Streaming Pro · YouTube Safe
- **Character:** Lofi Warm · EDM Wide · Ballad Vocal · Piano Natural · Vintage Soft
- **AI Special:** AI Vocal Cleaner · Cymbal Smooth · Stereo Repair · Mono Safe Shorts

Each is tuned distinctly (see `PRESET_BENCHMARK_NOTES.md`) — not loudness-only.

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:preset-tuning` | **14/14** (ranges, NaN, consistency, AI intents) |
| `pnpm test:realtime-graph` | 8/8 |
| full desktop test suite | 14/14 · 15/15 · 22/22 (no regression) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| `cargo check -p loui-dsp-wasm` | clean |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK (preset browser stories added) |
| preset switch | config push to same node — **no graph rebuild** |

---

## 5. Constraints honoured

- No graph rebuild on preset switch · no fake loudness-only differences ·
  no preview/export drift · ProductPage fallback intact · realtime flag
  default OFF · no ScriptProcessor · no UI redesign.

---

## 6. Next

1. Mount `LouiPresetBrowser` in an expandable preset surface.
2. Promote preview-only tone params to export-renderable.
3. On-device listening pass → tuning v1.1.
