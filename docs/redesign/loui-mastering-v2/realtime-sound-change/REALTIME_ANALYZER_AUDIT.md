# REALTIME-ANALYZER — Spectrum/Loudness/Stereo never update during playback

> Playback advances, but Spectrum stays "재생을 시작하면…", Loudness stays
> "starting…", Stereo stays "awaiting frames…", while a LIVE badge shows.
> i.e. UI says LIVE but no analysis frames arrive.

## 1. How the panels are fed (verified)

ProductPage renders `LouiAnalyzerCanvas` (spectrum) + `LouiMeterColumn`
(loudness/stereo), both passed `session` from `useWasmAnalyzerSession()`.
They subscribe via `useAnalyzerSubscriptions(session, …)` →
`session.onFftFrame / onTickSnapshot / onStereoFrame`. Frames are produced
by the analyzer-tap worklet (`source → tap → destination`); the tap posts
PCM blocks to `WasmAnalyzerSession.processBlock`, which runs the WASM
analyzers and fans out frames to subscribers.

So "no frames" ⇒ the tap never receives audio, i.e. the session/source
isn't actually wired to the playing element.

## 2. Root causes

1. **Analyzer gated OFF by default.** `WasmAnalyzerProvider` only creates a
   session when `isWasmAnalyzerEnabled()` is true, which was
   `env || window || localStorage || realtime-preview`. A normal user (no
   flags) gets **`session = null`** → no tap → no frames. The meters are a
   core product feature, not an experiment.

2. **`createMediaElementSource` recreated across contexts.** Each session
   did `new AudioContext()` in `start()` and `ctx.close()` in `stop()`.
   `attachMediaElement` rebuilt the source when `src.context !== this.ctx`.
   But an element may have **exactly one** `MediaElementSource` for its
   entire lifetime — a second call throws `InvalidStateError`. React
   **StrictMode** (on, `main.tsx`) double-invokes effects (mount→unmount→
   mount): session A grabs the source on ctx A, cleanup closes ctx A, then
   session B tries to grab it on ctx B → throws → session B has **no
   source** → no frames (and the element is left captured by the dead
   ctx A). Same on any remount / src / sampleRate change.

3. **Dishonest LIVE.** `LouiAnalyzerCanvas` set `active = props.active ??
   Boolean(session)`, and ProductPage passes `active = isPlaying`. So the
   LIVE pulse tracked *playback*, not *frame arrival* — hence "LIVE but
   empty panels".

(There is also a separate `LoudnessStream` that calls
`createMediaElementSource`, but ProductPage's panels read the shared
`session`, not `LoudnessStream`, so they don't collide here.)

## 3. Fixes

1. **Singleton AudioContext + once-only source**
   (`wasm-analyzer-session.ts`): all sessions share ONE app-wide
   `AudioContext` (created once, never closed). The `MediaElementSource` is
   created once per element on that context and cached globally
   (`WeakMap`), so `createMediaElementSource` is never called twice —
   StrictMode, remounts, src swaps, and play/pause all reuse it. `stop()`
   tears down only this session's tap/insert nodes and disconnects the
   source downstream; it never closes the shared context or destroys the
   source. `source → [master] → tap → destination` is rebuilt on the next
   attach.

2. **Analyzer on by default** (`analyzer-factory-resolver.ts`):
   `isWasmAnalyzerEnabled()` now defaults to **true** (the real WASM meter
   engine). Synthetic stays an explicit dev-only opt-out
   (`VITE_LOUI_WASM_ANALYZER=false` / `window.__LOUI_WASM_ANALYZER__=false`
   / `localStorage`), never auto-used (no mock data).

3. **Honest LIVE + per-source frame recency**: a small
   `useFrameLiveness` tracks the last frame timestamp; LIVE shows only when
   a frame arrived within 500 ms. Idle copy shows only when truly no frame.

4. **`[RealtimeAudio]` debug logging** (dev): element found, context state,
   media source connected/reused, per-stream frame counts, last-frame age,
   paused/currentTime/duration, channel count — so frame flow is verifiable
   from the console.

## 4. Result

With the analyzer on by default and the source wired once on a shared
context, playing audio drives `processBlock`, which emits FFT / loudness /
stereo frames to the subscribed panels. LIVE reflects real frame arrival.
Audio still plays (the tap forwards `source → tap → destination`).
