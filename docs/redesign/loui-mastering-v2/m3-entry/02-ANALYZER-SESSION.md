# M3-entry — AnalyzerSession Implementation

> First concrete implementation of `AnalyzerSession` — drives the React
> hook and components.  Synthetic for now; WASM in M3-bridge-impl.

---

## 1. Factory selection (today)

```ts
import { SyntheticAnalyzerSessionFactory } from './audio/analyzer-session-synthetic';

const factory = new SyntheticAnalyzerSessionFactory();
```

This is the **only** working concrete factory in this commit.  It drives
the existing TS `LoudnessAnalyzer` against a synthesised internal sine
mix.  Outputs MeterTickSnapshot / MeterSnapshot / FftFrame / StereoScopeFrame
on the same channels the production factory will.

---

## 2. Why a synthetic factory now

Three reasons:

| Reason | Benefit |
|---|---|
| **End-to-end lifecycle verification** | Proves React hook → session start → subscribe → unsubscribe → stop works without needing AudioWorklet wiring |
| **Component development** | UI components can be built + smoke-tested before WASM build is integrated |
| **Deterministic test fixture** | Tests pin to known synthetic output; future regression CI can subscribe + assert |

It's **dev-only**.  The class lives outside the production bundle path
(or behind a `dev` flag — TODO in M3-bridge-impl).

---

## 3. Synthetic generator

The factory simulates a continuous audio source:
- 3 oscillators (220 Hz, 880 Hz, 2.4 kHz)
- Mixed at amplitude levels (1.0, 0.5, 0.3)
- Scaled to land near −14 dBFS RMS
- Stereo with 0.95× R channel (non-trivial correlation)

A 50 ms `setInterval` drives the analyzer with 1/20-second blocks.

---

## 4. Subscription cadences

| Stream | Throttle |
|---|---|
| `tick` snapshots | per subscriber's `rate` (`'60Hz'`/`'30Hz'`/`'10Hz'`) |
| `full` snapshots | 1 Hz |
| `fft` frames | 30 Hz |
| `stereo` frames | 30 Hz |

These match the contracts in `04-TS-STREAMING-API.md` (M2-lite-NEXT).

---

## 5. Production replacement (M3-bridge-impl)

```ts
// apps/desktop/src/renderer/audio/analyzer-session-wasm.ts (M3)
import init, { LouiAnalyzer, LouiSpectrumAnalyzer } from '@loui/dsp-wasm';

export class WasmAnalyzerSessionFactory implements AnalyzerSessionFactory {
  // Wraps:
  // - AudioContext + AudioWorkletNode (the audio thread)
  // - LouiAnalyzer (loudness/TP/RMS/stereo)
  // - LouiSpectrumAnalyzer (FFT)
  // - port.postMessage → main → subscribers
  // - reset / start / stop lifecycle
}
```

Replacing the factory at the React-tree root swaps the data source.  No
component code changes.

---

## 6. AnalyzerSession contract (recap)

| Method | Audio-thread safe? | Allocates? |
|---|:---:|:---:|
| `start()` | n/a (setup) | yes |
| `stop()`  | n/a (teardown) | yes |
| `onTickSnapshot(rate, cb)` | n/a (subscribe) | tiny |
| `onFullSnapshot(cb)` | n/a (subscribe) | tiny |
| `onFftFrame(cb)` | n/a (subscribe) | tiny |
| `onStereoFrame(cb)` | n/a (subscribe) | tiny |
| `requestSnapshot()` | n/a (off-thread) | yes (gated calc) |
| `reset()` | n/a (state reset) | small |

The subscription callbacks themselves run on the **main thread** at the
configured throttle — never on the audio thread directly.

---

## 7. Memory ownership

| Resource | Lifetime |
|---|---|
| Synthetic timer (`setInterval`) | from `start()` to `stop()` |
| LUFS / TP / stereo internal state | from constructor to GC |
| Subscription callbacks | until consumer calls `Unsubscribe` |
| Frame payloads (post-emit) | per call; consumer owns the references |

`stop()` → clears interval → cancels timer → next render frame sees
`isRunning = false`.  Subscriptions remain installed (no-op until next
`start()` ).

`reset()` → fresh `LoudnessAnalyzer` instance → samples_processed = 0.
Equivalent to "new track".

---

## 8. End-to-end smoke test

```tsx
// Dev page or Storybook story (manual run only, not in CI yet):
import { useAnalyzerStream } from '../hooks/useAnalyzerStream';
import { SyntheticAnalyzerSessionFactory } from '../audio/analyzer-session-synthetic';

const factory = new SyntheticAnalyzerSessionFactory();

function Smoke() {
  const { tick, fft } = useAnalyzerStream({
    factory,
    sessionOptions: { sampleRate: 48_000, channels: 2 },
    tickRate: '30Hz',
    enableFft: true,
  });
  return (
    <div>
      <p>tick samples: {tick?.samplesProcessed}</p>
      <p>fft bins: {fft?.binCentresHz.length}</p>
    </div>
  );
}
```

Within ~100 ms of mount you should see `samplesProcessed` ticking up
and `fft.binCentresHz.length === 64` (synthetic bin count).
