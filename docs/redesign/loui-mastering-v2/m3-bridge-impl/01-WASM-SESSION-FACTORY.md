# M3-bridge-impl — WasmAnalyzerSessionFactory

> The concrete `AnalyzerSessionFactory` backed by the Rust dsp-core WASM
> build.  Replaces `SyntheticAnalyzerSessionFactory` for production use.

---

## 1. API

```ts
import { WasmAnalyzerSessionFactory, startWasmAnalyzerForMediaElement } from '../audio/wasm-analyzer-session';

const factory = new WasmAnalyzerSessionFactory();
// or with explicit worklet URL:
new WasmAnalyzerSessionFactory({ workletUrl: '/my-worklet.js' });

const session = factory.create({ sampleRate: 48_000, channels: 2 });
await session.start();             // boots AudioContext + worklet + WASM
// Optional: attach an audio source
(session as any).attach(mediaElementSource);

session.onTickSnapshot('60Hz', (snap) => { /* meter UI */ });
session.onFftFrame((frame)         => { /* spectrum UI */ });
session.onStereoFrame((frame)      => { /* vectorscope */ });

// Final-render report:
const final = await session.requestSnapshot();

// Track change:
await session.reset();
// or:
await session.stop();
```

One-shot helper for the common `<audio>`-element case:
```ts
const { session, ctx } = await startWasmAnalyzerForMediaElement(factory, audioEl, opts);
```

---

## 2. Lifecycle

```
   factory.create(opts)
         │
         ▼
   WasmAnalyzerSession (idle)
         │ start()
         ▼ ┌──────────────────────────────────────┐
            │ • await init()  — fetches WASM .wasm │
            │ • new LouiAnalyzer(...)               │
            │ • new LouiSpectrumAnalyzer(...)       │
            │ • new AudioContext({ sampleRate })    │
            │ • addModule(workletUrl)               │
            │ • new AudioWorkletNode('analyzer-tap')│
            │ • port.onmessage wires to            │
            │   processBlock(left, right)           │
            │ • isRunning = true                    │
            └──────────────────────────────────────┘
         │ attach(source)
         ▼ source.connect(tapNode); tapNode.connect(ctx.destination);
   processing
         │ stop()
         ▼ ┌──────────────────────────────────────┐
            │ • port.onmessage = null               │
            │ • tapNode.disconnect()                │
            │ • ctx.close()                         │
            │ • analyzer.free()                     │
            │ • spectrum.free()                     │
            │ • isRunning = false                   │
            └──────────────────────────────────────┘
```

---

## 3. Memory ownership

| Resource | Lifetime | Owner |
|---|---|---|
| WASM module (~99 KB .wasm) | first `init()` to renderer unload | wasm-bindgen module-scope cache |
| `LouiAnalyzer` instance | `start()` to `stop()` | WasmAnalyzerSession |
| `LouiSpectrumAnalyzer` instance | `start()` to `stop()` | WasmAnalyzerSession |
| `AudioContext` | `start()` to `stop()` | WasmAnalyzerSession |
| Worklet code | First load, cached | AudioContext (until close) |
| Float32Array payloads from worklet | per port message; transferred ownership | main thread (released after processBlock returns) |
| Subscriber callbacks | `onX()` to returned unsubscribe | consumer |

`stop()` is best-effort: it catches errors from each cleanup step so a
partial failure doesn't strand resources.

**Known leak (M3-BI-F)**: between `reset()` calls the analyzer holds its
own history buffer.  For very long sessions or many track changes,
`reset()` alone doesn't shrink the wasm heap — call `stop()` then
`start()` to force a fresh analyzer.

---

## 4. Subscription throttling

The session emits at the source rate (one block per audio-thread call,
~256 samples = ~5 ms at 48 k) but throttles per-subscription:

| Channel | Min cadence | Configurable |
|---|---|---|
| tick snapshots | 100 ms (`'10Hz'`) | yes — `'60Hz'`/`'30Hz'`/`'10Hz'` per subscriber |
| full snapshots | 1 Hz | no — fixed (gated calc cost) |
| FFT frames | 33 ms (30 Hz cap) | no — fixed |
| stereo frames | 33 ms (30 Hz cap) | no — fixed |

Each subscriber gets its own `lastEmit` timestamp so adding a 60 Hz tick
subscriber doesn't speed up a 10 Hz one.

---

## 5. Throughput / CPU

Predicted (matches M3-entry benchmark numbers):

| Stage | Cost |
|---|---|
| Audio worklet block (memcpy + postMessage) | ~10 µs / block (256 samples) |
| postMessage transfer | ~50 µs (Float32Array ownership transfer) |
| Main-thread processBlock (WASM call + emit) | ~30 µs / block |
| Total CPU @ 48k / 256-block | **~0.5 %** |

`tick_snapshot` allocation: ~50 bytes JS object literal per tick.
Spectrum frame: ~512 bytes (128 bins × 4 bytes) per FFT.  At 30 Hz =
15 KB/s.  No GC spike risk.

---

## 6. Verification in this commit

Compilation:
- `cargo build --release --target wasm32-unknown-unknown -p loui-dsp-wasm` ✅ 99 KB
- `wasm-bindgen --target web` ✅
- `pnpm typecheck` ✅
- `pnpm build:renderer` ✅ (97 modules, all assets emitted)

Runtime smoke (requires browser):
- Open Electron app with `?dev=analyzer-stream` query
- Toggle to "WASM (loui-dsp)"
- ⏳ verify worklet loads + WASM initialises + dev panel meters update

The page also displays a runtime diagnostic block so testers can confirm
which path is active at any moment.
