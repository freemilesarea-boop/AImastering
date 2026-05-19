# M3 Product — Rollout Plan + Rollback

> How V2 progresses from "feature-flagged off" to "shipping default" to
> "V1 removed."  Each step has a gate, an A/B period, and a rollback
> procedure.

---

## 1. Lifecycle phases

```
[Phase 0 — current]
   ├─ V1 default everywhere
   ├─ V2 reachable via ?dev=analyzer-stream
   ├─ V2 reachable via window.__LOUI_WASM_ANALYZER__ = true
   └─ V2 reachable via VITE_LOUI_WASM_ANALYZER=true (build)

[Phase 1 — internal opt-in]
   ├─ Internal QA builds with VITE_LOUI_WASM_ANALYZER=true
   ├─ Engineering team uses V2 daily for 1 week
   └─ Bug bash + metric baselines collected

[Phase 2 — external opt-in]
   ├─ Public docs mention the toggle for power users
   ├─ Settings UI exposes "Use experimental WASM analyzer" checkbox
   │   (stores window.__LOUI_WASM_ANALYZER__ in electron-store)
   └─ Collect telemetry: crashes, frame drops, CPU samples

[Phase 3 — V2 default]
   ├─ CI release builds set VITE_LOUI_WASM_ANALYZER=true
   ├─ V1 still available via window.__LOUI_WASM_ANALYZER__ = false
   └─ Monitor support tickets / crash reports for 1 release

[Phase 4 — V1 removed]
   ├─ Delete LoudnessMeterPanel + LoudnessStream + loudnessProcessor.worklet.js
   ├─ Delete the feature-flag resolver's V1 branch
   └─ AnalyzerPanelStack always renders V2
```

---

## 2. Phase 1 — Internal QA gate

**Promotion criteria** (all must pass on internal builds):

| Check | Target |
|---|---|
| Cargo + TypeScript suites | clean |
| End-to-end Playwright | ⏳ to write (M3-P-NEXT-2) |
| ResultPage manual: V1 path still works | identical to baseline |
| ResultPage manual: V2 path renders | meters animate, spectrum shows curve, stereo shows verdict |
| LUFS-I divergence vs V1 on same track | < 0.5 LU |
| TP divergence vs V1 | < 0.3 dB |
| 5-minute playback CPU profile | analyzer CPU < 3% renderer total |
| 30-minute playback heap profile | < 100 MB drift |
| Track-change cycle × 20 | no console errors, no leaks |
| Window resize × 10 | no canvas glitches |
| Autoplay-blocked first start | session re-creates on user gesture |

**Failure handling**: any failure → fix, re-test.  Don't move to Phase 2
until all green.

---

## 3. Phase 2 — External opt-in gate

**Promotion criteria**:

| Check | Target |
|---|---|
| All Phase 1 checks | still pass |
| Settings UI exposes toggle | implemented + tested |
| Telemetry endpoint receives `analyzer_mode = 'v2'` events | confirmed in dev backend |
| At least 50 external users opted in | from beta channel |
| No P0 crash reports | over 7-day window |
| Median frame rate ≥ 55 fps | 95th percentile ≥ 50 fps |
| GC pause distribution: 99th percentile ≤ 50 ms | from telemetry samples |
| LUFS divergence reported by users | within 0.5 LU of V1 expectations |

---

## 4. Phase 3 — V2 default gate

**Promotion criteria**:

| Check | Target |
|---|---|
| 30+ days in external opt-in with > 200 active users on V2 | confirmed |
| Bug reports specific to V2 | 0 unresolved P0/P1 |
| CPU / frame / GC metrics | within 10% of V1 baseline |
| Audio glitch reports | none confirmed |
| LUFS confusion: users report "wrong" reading | < 1% of users |

When ready: `CI build sets VITE_LOUI_WASM_ANALYZER=true`.  V1 still
reachable via runtime override.

---

## 5. Rollback procedures

### Immediate (Phase 3+)
1. Set `window.__LOUI_WASM_ANALYZER__ = false` via:
   - Auto-updater hotfix: ship new app version with `VITE_LOUI_WASM_ANALYZER` unset
   - Or: Electron main process writes false to electron-store at startup if config flag toggled

### Per-user
1. Open Settings → "Experimental analyzer (WASM)" checkbox → off.
2. Restart playback.  V1 mounted on next session.

### Whole fleet (Phase 4 retracted)
1. Re-add V1 imports + LoudnessMeterPanel render.
2. Reverse the gate: AnalyzerPanelStack returns V1 unconditionally.
3. Ship via auto-update.

The V1 path is preserved through Phase 3.  Phase 4 is a one-way door —
once V1 is deleted, rollback requires a code revert and rebuild.

---

## 6. Telemetry events to emit

When the analytics module ships (M3+ scope), emit:

| Event | Payload |
|---|---|
| `analyzer_session_started` | `{ mode: 'v1'|'v2', sample_rate, channels }` |
| `analyzer_session_stopped` | `{ mode, duration_sec, samples_processed }` |
| `analyzer_session_error`   | `{ mode, error_class, stack_trim }` |
| `analyzer_frame_drop`      | (V2 only) `{ count_in_last_60s }` |
| `analyzer_lufs_divergence` | `{ v1_lufs_i, v2_lufs_i }` (when both paths active in dev) |

All sampled at ≤ 0.1 Hz to avoid analytics blast radius.

---

## 7. Manual smoke test script (Phase 1)

```
1. Open Electron app, leave WASM flag default (V1).
2. Master a test file → ResultPage.
3. Start playback.  Confirm V1 meter animates.
4. Stop playback.  Confirm meter freezes.
5. Switch track.  Confirm meter restarts.
6. Open devtools console.  Run: window.__LOUI_WASM_ANALYZER__ = true.
7. Navigate away and back to ResultPage (or refresh).
8. Confirm 3 panels appear: loudness, spectrum, stereo.
9. Start playback.  Confirm all 3 animate.
10. Stop / switch / restart cycle.  Confirm clean lifecycle, no leaks.
11. Resize window aggressively.  Confirm spectrum canvas redraws cleanly.
12. Disable network → reload app → confirm WASM loads from cache, app starts cleanly.
```

Each step records pass/fail in `phase-1-test-log.md` (created by tester).

---

## 8. Risk register

| Risk | Mitigation |
|---|---|
| MediaElementSource caching breaks on context recreate | Documented in `01-METER-SWAP.md` § 4; first cycle works, repeated cycles need context recreation (tracked M3-P-B) |
| Autoplay-policy block leaves session in "starting…" forever | Mount session lazily on first user-gesture from page (M3-P-NEXT) |
| WASM .wasm fails to fetch (CSP, file:// in Electron prod) | Health check at start → fallback to V1 with notification (M3-P-F) |
| User toggles V1/V2 mid-playback | Session lifecycle handles unmount cleanly; next mount re-creates as new |
| Memory grows over hours of playback | M3-BI-F: `stop()`+`start()` between tracks reclaims; for very long sessions, add explicit reset cadence (M3-P-NEXT) |
| LUFS-I differs from V1 enough that users notice | M2-lite-NEXT measured 0.32 LU max delta — within JND.  No expected user-visible difference. |

---

## 9. Owner

The flag belongs to the renderer team.  CI build flag is owned by the
release engineering team.  Telemetry is owned by the analytics team
(once it exists).
