# AUDIO-OUTPUT-GRAPH — meters move but no sound + spectrum idle

> After Realtime Preview started enabling the WASM analyzer session, the
> source plays no audio and the spectrum stays idle ("재생을 시작하면…"),
> even though some status values move.

## 1. The graph (correct in principle)

```
<audio> --createMediaElementSource--> source
  source → [masteringNode] → analyzer-tap → ctx.destination
```

`analyzer-tap.worklet.js` **passes input → output** (it's a tap, not a
sink) and also posts blocks to the main thread for FFT/loudness. So a
correctly-wired session both plays sound AND drives the meters/spectrum.

Therefore "no sound AND idle spectrum" ⇒ **no audio is reaching the tap at
all** — the `MediaElementSource` is not delivering audio.

## 2. Root cause — `createMediaElementSource` called more than once

`createMediaElementSource(el)` may be called **once per element for the
element's entire lifetime**. A second call (even on a new AudioContext)
throws `InvalidStateError`, and the element stays "captured" by the first
(now-closed) context — so it produces no sound natively either.

`WasmAnalyzerProvider` (`wasm-analyzer-context.tsx`) created the session
in an effect keyed on **`active`** (playing):

```ts
if (!active || !mediaElement) { setSession(null); return; }
… s.start(); s.attachMediaElement(mediaElement); …
return () => { s.stop(); /* closes the AudioContext */ };
```

`s.start()` does `new AudioContext(...)`, and `attachMediaElement` →
`createMediaElementSource`. The cache guard rebuilds when
`src.context !== this.ctx`:

```ts
if (!src || src.context !== this.ctx) {
  src = this.ctx.createMediaElementSource(media);   // throws on 2nd context
}
```

So the lifecycle was:

1. **Play** → session #1, context A, `createMediaElementSource` OK → sound.
2. **Pause** → cleanup → `ctx.close()` (context A dead).
3. **Play again / A-B / re-render** (`active` re-toggles) → session #2,
   context B → `createMediaElementSource` throws (element already wired) →
   caught → session has **no source** → `source → tap → destination` never
   built → **silence + idle spectrum**, permanently (the element is stuck
   on the closed context A).

This was dormant while the WASM analyzer was OFF (audio played natively).
Auto-enabling the analyzer for Realtime Preview surfaced it.

## 3. Fix — create the session ONCE per element; don't tear down on pause

`WasmAnalyzerProvider` now:

- Creates the session when **`mediaElement`** is present (no longer keyed
  on `active`), so the `AudioContext` + `MediaElementSource` are built
  exactly once per element and survive play/pause and src swaps.
- Uses `active` only to **resume** the context (a play gesture resumes a
  suspended context), never to destroy it.
- Tears down only when the element actually goes away (unmount / element
  change).

`createMediaElementSource` is therefore called once; the element is never
left captured by a dead context; `source → [master] → tap → destination`
stays wired, so sound, spectrum, and loudness all track the audio the user
hears.

## 4. Routing note (analyzer vs output)

The meter/spectrum read the SAME post-tap signal that reaches
`destination` (the tap forwards what it analyses), and the realtime master
node, when present, sits *before* the tap — so meters reflect the
processed output the user hears, not a separate dry path.

## 5. Honest status unchanged

`active` (heard-live) still requires real chain processing
(`avgProcessMs > 0`); silence/passthrough never reads as "Live".
