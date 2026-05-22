// useFrameLiveness — honest "is analysis actually flowing right now?".
//
// Subscribes to a session's FFT frames and tracks the last arrival time.
// "live" is true ONLY when a frame arrived within `staleMs` (default 500ms),
// so the LIVE badge reflects real frame flow — never just "playing".

import { useEffect, useRef, useState } from 'react';
import type { AnalyzerSession } from '@aimaster/shared-types/streaming';

export type FrameLivenessState =
  | 'no-session'   // no analyzer session (waiting for audio / disabled)
  | 'connecting'   // session present, no frame yet
  | 'live'         // a frame arrived within staleMs
  | 'stale';       // had frames, but none recently (paused / disconnected)

export interface FrameLiveness {
  live: boolean;
  everReceived: boolean;
  state: FrameLivenessState;
  /** ms since the last frame, or null if none yet. */
  ageMs: number | null;
}

export function useFrameLiveness(
  session: AnalyzerSession | null,
  staleMs = 500,
): FrameLiveness {
  const lastAtRef = useRef<number | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    lastAtRef.current = null;
    if (!session) { force((n) => n + 1); return; }
    const unsub = session.onFftFrame(() => {
      lastAtRef.current = performance.now();
    });
    // Poll at ~10 Hz to flip live→stale without a frame event.
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 100);
    return () => { try { unsub(); } catch { /* ignore */ } clearInterval(id); };
  }, [session]);

  const last = lastAtRef.current;
  const ageMs = last === null ? null : performance.now() - last;
  const live = ageMs !== null && ageMs <= staleMs;
  const state: FrameLivenessState = !session
    ? 'no-session'
    : last === null
      ? 'connecting'
      : live
        ? 'live'
        : 'stale';
  return { live, everReceived: last !== null, state, ageMs };
}
