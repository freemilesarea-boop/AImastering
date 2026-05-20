# M3-O-NEXT-7 — Performance Regression Report

> Confirm the polish additions don't increase analyzer CPU or hurt FPS.

---

## 1. What was added (perf-relevant)

| Addition | Perf characteristic |
|---|---|
| Analyzer depth wash | CSS `radial-gradient` — composited by the GPU; zero JS / zero per-frame cost |
| Module active glow | CSS `box-shadow` — static; no animation loop |
| Signal-flow chevrons | static SVG (5 small paths); rendered once |
| Preset loudness gradient | CSS `linear-gradient` strip — static |
| A/B compare | reuses the SINGLE existing `<audio>` element + analyzer session — no new audio graph |
| LU-match compensation | sets `audio.volume` in a React effect (runs on toggle, not per-frame) |
| reduced-motion | disables transitions — strictly reduces work |

**None of these run in the analyzer's RAF loop.**  The spectrum /
loudness / stereo render loops are untouched.

---

## 2. Analyzer FPS

The analyzer (SpectrumAnalyzerPanel + meters) RAF loop is unchanged:
- Same 30 Hz FFT subscription
- Same canvas draw
- The depth wash is a sibling DOM layer (CSS), not drawn on the canvas

Expected FPS: identical to M3-P-NEXT-6.  No new per-frame work was
introduced.

---

## 3. A/B source swap cost

| Operation | Cost |
|---|---|
| Toggle A/B | one `setState` + one `<audio src>` change + one `loadedmetadata` listener |
| Source swap | browser reloads the (already-on-disk) preview file — same as the existing re-render swap |
| Analyzer reconnection | NONE — the same `<audio>` element + `MediaElementAudioSourceNode` persist; only `src` changes |

The A/B swap is the same mechanism as the existing preview re-render
swap (M3-P-NEXT-5C), which was already validated as non-disruptive to
the analyzer session.

---

## 4. Loudness compensation cost

`audio.volume = 10^(-trimDb/20)` in a `useEffect` keyed on
`[compensated, abMode, reRenderedLufs, baseLufs]`.  Runs only when one
of those changes (a toggle), never per audio frame.  O(1).

---

## 5. Bundle size

| Metric | M3-P-NEXT-6 | M3-O-NEXT-7 | Δ |
|---|---|---|---|
| renderer JS | 438.6 KB | 443.6 KB | +5 KB (A/B + reduced-motion + visual touches) |
| WASM | 99.24 KB | 99.24 KB | 0 |

+5 KB for the A/B component + hook + visual CSS — negligible.

---

## 6. CPU budget verdict

| Concern | Verdict |
|---|---|
| Analyzer RAF loop | unchanged — no new per-frame work |
| New animation loops | none added |
| GPU compositing | +3 static CSS gradients (cheap) |
| A/B audio | reuses existing element + session |
| Memory | +1 audio src reference; no new buffers |

**Conclusion**: no measurable CPU / FPS regression.  All polish is
static CSS or event-driven state — nothing taxes the render loop.

---

## 7. How to verify in the running app

1. Open ProductPage with a mastered track, press Play.
2. Open DevTools → Performance → record 5 s while the analyzer runs.
3. Confirm the frame rate matches the pre-milestone baseline (the
   spectrum draw is the dominant cost; the depth wash adds a composite
   layer, not a paint-per-frame).
4. Toggle A/B several times — confirm no analyzer stutter (the session
   persists across swaps).

(Not runnable in the sandbox — no audio device / engine.  The reasoning
above rests on: no new RAF work, CSS-only visuals, and A/B reusing the
proven swap mechanism.)
