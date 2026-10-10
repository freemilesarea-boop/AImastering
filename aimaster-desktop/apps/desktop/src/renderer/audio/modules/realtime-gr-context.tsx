// Realtime GR context (OZONE-MODULE-NEXT-3).
//
// Bridges the realtime-mastering metrics down to the Limiter slide-over
// panel + any GR meter, so they can show the REAL limiter gain reduction.
// Defaults to "unavailable" outside a provider — never fakes data.
//
// The metrics were owned by ProductPageProductionInner, which went with
// ProductPage.  Nothing provides this context now, and nothing in the app
// asks for it either: both consumers — `LimiterParameterPanel` and
// `DynamicsParameterPanel` — are themselves reached only by their
// stories.  So the "unavailable" default is what Storybook sees, and the
// reason it is a blank meter rather than an invented number.

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

// Dynamics (compressor) GR — separate channel from the limiter so the
// Dynamics panel shows the REAL compressor gain reduction, never faked.
const RealtimeDynamicsGrContext = React.createContext<RealtimeGr>(DEFAULT);

export function useRealtimeDynamicsGr(): RealtimeGr {
  return React.useContext(RealtimeDynamicsGrContext);
}
