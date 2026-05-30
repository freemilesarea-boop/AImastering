// Lightweight React subscriptions on an externally-managed AnalyzerSession.
//
// Use this when the session lifecycle is owned elsewhere (e.g. a context
// provider like `WasmAnalyzerProvider` that owns one session for many
// components).  Use `useAnalyzerStream` when the consumer wants the hook
// to manage the session lifecycle for it.

import { useEffect, useState } from 'react';
import type {
  AnalyzerSession,
  FftFrame,
  MeterSnapshot,
  MeterTickSnapshot,
  StereoScopeFrame,
  SubscriptionRate,
} from '@aimaster/shared-types/streaming';

export interface UseAnalyzerSubscriptionsOptions {
  /** Subscribe to tick snapshots — pass `null` to disable. */
  tickRate?: SubscriptionRate | null;
  /** Subscribe to full snapshots. */
  enableFullSnapshot?: boolean;
  /** Subscribe to FFT frames. */
  enableFft?: boolean;
  /** Subscribe to stereo scope frames. */
  enableStereo?: boolean;
}

export interface AnalyzerSubscriptions {
  tick: MeterTickSnapshot | null;
  full: MeterSnapshot | null;
  fft: FftFrame | null;
  stereo: StereoScopeFrame | null;
}

/**
 * Subscribe to streams from a given session.  Returns the latest snapshot
 * of each subscribed stream.  `null` session → all streams remain `null`.
 *
 * Each toggled flag re-registers its subscription with the session, so
 * hiding a panel cancels its work-cost upstream.
 */
export function useAnalyzerSubscriptions(
  session: AnalyzerSession | null,
  opts: UseAnalyzerSubscriptionsOptions,
): AnalyzerSubscriptions {
  const [tick, setTick] = useState<MeterTickSnapshot | null>(null);
  const [full, setFull] = useState<MeterSnapshot | null>(null);
  const [fft, setFft]   = useState<FftFrame | null>(null);
  const [stereo, setStereo] = useState<StereoScopeFrame | null>(null);

  const tickRate = opts.tickRate ?? null;
  const enableFull = opts.enableFullSnapshot ?? false;
  const enableFft  = opts.enableFft ?? false;
  const enableSt   = opts.enableStereo ?? false;

  useEffect(() => {
    if (!session) {
      setTick(null);
      return;
    }
    if (!tickRate) return;
    const unsub = session.onTickSnapshot(tickRate, (s) => setTick(s));
    return unsub;
  }, [session, tickRate]);

  useEffect(() => {
    if (!session || !enableFull) {
      setFull(null);
      return;
    }
    const unsub = session.onFullSnapshot((s) => setFull(s));
    return unsub;
  }, [session, enableFull]);

  useEffect(() => {
    if (!session || !enableFft) {
      setFft(null);
      return;
    }
    const unsub = session.onFftFrame((f) => setFft(f));
    return unsub;
  }, [session, enableFft]);

  useEffect(() => {
    if (!session || !enableSt) {
      setStereo(null);
      return;
    }
    const unsub = session.onStereoFrame((f) => setStereo(f));
    return unsub;
  }, [session, enableSt]);

  return { tick, full, fft, stereo };
}
