// Gain-reduction meter model (OZONE-MODULE-NEXT-3).
//
// Display model for the Limiter / Maximizer gain reduction.  The value is
// the REAL `limiterGrDb` from the Rust limiter (via the worklet metrics) —
// this module never fabricates GR.  When the realtime preview isn't
// running, GR is `unavailable` (idle/empty), not faked.
//
// GR is expressed as a non-negative reduction magnitude in dB.

export type GrSource = 'realtime' | 'render-metrics' | 'unavailable';
export type GrState = 'unavailable' | 'idle' | 'active' | 'heavy' | 'clipping-risk';

export interface GrMeterModel {
  currentGrDb: number;
  peakGrDb: number;
  averageGrDb?: number;
  maxWindowGrDb?: number;
  state: GrState;
  source: GrSource;
  timestamp: number;
}

// Thresholds (dB of reduction).
export const GR_THRESHOLDS = { idle: 0.3, active: 3, heavy: 6 } as const;

export function classifyGr(grDb: number, available: boolean): GrState {
  if (!available) return 'unavailable';
  const g = Math.max(0, grDb);
  if (g < GR_THRESHOLDS.idle) return 'idle';
  if (g < GR_THRESHOLDS.active) return 'active';
  if (g < GR_THRESHOLDS.heavy) return 'heavy';
  return 'clipping-risk';
}

export interface BuildGrInput {
  grDb: number;
  available: boolean;
  source?: GrSource;
  peakGrDb?: number;
  averageGrDb?: number;
  maxWindowGrDb?: number;
}

export function buildGrMeterModel(input: BuildGrInput): GrMeterModel {
  const available = input.available;
  const current = available ? Math.max(0, input.grDb) : 0;
  const peak = available ? Math.max(current, input.peakGrDb ?? current) : 0;
  return {
    currentGrDb: current,
    peakGrDb: peak,
    ...(input.averageGrDb !== undefined ? { averageGrDb: Math.max(0, input.averageGrDb) } : {}),
    ...(input.maxWindowGrDb !== undefined ? { maxWindowGrDb: Math.max(0, input.maxWindowGrDb) } : {}),
    state: classifyGr(current, available),
    source: available ? (input.source ?? 'realtime') : 'unavailable',
    timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
  };
}

/** Decaying peak hold — `max(current, prev - decayDb)`.  Pure. */
export function decayPeak(prevPeak: number, current: number, decayDb: number): number {
  return Math.max(current, prevPeak - Math.max(0, decayDb));
}

/** Single-line label for logs / compact UI. */
export function describeGr(m: GrMeterModel): string {
  if (m.state === 'unavailable') return 'GR —';
  return `GR −${m.currentGrDb.toFixed(1)} dB`;
}
