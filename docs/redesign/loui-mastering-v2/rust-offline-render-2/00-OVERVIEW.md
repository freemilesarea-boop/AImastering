# RUST-OFFLINE-RENDER-2 — Two-pass Loudness Normalization

> Give the experimental Rust offline render a `targetLufs`-aware two-pass
> stage so it respects loudness + true-peak — the missing piece before
> EQ/Dynamics/Limiter detail can become export-exact.  Still experimental,
> flag OFF, Python fallback intact.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Loudness audit | `LOUDNESS_NORMALIZATION_AUDIT.md` | ✓ |
| 2 | Offline loudness measurement | `src/main/offline/offline-loudness.ts` (reuses node-WASM `LouiAnalyzer`) | ✓ |
| 3 | Target-gain solver | `solveLoudnessGain` (silence-skip, boost/cut clamp) | ✓ |
| 4 | Two-pass render | `renderStereoBufferNormalized` (push-into-limiter) | ✓ |
| 5 | Metrics expansion | measuredProcessedLufs / finalLufs / appliedLoudnessGainDb / finalTruePeakDb | ✓ |
| 6 | Fixture parity tests | `scripts/rust-loudness-selftest.ts` (9/9) | ✓ |
| 7 | Parity report | `RUST_LOUDNESS_PARITY_REPORT.md` | ✓ |
| 8 | Promotion gate | `EXPORT_EXACT_PROMOTION_GATE.md` | ✓ |
| 9 | Verification | this doc §2 | ✓ |

---

## 2. How it works

```
flag ON → audio:master-rust-experimental (now passes targetLufs/targetTp)
  Pass 1: chain render → measure integrated LUFS (LouiAnalyzer)
  Solve : inputGain = clamp(targetLufs − measuredLufs)   (silence → 0)
  Pass 2: chain render with inputGain += solve            (limiter holds ceiling)
  → final integrated LUFS ≈ target, true peak ≤ ceiling
on ANY failure → Python masterFile fallback (unchanged)
```

The loudness measurement uses the SAME EBU R128 analyzer as the realtime
meters; the ceiling is enforced by the chain's own true-peak limiter (no
extra limiter pass).  The created revision now records the REAL final
integrated LUFS + true peak (not just the target estimate).

---

## 3. Verification

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` / `cargo check -p loui-dsp-wasm` | 54/54 / clean |
| `pnpm test:rust-loudness` | **9/9** (silence/quiet→target/loud-ceiling/noise/stereo/maxBoost/metrics/solver) |
| `pnpm test:rust-offline` (RENDER-1) | 7/7 (no regression) |
| `pnpm typecheck` | clean |
| `pnpm build:renderer` / `build:main` / `build-storybook` | OK |
| full desktop suite + all module/export/preset/revision selftests | no regression |
| flag OFF | existing Python `audio:master` flow identical |
| flag ON | two-pass loudness-normalize used; Python fallback on failure |

---

## 4. Honest status + constraints

- **Experimental, OFF by default.** Loudness now targeted (±~2 LU on
  synthetic fixtures), true-peak ceiling held — but real-file + listening
  QA is required before any default switch (see promotion gate).
- **No params promoted to export-exact** this milestone; the honesty
  selftest still gates over-claiming.
- True peak reported as the analyzer's 4× ISP estimate — labelled
  approximate (no exaggerated "exact true peak").
- Python `masterFile` kept · `audio:master` unchanged · Rust default OFF ·
  export pipeline not rewritten · ResultPage/V1 intact.
- DSP/loudness core verified headlessly; ffmpeg file I/O + listening are
  on-device follow-ups.
