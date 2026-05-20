# M2-PRESET-TUNING — Preset System Audit

> State of the preset system before this milestone, and where the new
> tuning framework plugs in.

---

## 1. What existed (two parallel systems)

| System | Where | Role |
|---|---|---|
| `EnginePreset` (JSON schema) | `packages/shared-types/src/engine/preset.ts` | canonical serializable preset (Python↔TS bridge); rich `meta` (tags/genre/description/legacyStyleId) + `policies` — but **no runtime instances persisted** |
| `MasteringStyle` + `MASTERING_MODES` | `packages/shared-types/src/index.ts` | legacy 7-style taxonomy the Python export consumes |
| `MasteringMode` (CLEAN/BALANCED/LOUD) | `audio/masteringModes.ts` | 3-bucket TS preview simplification |
| `LOUI_PRESET_TARGETS` | `components/product/LouiPresetHeader.tsx` | **UI-only chips** — labels + LUFS/TP strings, no DSP wiring |

**Key gap:** selecting a chip in `LouiPresetHeader` fired `onTargetChange(id)`
but **did not tune any DSP parameter**.  Presets were cosmetic.

---

## 2. Parameter flow (the rails presets ride on)

```
preset → AllModulesParameterState → stateToChainConfig()  → realtime preview (all 13 audio params)
                                   → buildExportOverride() → Python export (4 renderable params)
```

- Central state: `ModuleParameterStateProvider` (`useModuleParameterState.tsx`).
- Realtime config: `stateToChainConfig` (`realtime-mastering-chain.ts`).
- Export-renderable subset: `RENDERABLE_MAP_LOOKUP` (`engine-bridge/renderable-map.ts`)
  — `targetLufs`, `ceilingDb`(TP), `width`, `outputGainDb`.

Both consume the **same state**, so a preset that sets state once is
honoured by preview AND export with no parameter drift (the only gap is
the 7+ preview-only tone params the Python export doesn't yet apply — the
documented, honest capability gap, not drift).

---

## 3. Tunable DSP parameters (what a preset sets)

From `module-parameter-definitions.ts`:

| Module | Params (id · range · default) |
|---|---|
| eq | lowCutHz 20–120 (32) · lowShelfDb ±6 (1.2) · presenceDb ±6 (1.4) · airDb ±6 (2.0) · outputGainDb ±12 (0) · adaptive |
| dynamics | thresholdDb −30–0 (−14) · ratio 1–10 (2.0) · attackMs 0.1–100 (10) · releaseMs 10–1000 (120) · mixPct 0–100 (100) |
| imager | widthPct 0–200 (100) · lowMonoHz 20–400 (120) |
| limiter | targetLufs −24..−6 (−14) · ceilingDbtp −3..0 (−1.0) · isp · lookaheadMs 0–20 (2.5) · character {transparent,glue,aggressive,classic} |

---

## 4. Command + apply infrastructure (already present)

- `CommandSource` already includes `'preset'`; `CommandKind` includes
  `LOAD_PRESET`.  The system was designed for preset application.
- `makeSetParamCommand` validates + clamps; the provider dispatches
  accepted commands to `PresetPatchDispatcher` → export staging.

**So the missing piece was purely:** (a) real per-preset tuning data, and
(b) a bulk-apply path on the provider.  Both are added this milestone.

---

## 5. Persistence

No preset persistence existed (`baseOptions` lives only in `audioStore`,
session-only).  This milestone adds a tiny last-used persistence
(`preset-storage.ts`, localStorage, guarded).

---

## 6. What this milestone adds (summary)

| Piece | File |
|---|---|
| Preset metadata + lineup | `audio/presets/loui-presets.ts` |
| preset → state | `audio/presets/preset-to-state.ts` |
| preset compare (diff) | `audio/presets/preset-compare.ts` |
| last-used persistence | `audio/presets/preset-storage.ts` |
| bulk apply | `useModuleParameterState.tsx` `applyPreset` + `useApplyPreset` |
| ProductPage wiring | preset select → `applyPreset` (no graph rebuild) |
| browser UI | `components/product/LouiPresetBrowser.tsx` + header badges |
| consistency tests | `scripts/preset-tuning-selftest.ts` |
