// useAnalyzerStream — React hook for consuming a loui-dsp analyzer session.
//
// This is the **integration skeleton** (M2-lite-NEXT scope).  It defines
// the consumer-facing API that the M3 UI will use.  The concrete factory
// implementations (WASM via AudioWorklet, N-API via Electron main) are
// not wired here — that's the next step.
//
// Why an interface-only hook now?
//   • Lets renderer / UI components be written against a stable contract.
//   • Both factories implement `AnalyzerSession`; the hook is unchanged
//     when we swap WASM ↔ N-API.
//   • Prevents accidental factory churn during M3 UI work.

import { useEffect, useRef, useState } from 'react';
import type {
  AnalyzerSession,
  AnalyzerSessionFactory,
  AnalyzerSessionOptions,
  MeterTickSnapshot,
  MeterSnapshot,
  FftFrame,
  StereoScopeFrame,
  SubscriptionRate,
  AnalyzerUnsubscribe,
} from '@aimaster/shared-types/streaming';

/** Hook options — what the consumer wants to subscribe to. */
export interface UseAnalyzerStreamOptions {
  /** Required factory (WASM or N-API).  Pick one at app boot time. */
  factory: AnalyzerSessionFactory;
  /** Audio session config. */
  sessionOptions: AnalyzerSessionOptions;
  /** Subscribe to tick snapshots — pass `null` to disable. */
  tickRate?: SubscriptionRate | null;
  /** Subscribe to full snapshots.  Costly; disable when not visible. */
  enableFullSnapshot?: boolean;
  /** Subscribe to FFT frames.  Costly; disable when spectrum panel hidden. */
  enableFft?: boolean;
  /** Subscribe to stereo scope frames. */
  enableStereo?: boolean;
}

/** Hook return shape. */
export interface AnalyzerStream {
  /** The underlying session (for `reset()`, `requestSnapshot()` etc). */
  session: AnalyzerSession | null;
  /** Most recent tick snapshot (or null until first arrives). */
  tick: MeterTickSnapshot | null;
  /** Most recent full snapshot (off-thread cadence — ≤ 5 Hz). */
  full: MeterSnapshot | null;
  /** Most recent FFT frame. */
  fft: FftFrame | null;
  /** Most recent stereo scope frame. */
  stereo: StereoScopeFrame | null;
  /** Whether the session is consuming audio. */
  isRunning: boolean;
}

/**
 * Subscribe a React component to a live analyzer session.
 *
 * Best practices for performance:
 *   • Use shallow-equal selectors to pick out specific fields — re-rendering
 *     on every tick snapshot can cause unnecessary work.
 *   • Disable `enableFft` / `enableStereo` when the corresponding panel
 *     isn't visible (backpressure).
 *   • The session is created ONCE per (factory, options) pair — changes
 *     to those dependencies recreate the session.
 */
export function useAnalyzerStream(opts: UseAnalyzerStreamOptions): AnalyzerStream {
  const sessionRef = useRef<AnalyzerSession | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [tick, setTick] = useState<MeterTickSnapshot | null>(null);
  const [full, setFull] = useState<MeterSnapshot | null>(null);
  const [fft, setFft]   = useState<FftFrame | null>(null);
  const [stereo, setStereo] = useState<StereoScopeFrame | null>(null);

  useEffect(() => {
    const session = opts.factory.create(opts.sessionOptions);
    sessionRef.current = session;
    const unsubs: AnalyzerUnsubscribe[] = [];

    let cancelled = false;
    session.start().then(() => {
      if (cancelled) return;
      setIsRunning(true);

      if (opts.tickRate) {
        unsubs.push(session.onTickSnapshot(opts.tickRate, (s) => setTick(s)));
      }
      if (opts.enableFullSnapshot) {
        unsubs.push(session.onFullSnapshot((s) => setFull(s)));
      }
      if (opts.enableFft) {
        unsubs.push(session.onFftFrame((f) => setFft(f)));
      }
      if (opts.enableStereo) {
        unsubs.push(session.onStereoFrame((f) => setStereo(f)));
      }
    });

    return () => {
      cancelled = true;
      for (const u of unsubs) {
        try { u(); } catch { /* tolerate already-detached subscriptions */ }
      }
      session.stop().catch(() => { /* shutdown best-effort */ });
      sessionRef.current = null;
      setIsRunning(false);
    };
    // factory / sessionOptions changes recreate the session.
    // Other flags toggle subscriptions only — they belong in the dep array.
  }, [
    opts.factory,
    opts.sessionOptions,
    opts.tickRate,
    opts.enableFullSnapshot,
    opts.enableFft,
    opts.enableStereo,
  ]);

  return {
    session: sessionRef.current,
    tick, full, fft, stereo,
    isRunning,
  };
}

/**
 * Lighter-weight variant — subscribes only to tick snapshots and returns
 * just the latest snapshot.  Avoids re-renders from FFT / stereo if the
 * consumer doesn't need them.
 */
export function useMeterTick(
  factory: AnalyzerSessionFactory,
  sessionOptions: AnalyzerSessionOptions,
  rate: SubscriptionRate = '60Hz',
): MeterTickSnapshot | null {
  const { tick } = useAnalyzerStream({
    factory, sessionOptions, tickRate: rate,
  });
  return tick;
}
