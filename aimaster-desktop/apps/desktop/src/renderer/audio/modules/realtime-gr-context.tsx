// Realtime GR context (OZONE-MODULE-NEXT-3).
//
// Bridges the realtime-mastering metrics (owned by ProductPageProductionInner)
// down to the Limiter slide-over panel + any GR meter, so they can show the
// REAL limiter gain reduction.  Defaults to "unavailable" outside a
// provider (e.g. storybook) — never fakes data.

import React from 'react';
import type { GrSource } from './gr-meter-model.js';

export interface RealtimeGr {
  grDb: number;
  peakDb: number;
  available: boolean;
  source: GrSource;
}

const DEFAULT: RealtimeGr = { grDb: 0, peakDb: 0, available: false, source: 'unavailable' };

const RealtimeGrContext = React.createContext<RealtimeGr>(DEFAULT);

export function useRealtimeGr(): RealtimeGr {
  return React.useContext(RealtimeGrContext);
}

export function RealtimeGrProvider({ value, children }: { value: RealtimeGr; children: React.ReactNode }) {
  return <RealtimeGrContext.Provider value={value}>{children}</RealtimeGrContext.Provider>;
}

// Dynamics (compressor) GR — separate channel from the limiter so the
// Dynamics panel shows the REAL compressor gain reduction, never faked.
const RealtimeDynamicsGrContext = React.createContext<RealtimeGr>(DEFAULT);

export function useRealtimeDynamicsGr(): RealtimeGr {
  return React.useContext(RealtimeDynamicsGrContext);
}

export function RealtimeDynamicsGrProvider({ value, children }: { value: RealtimeGr; children: React.ReactNode }) {
  return <RealtimeDynamicsGrContext.Provider value={value}>{children}</RealtimeDynamicsGrContext.Provider>;
}
