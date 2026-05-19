# M3-P-NEXT-5A — Parameter Definitions

> Full per-module table of every UI parameter with its metadata.

---

## 1. EQ — 6 parameters

| id | kind | label | unit | min..max | default | step | binding (status) |
|---|---|---|---|---:|---:|---:|---|
| lowCutHz       | number  | Low Cut     | Hz | 20..120 |   32 | 1   | adaptive-eq.bands[lowCut].freqHz (pending) |
| lowShelfDb     | number  | Low Shelf   | dB | -6..+6  |  1.2 | 0.1 | adaptive-eq.bands[lowShelf].gainDb (pending) |
| presenceDb     | number  | Presence    | dB | -6..+6  |  1.4 | 0.1 | adaptive-eq.bands[presence].gainDb (pending) |
| airDb          | number  | Air         | dB | -6..+6  |  2.0 | 0.1 | adaptive-eq.bands[air].gainDb (pending) |
| outputGainDb   | number  | Output Gain | dB | -12..+12|  0.0 | 0.1 | gain-staging.targetPeakDb (**wired**) |
| adaptive       | boolean | Adaptive    | —  | —       | true | —   | adaptive-eq.adaptive (**wired**) |

Module bypass binding: `adaptive-eq.bypass` (pending).

Formatters:
- `lowCutHz` → integer
- `lowShelfDb` / `presenceDb` / `airDb` / `outputGainDb` → signed dB
- `adaptive` → "On" / "Off" pill

---

## 2. Dynamics (Glue Comp) — 5 parameters

| id | kind | label | unit | min..max | default | step | binding (status) |
|---|---|---|---|---:|---:|---:|---|
| thresholdDb | number | Threshold | dB  | -30..0   |  -14 | 0.5 | bus-comp.thresholdDb (**wired**) |
| ratio       | number | Ratio     | :1  | 1..10    |  2.0 | 0.1 | bus-comp.ratio (**wired**) |
| attackMs    | number | Attack    | ms  | 0.1..100 |   10 | 0.5 | bus-comp.attackMs (**wired**) |
| releaseMs   | number | Release   | ms  | 10..1000 |  120 | 5   | bus-comp.releaseMs (**wired**) |
| mixPct      | number | Mix       | %   | 0..100   |  100 | 1   | bus-comp.mixPct (pending) |

Module bypass binding: `bus-comp.bypass` (pending).

Formatters:
- `thresholdDb` → 1-decimal
- `ratio` → 1-decimal with ":1" unit
- `attackMs` → 1-decimal
- `releaseMs` → integer
- `mixPct` → integer

Note: `mixPct` is marked **pending** because today's EngineSchema
`EngineBusCompModule` has no parallel-mix field.  M2-full adds it.

---

## 3. Imager — 7 parameters

| id | kind | label | unit | min..max | default | step | binding (status) |
|---|---|---|---|---:|---:|---:|---|
| widthPct        | number  | Width        | %   | 0..200  | 100   | 1   | stereo-imager.width (**wired**) |
| lowMonoHz       | number  | Low Mono     | Hz  | 20..400 | 120   | 5   | stereo-imager.lowMonoFrequency (pending) |
| stereoize       | boolean | Stereoize    | —   | —       | false | —   | stereo-imager.stereoize (pending) |
| bandLowPct      | number  | Low Band     | %   | 0..200  |  40   | 5   | stereo-imager.bands[0].width (pending) |
| bandMidLowPct   | number  | Mid-Low Band | %   | 0..200  | 100   | 5   | stereo-imager.bands[1].width (pending) |
| bandMidHighPct  | number  | Mid-High Band| %   | 0..200  | 110   | 5   | stereo-imager.bands[2].width (pending) |
| bandHighPct     | number  | High Band    | %   | 0..200  |  90   | 5   | stereo-imager.bands[3].width (pending) |

Module bypass binding: `stereo-imager.bypass` (pending).

Note: `widthPct` UI range 0..200 maps to engine 0..2.0 (1.0 =
passthrough).  Conversion happens in M3-P-NEXT-5B's dispatcher.

Per-band widths bind to a future `EngineStereoImagerModule.bands` field
that doesn't exist in EngineSchema today — M2-full adds it.

---

## 4. Limiter — 5 parameters

| id | kind | label | unit | min..max | default | step | binding (status) |
|---|---|---|---|---:|---:|---:|---|
| targetLufs   | number  | Target LUFS         | LUFS  | -24..-6 | -14   | 0.5 | loudness-norm.targetLufs (**wired**) |
| ceilingDbtp  | number  | True-Peak Ceiling   | dBTP  | -3..0   |  -1.0 | 0.1 | limiter.ceilingDb (**wired**) |
| isp          | boolean | True-Peak           | —     | —       | true  | —   | limiter.oversample (**wired** — true→4×, false→1×) |
| lookaheadMs  | number  | Lookahead           | ms    | 0..20   |  2.5  | 0.1 | limiter.lookAheadMs (**wired**) |
| character    | enum    | Character           | —     | 4 values | glue | —   | limiter.character (pending) |

Enum `character` values:
- `'transparent'` — Transparent (Clean, hi-fi mastering)
- `'glue'`        — Glue (Default — warms transients)
- `'aggressive'`  — Aggressive (Loud, modern pop)
- `'classic'`     — Classic (Vintage, soft saturation)

Module bypass binding: `limiter.bypass` (pending).  Note: disabling the
limiter at this stage is dangerous; the UI surfaces a warning.

`targetLufs` routes to the separate `loudness-norm` engine module, not
the limiter — this is the **first cross-module binding** in the
contract.

---

## 5. Export — 4 parameters

| id | kind | label | min..max | default | binding (status) |
|---|---|---|---:|---:|---|
| format     | enum | Format      | wav/flac/mp3/aiff/ogg                | wav   | export.format (unavailable) |
| sampleRate | enum | Sample Rate | 44100/48000/88200/96000/192000       | 48000 | export.sampleRate (unavailable) |
| bitDepth   | enum | Bit Depth   | 16/24/32                              | 24    | export.bitDepth (unavailable) |
| dither     | enum | Dither      | none/tpdf/shaped                      | tpdf  | dither.algorithm (pending) |

Module bypass binding: not applicable (`unavailable`).  Export is a
render-stage decision, not a DSP module.

Status notes:
- `format` / `sampleRate` / `bitDepth` are **unavailable** because the
  current Electron main process only exports MP3 + WAV via `file:save-wav`.
  M3-P-NEXT-5B extends the IPC to honour the descriptor.
- `dither` is **pending** because EngineSchema's `EngineDitherModule`
  exists but no adapter implements it yet.

---

## 6. Binding status summary

| Status        | Count | Meaning |
|---|---:|---|
| `wired`       | 7 | Ready today — adapter writes / reads this binding |
| `pending`     | 13 | M2-full or M3-P-NEXT-5B will wire it |
| `unavailable` | 4 | Not on any roadmap (export-only) |
| **Total**     | **24** parameters across 5 modules |
|               | + 5 module-bypass bindings (4 pending, 1 unavailable) |

The `wired` parameters are the **first wire-up candidates** for
M3-P-NEXT-5B — they have an adapter ready to receive writes.

---

## 7. Cross-module reads

Some panels surface values owned by another module:

| Reading panel | Reading parameter | Source module | Source parameter |
|---|---|---|---|
| Export panel — Normalize Target | targetLufs (echo)  | limiter | targetLufs  |
| Export panel — Normalize Target | ceilingDbtp (echo) | limiter | ceilingDbtp |

Implemented in `ControlledPanelHost` (ProductPage) via a second
`useModuleParameters('limiter')` call.  No separate state copy — the
echoed values stay live.

When LimiterParameterPanel writes `targetLufs`, the Export panel's
echoed badge updates on next render — same Context, same source of
truth.

---

## 8. Future definitions (out of scope)

The following parameters are anticipated but **not in this milestone**:

- EQ: Mid bands (Low-Mid / Mid / Upper-Mid) — currently bundled with
  the adaptive engine, only shelves + presence + air are user-tunable
- Dynamics: Sidechain (source / HPF) — M2-full adds the sidechain
- Imager: Per-band stereo direction (L / R / Centre) — M2-full
- Limiter: Multi-stage limiting (soft → hard) — M2-full
- Export: Loudness target preset (Spotify / Apple / etc) — links to
  the Preset Header

Each will be added when M2-full lands.  The definition file is the
single edit point — panels pick up the new entry automatically.
