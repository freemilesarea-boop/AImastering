# M3 Product — Realtime UI Goes Live

> Loui Mastering's first end-to-end realtime UI: V2 panels feature-flagged
> onto the existing ResultPage with one-line rollback.

---

## 1. What this milestone delivers

| Artefact | Where |
|---|---|
| `WasmAnalyzerProvider` + `useWasmAnalyzerSession` | `apps/desktop/src/renderer/audio/wasm-analyzer-context.tsx` |
| `useAnalyzerSubscriptions` hook | `apps/desktop/src/renderer/hooks/useAnalyzerSubscriptions.ts` |
| V2 components accept `session` prop | `LoudnessMeterPanelV2`, `SpectrumAnalyzerPanel` (refactored) |
| `StereoScopePanel`                  | new component (canvas-free; bar-style + verdict label) |
| `AnalyzerPanelStack` gate           | `apps/desktop/src/renderer/components/AnalyzerPanelStack.tsx` |
| `attachMediaElement` on WasmAnalyzerSession | `wasm-analyzer-session.ts` (new method) |
| ResultPage swapped to use the gate | one-line change: `<LoudnessMeterPanel>` → `<AnalyzerPanelStack>` |

The default code path is **unchanged**.  V2 only activates when the
feature flag is set.

---

## 2. Feature-flag truth table

| `VITE_LOUI_WASM_ANALYZER` (build) | `window.__LOUI_WASM_ANALYZER__` (runtime) | Result |
|---|---|---|
| (unset)  | (unset / false) | **V1** — existing `LoudnessMeterPanel`, no other panels |
| (unset)  | `true`          | **V2** — WASM provider mounts; Loudness V2 + Spectrum + Stereo render |
| `'true'` | (anything)      | **V2** — same as above |
| (any)    | `false`         | **V1** — runtime override wins |

Rollback in one of three places:
1. CI: unset `VITE_LOUI_WASM_ANALYZER`, rebuild.
2. Hotfix: ship an Electron update with the build var unset.
3. Per-user: devtools `window.__LOUI_WASM_ANALYZER__ = false`.

---

## 3. ResultPage diff (the only page-level change)

Before:
```tsx
import { LoudnessMeterPanel } from '../components/LoudnessMeterPanel.js';
…
<LoudnessMeterPanel mediaElement={audioRef.current} active={playing} targetLufs={targetLufs} />
```

After:
```tsx
import { AnalyzerPanelStack } from '../components/AnalyzerPanelStack.js';
…
<AnalyzerPanelStack mediaElement={audioRef.current} active={playing} targetLufs={targetLufs} />
```

Two characters in the JSX tag.  Internal V1 path is identical.

---

## 4. Architecture (when V2 is on)

```
   <ResultPage>
     │
     ▼
   <AnalyzerPanelStack mediaElement={audio} active={playing}>
     │   flag=on:
     ▼
   <WasmAnalyzerProvider>
     │   • creates ONE WasmAnalyzerSession
     │   • attachMediaElement(audio)  (cached: one source per element)
     │   • exposes session via React context
     ▼
   <V2PanelStack>
     │
     ├── <LoudnessMeterPanelV2 session={session} />        ← LUFS / TP / RMS / etc.
     ├── <SpectrumAnalyzerPanel session={session} />        ← live FFT, log freq, peak-hold
     └── <StereoScopePanel session={session} />             ← correlation + width + verdict
                                                           
   The Provider stops the session on unmount or active=false.
```

---

## 5. Verification done in this commit

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` | ✅ 31/31 |
| `pnpm typecheck` (apps/desktop) | ✅ |
| `pnpm typecheck` (shared-types) | ✅ |
| `cargo build --release --target wasm32-unknown-unknown -p loui-dsp-wasm` | ✅ 99 KB |
| `pnpm build:renderer` (V1 mode — env var unset) | ✅ 101 modules, all assets emitted |
| ResultPage default render path | ✅ V1 LoudnessMeterPanel (unchanged behaviour) |
| ResultPage with `window.__LOUI_WASM_ANALYZER__ = true` | ⏳ manual smoke; renders V2 panels on next mount |

---

## 6. Deferred verification (manual / browser)

| Check | Why deferred |
|---|---|
| Live 60 fps for 5+ minutes | Needs Electron runtime + audio source |
| Memory drift across track-change cycles | Same |
| V1 vs V2 LUFS-I divergence on the same track | Same (we have 0.32 LU baseline from M2-lite-NEXT parity) |
| Stereo scope label correctness on diverse content | Subjective; needs listening |
| FFT smoothness during rapid transients | Manual |

These are tracked in `04-ROLLOUT-PLAN.md` § 4 as the gate criteria for
promoting V2 to default.

---

## 7. Issues for follow-up

| ID | Issue | Severity |
|---|---|---|
| **M3-P-A** | `LoudnessMeterPanelV2` / Spectrum / Stereo each carry a `STUB_FACTORY` constant to keep React's rules-of-hooks happy when `session` is provided — duplication; future cleanup into a shared module | Low |
| **M3-P-B** | Browser only allows ONE `createMediaElementSource` per element per context — if a user toggles V2 on/off rapidly, the cached source breaks.  We cache via WeakMap so the first cycle works; second cycle needs context recreation.  Documented in `01-METER-SWAP.md` | Medium |
| **M3-P-C** | `WasmAnalyzerProvider` always creates an AudioContext even when V2 is off (because the flag check happens inside the provider, not above it).  Actually no — the provider does check `isWasmAnalyzerEnabled()` first.  ✅ resolved during impl. | Resolved |
| **M3-P-D** | StereoScopePanel's verdict classification thresholds are heuristic; could be data-driven (M1.75 reference-profile-style learning) | Low |
| **M3-P-E** | When V2 panels mount but `audio` element hasn't played yet, autoplay policies may block `ctx.resume()` — the session stays in "starting…" indefinitely until first user gesture | Medium |
| **M3-P-F** | Worklet load fails silently if `analyzer-tap.worklet.js` is missing — we log to console but don't surface to user.  Should fall back to V1 with a notification | Medium |

---

## 8. Document map

| Doc | Topic |
|---|---|
| `00-OVERVIEW.md` (this) | Milestone summary, truth table, architecture |
| `01-METER-SWAP.md`      | V1 → V2 swap details, `AnalyzerPanelStack` design |
| `02-SPECTRUM-PAGE.md`   | Spectrum panel placement, performance, customisation |
| `03-STEREO-SCOPE.md`    | Stereo classification, UI design, verdict labels |
| `04-ROLLOUT-PLAN.md`    | A/B test plan, acceptance criteria, rollback procedure |
| `05-PRODUCT-LAYOUT.md`  | Future Ozone-style layout proposal (NOT enforced this commit) |
| `06-PERFORMANCE-NOTES.md` | Combined V2 budget, watchpoints |

---

## 9. Next commits

1. **M3-P-NEXT-1**: Storybook stories for V2 panels (factory-driven dev panel + session-driven preview)
2. **M3-P-NEXT-2**: Playwright E2E for `?dev=analyzer-stream` page (CI gate)
3. **M3-P-NEXT-3**: Product layout proposal as a flag-gated `ResultPage` redesign (`VITE_LOUI_PRODUCT_LAYOUT`)
4. **M3-P-NEXT-4**: Promote V2 to default (flip the build flag in CI)
5. **M3-P-NEXT-5**: Remove V1 (after 1+ release of V2 on by default with no rollback)
