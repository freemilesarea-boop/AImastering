# M3-P-NEXT-5D-2-c — Export Quality Options Audit

> Where sampleRate / bitDepth live, and how they map to the re-master.

---

## 1. Export panel parameters (module-parameter-definitions.ts)

| id | kind | values | default | binding status |
|---|---|---|---|---|
| `format`     | enum | wav / flac / mp3 / aiff / ogg | wav   | unavailable |
| `sampleRate` | enum | 44100 / 48000 / 88200 / 96000 / 192000 | 48000 | unavailable |
| `bitDepth`   | enum | 16 / 24 / 32 | 24 | unavailable |
| `dither`     | enum | none / tpdf / shaped | tpdf | pending |

All values are **strings** (enum params).  `sampleRate` / `bitDepth`
need `Number(value)` to reach the numeric MasteringOptions fields.

---

## 2. MasteringOptions target fields

```ts
interface MasteringOptions {
  sampleRate: number;   // ← export.sampleRate (parseInt)
  bitDepth: number;     // ← export.bitDepth (parseInt)
  // format / dither: NOT MasteringOptions fields → 5D-2-d / M2-full
}
```

The Python pipeline already honours `sampleRate` + `bitDepth` (the
initial master passes them).  So overriding them on Re-master & Export
works through the existing `audio:master` — no pipeline change.

---

## 3. Preview vs export renderability

| Param | Preview-renderable? | Export-renderable? | Why |
|---|---|---|---|
| targetLufs / targetTp / stereoWidth / outputGainDb | ✓ | ✓ | affect audio content |
| **sampleRate / bitDepth** | **✗** | **✓** | container quality — no audible content change in the preview MP3 |
| format / dither | ✗ | ✗ (5D-2-d) | need save-path / dither work |

Key insight: sampleRate / bitDepth don't change what the preview MP3
sounds like (it's always a 320 kbps MP3), so they're NOT
preview-renderable.  But they DO change the exported WAV, so they're
**export-renderable** — applied only on Re-master & Export.

---

## 4. Why "unavailable" binding stays

The binding `status` describes DSP-module routing.  sampleRate /
bitDepth have no DSP module (they're render-stage), so `status` stays
`unavailable`.  We add a NEW field `exportField` to mark them as
export-renderable without changing the DSP-routing status:

```ts
binding: {
  moduleType: null,
  path: 'export.sampleRate',
  status: 'unavailable',
  exportField: 'sampleRate',   // ← NEW: maps to MasteringOptions.sampleRate
}
```

---

## 5. Validation

The enum `values` ARE the allowed set:
- sampleRate ∈ {44100, 48000, 88200, 96000, 192000}
- bitDepth ∈ {16, 24, 32}

`buildExportOverride` validates the export-state value against the
def's enum `values`, then `Number()`s it.  Anything outside the enum
(shouldn't happen from the UI, but defensive) → `skippedParameterIds`.

---

## 6. Baselining

`initialStateFromBaseOptions` (5D-1) seeds the 4 renderable params from
the base master.  5D-2-c extends it to also seed export.sampleRate /
export.bitDepth from `base.sampleRate` / `base.bitDepth`, so the export
panel matches the master's actual quality at load (no false "changed").

---

## 7. Plumbing

1. `EngineBindingTarget` += `exportField?: string`
2. sampleRate / bitDepth defs += `exportField`
3. `buildExportOverride(summary, exportState, baseOptions)` reads export
   defs with `exportField`, validates + merges quality into the override
4. The bridge computes `exportOverride` once + a `quality` label;
   ControlledPanelHost reads it; onReMasterExport uses it
5. ExportParameterPanel shows the quality summary + "applies on re-master"

Zero `file:save-wav` change, zero Python change, zero format/dither work.

---

## 8. Edge cases

| Case | Behaviour |
|---|---|
| SR/depth unchanged from base | not in override (Export As-is == Re-master for quality) |
| SR/depth changed             | applied on Re-master only |
| Invalid SR/depth value       | `skippedParameterIds` |
| Export As-is                 | NEVER applies quality (saves the existing WAV) |
| 32-bit selected              | passed to pipeline; support depends on Python (documented) |
