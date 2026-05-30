# M3-P-NEXT-5D-2-c — Sample Rate / Bit Depth Wiring (Preparation)

> Wire the Export panel's sample-rate + bit-depth chips into the export
> override.  Both are already MasteringOptions fields.

---

## 1. Goal

The ExportParameterPanel's Format / Sample Rate / Bit Depth / Dither
chips are still UI shells.  `MasteringOptions` already has `sampleRate`
and `bitDepth`, so wiring those two into the export override is trivial
and low-risk.  Format + dither need the save-path extension (5D-2-d).

---

## 2. What's already there

```ts
interface MasteringOptions {
  sampleRate: number;   // ← export chip can drive this
  bitDepth: number;     // ← export chip can drive this
  // format / dither: NOT in MasteringOptions — need save-path work (5D-2-d)
}
```

The Python pipeline already honours `sampleRate` + `bitDepth` (the
initial master uses them).  So a Re-master & Export with overridden
sample-rate / bit-depth Just Works through the existing `audio:master`.

---

## 3. Tasks

1. **Read export panel state** — the panel already tracks `sampleRate` +
   `bitDepth` (string enums '48000' / '24').  Convert to numbers.
2. **Merge into the export override** — extend `buildExportOverride` (or
   the ProductPage export handler) to include `sampleRate` / `bitDepth`
   when they differ from base.
3. **Surface in the change summary** — "Applies: targetLufs, sampleRate".

---

## 4. Conversion

```ts
const exportSampleRate = parseInt(panelState.sampleRate, 10);  // '48000' → 48000
const exportBitDepth   = parseInt(panelState.bitDepth, 10);    // '24'    → 24
```

Both are simple `parseInt`.  Validate against allowed enums before
merging (the panel already constrains them).

---

## 5. Where to merge

Option A (clean): the export panel's sampleRate/bitDepth become part of
the `renderOverride` via a small extension to the export builder:

```ts
buildExportOverride(summary, { sampleRate, bitDepth })
  → optionsOverride includes sampleRate / bitDepth when ≠ base
```

Option B: merge them in the ProductPage `onReMasterExport` handler
directly.

Recommendation: **Option A** — keeps all override construction in one
place (`buildExportOverride`), consistent with the parameter override.

---

## 6. Scope boundary

5D-2-c covers ONLY sample-rate + bit-depth (existing MasteringOptions
fields).  It does NOT touch:
- **format** (wav/flac/mp3/...) — needs `file:save-wav` to convert, or a
  new export encoder path (5D-2-d)
- **dither** — needs the EngineSchema `dither` module wired (M2-full)

Keeping 5D-2-c to the two safe fields means zero save-path / Python
risk.

---

## 7. UI addition

Above the export buttons:

> Exporting as WAV · 48 kHz · 24-bit

…reflecting the panel's current format/SR/depth selection, so the user
confirms the file spec.  Format stays "WAV" until 5D-2-d.

---

## 8. Risk

| Item | Risk |
|---|---|
| sampleRate / bitDepth merge | Low — existing MasteringOptions fields, Python honours them |
| Re-master latency at 96/192 kHz | Med — higher SR = slower render; show progress |
| format conversion | NOT in 5D-2-c (deferred to 5D-2-d) |

---

## 9. Sequencing

| PR | Scope | Risk |
|---|---|---|
| 5D-2-c-1 | sampleRate / bitDepth → export override | Low |
| 5D-2-c-2 | "Exporting as …" confirm line          | Low |
| 5D-2-d   | format / dither (save-path change)      | Med |

After 5D-2-c, the user controls loudness / ceiling / width / output gain
AND sample-rate / bit-depth end-to-end — UI → preview → export.  Only
file format + dither remain (5D-2-d / M2-full).
