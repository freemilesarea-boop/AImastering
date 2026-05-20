# Listening Notes — <PRESET NAME> · <DATE> · <ENGINEER>

> Copy this file to `LISTENING_NOTES_<preset>_<yyyymmdd>.md` and fill it
> in during a tuning session.  One file per preset per session.

Preset id: `<id>`   ·   tuning version: `<x.y.z>`

---

## 1. Setup

| Field | Value |
|---|---|
| Realtime preview flag | ON / OFF |
| Build | `VITE_LOUI_REALTIME_PREVIEW=…` |
| Sample rate | 48 kHz |
| Reference master(s) | <name / platform> |

---

## 2. Per-source impressions

For each source (see PRESET_QA_MATRIX §1), rate 1–5 + free notes.

| Source | Tone | Loudness | Width | Artefacts | Mono (P3) | Notes |
|--------|------|----------|-------|-----------|-----------|-------|
| S1 AI vocal pop |  |  |  |  |  |  |
| S2 female vocal |  |  |  |  |  |  |
| S3 male vocal |  |  |  |  |  |  |
| S4 EDM |  |  |  |  |  |  |
| S5 piano |  |  |  |  |  |  |
| S6 low-end heavy |  |  |  |  |  |  |
| S7 fake-wide |  |  |  |  |  |  |
| S8 harsh cymbals |  |  |  |  |  |  |

---

## 3. Measured (from the debug panel / __LOUI_REALTIME_DEBUG__)

| Metric | Value |
|---|---|
| Integrated LUFS (preview) |  |
| True peak (dBTP) |  |
| Limiter GR (dB) |  |
| CPU % (chain) |  |
| xruns |  |

`__LOUI_REALTIME_DEBUG__.exportJSON()` output (paste):

```json

```

---

## 4. Preview ↔ export consistency

| Property | Preview | Export | Δ | Within tol? |
|---|---|---|---|---|
| Integrated LUFS |  |  |  | ≤1.5 LU |
| True peak |  |  |  | ≤0.5 dB |
| Width impression |  |  | — | direction match |

---

## 5. Verdict + tuning changes proposed

- [ ] Ships as-is
- [ ] Needs tuning — proposed parameter changes:

| Module.param | From | To | Reason |
|---|---|---|---|
|  |  |  |  |
