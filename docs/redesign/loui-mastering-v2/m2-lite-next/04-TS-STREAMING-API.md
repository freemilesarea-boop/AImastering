# M2-lite-NEXT — TS Streaming API

> Concrete TypeScript contracts that consumers (React components,
> non-React tooling, future plugin hosts) bind against.
>
> Package: `@aimaster/shared-types/streaming`
> Location: `packages/shared-types/src/streaming/`

---

## 1. Module index

| File | Exports |
|---|---|
| `meter-snapshot.ts`    | `MeterSnapshot`, `MeterTickSnapshot`, `MeterSnapshotBase`, `METER_SNAPSHOT_SCHEMA`, `isFullSnapshot` |
| `fft-frame.ts`         | `FftFrame`, `FftBinning`, `FFT_FRAME_SCHEMA` |
| `stereo-scope-frame.ts`| `StereoScopeFrame`, `StereoAggregateFrame`, `StereoVectorscopeFrame`, `STEREO_SCOPE_FRAME_SCHEMA` |
| `session.ts`           | `AnalyzerSession`, `AnalyzerSessionFactory`, `AnalyzerSessionOptions`, `SubscriptionRate`, `AnalyzerUnsubscribe` |
| `index.ts`             | re-exports + `STREAMING_API_VERSION` |

Subpath export added in `shared-types/package.json`:
```jsonc
"./streaming": "./src/streaming/index.ts"
```

Usage:
```ts
import type { MeterTickSnapshot, AnalyzerSession } from '@aimaster/shared-types/streaming';
```

---

## 2. `MeterTickSnapshot` and `MeterSnapshot`

Two variants of the same shape:

| Field | Tick | Full |
|---|---|---|
| `samplesProcessed`  | ✓ | ✓ |
| `shortTermLufs`     | ✓ | ✓ |
| `momentaryLufs`     | ✓ | ✓ |
| `truePeakDbtp`      | ✓ | ✓ |
| `samplePeakDb`      | ✓ | ✓ |
| `rmsDb`             | ✓ | ✓ |
| `correlation`       | ✓ | ✓ |
| `msRatioDb`         | ✓ | ✓ |
| `integratedLufs`    | NaN | computed |
| `loudnessRange`     | NaN | computed |
| `gatedBlocks`       | 0 | computed |

Both extend `MeterSnapshotBase`, so a shared component can accept either.
The `isFullSnapshot()` type guard discriminates.

Why two variants?  Audio-thread polling is **allocation-free** with the
tick variant; the full variant requires gated calculations that need
allocation (see M2-lite `02-REALTIME-SAFETY.md`).

---

## 3. `FftFrame`

```ts
interface FftFrame {
  sampleRate: number;
  samplesProcessed: number;
  fftSize: number;
  binning: FftBinning;             // 'third-octave' | 'log' | 'linear'
  binCentresHz: ReadonlyArray<number>;
  magnitudeDb: ReadonlyArray<number>;
  peakHoldDb?: ReadonlyArray<number> | null;
}
```

Bounded array length (≤ 256) so `postMessage` is cheap.  For 1/3-octave
visualisers, ~30 elements — perfect fit for the M1.75 schema cap.

Production note: `binCentresHz` is pre-computed once on session creation
and the **same array reference is reused** frame-to-frame.  Consumers
must NOT mutate it.

---

## 4. `StereoScopeFrame`

Two variants for two display styles:

```ts
type StereoScopeFrame = StereoAggregateFrame | StereoVectorscopeFrame;
```

`StereoAggregateFrame` — bar-style displays (correlation needle, M/S
ratio bar):
```ts
{ correlation: number; msRatioDb: number; widthIndex: number; windowFrames: number }
```

`StereoVectorscopeFrame` — X/Y scope (`midSamples` / `sideSamples`):
```ts
{ midSamples: number[]; sideSamples: number[] }
```

The consumer's render code picks the right one with a discriminated
union check.

---

## 5. `AnalyzerSession` lifecycle

```ts
interface AnalyzerSession {
  readonly options: AnalyzerSessionOptions;
  readonly isRunning: boolean;

  start(): Promise<void>;
  stop():  Promise<void>;

  onTickSnapshot(rate: SubscriptionRate, cb): AnalyzerUnsubscribe;
  onFullSnapshot(cb): AnalyzerUnsubscribe;
  onFftFrame(cb): AnalyzerUnsubscribe;
  onStereoFrame(cb): AnalyzerUnsubscribe;

  requestSnapshot(): Promise<MeterSnapshot>;
  reset(): Promise<void>;
}
```

Both **factories** (WASM + N-API) implement this interface.  React
components write code that doesn't know which transport is in use.

### Subscription rates

| Rate | Cadence | Use |
|---|---|---|
| `'audio'` | per quantum (~750 Hz) | unsafe for `setState`; use only for SAB-backed components |
| `'60Hz'` | ≈ 16 ms | UI default, vectorscope |
| `'30Hz'` | ≈ 33 ms | spectrum analyzer |
| `'10Hz'` | ≈ 100 ms | LUFS / TP meter default |

---

## 6. `AnalyzerSessionFactory`

```ts
interface AnalyzerSessionFactory {
  create(options: AnalyzerSessionOptions): AnalyzerSession;
}
```

Concrete implementations (M3-bridge-impl):
- `WasmAnalyzerSessionFactory`  — uses `loui-dsp-wasm`, hosted in AudioWorklet
- `NapiAnalyzerSessionFactory`  — uses `loui-dsp-node`, hosted in Electron main

A thin bridge selects the right factory at boot:

```ts
// apps/desktop/src/renderer/bootstrap.ts (M3)
import { WasmAnalyzerSessionFactory } from './audio/analyzer-session-wasm';

export const analyzerFactory: AnalyzerSessionFactory = new WasmAnalyzerSessionFactory();
```

---

## 7. React hook usage

`apps/desktop/src/renderer/hooks/useAnalyzerStream.ts` (skeleton committed
in this milestone):

```tsx
function LoudnessPanel() {
  const { tick, isRunning } = useAnalyzerStream({
    factory: analyzerFactory,
    sessionOptions: { sampleRate: 48_000, channels: 2 },
    tickRate: '60Hz',
  });

  if (!isRunning || !tick) return <div>Loading...</div>;

  return (
    <div>
      <Meter label="Momentary" value={tick.momentaryLufs} unit="LUFS" />
      <Meter label="Short-term" value={tick.shortTermLufs} unit="LUFS" />
      <Meter label="True peak" value={tick.truePeakDbtp} unit="dBTP" />
    </div>
  );
}
```

Variants:
- `useMeterTick(...)`           — single-purpose, returns just the tick snapshot
- `useAnalyzerStream({...})`     — full multi-stream hook with selectors

---

## 8. Versioning

```ts
import { STREAMING_API_VERSION, METER_SNAPSHOT_SCHEMA } from '@aimaster/shared-types/streaming';
// STREAMING_API_VERSION === '1.0.0'
// METER_SNAPSHOT_SCHEMA === 'loui.streaming.meter-snapshot.v1'
```

Breaking changes (renames, removals): major bump + new schema URI.
Additive changes (new optional field): minor bump.

The wire format includes the schema URI so consumers can refuse
unknown-version payloads.

---

## 9. Type-only export

Every file uses `export interface` / `export type` only — no runtime
code.  This keeps `@aimaster/shared-types/streaming` zero-cost: the
TypeScript compiler erases all imports, and the bundler doesn't include
anything from the module.

The two runtime constants (`STREAMING_API_VERSION`, schema URIs) are
short strings (< 100 bytes total).

---

## 10. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` shared-types | ✅ |
| `pnpm typecheck` apps/desktop (incl. `useAnalyzerStream`) | ✅ |
| Hook compiles against `@aimaster/shared-types/streaming` | ✅ |
| Hook does NOT import concrete factory yet | ✅ (M3 wiring) |
