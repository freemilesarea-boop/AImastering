// realtime-preview-store — metrics from the audio thread, kept OUT of the
// React render loop.
//
// This module exists because of a specific, previously fatal bug.  The old
// realtime integration turned every worklet message into a `setState`.  That
// re-render produced new callback identities, which invalidated the effect
// that owned the worklet, which detached and re-attached it — producing more
// messages.  The loop ran at audio rate and took the renderer process down,
// and realtime preview was hard-disabled in response.
//
// The fix is structural, not a matter of being careful:
//
//   • Messages land in a plain module-level object.  Writing costs nothing
//     and cannot re-render anything.
//   • React reads through `useSyncExternalStore`, and subscribers are only
//     notified on a fixed timer — never on message arrival.  However fast
//     the audio thread talks, the UI updates at `NOTIFY_HZ`.
//   • The snapshot is immutable and only replaced when a notify tick fires,
//     so `useSyncExternalStore` cannot tear or loop.
//
// The result is a hard ceiling on render rate that does not depend on any
// caller remembering to memoise anything.

/** Snapshot of the realtime chain's state, as of the last notify tick. */
export interface RealtimePreviewMetrics {
  /** Wall-clock ms of the last snapshot, or 0 when nothing has arrived. */
  updatedAt: number;
  /** True once the worklet has reported at least one processed block. */
  running: boolean;
  /** The worklet is passing audio through untouched. */
  bypass: boolean;

  avgProcessMs: number;
  peakProcessMs: number;
  blockPeriodMs: number;
  /** Blocks that overran their deadline — the number that matters for CPU. */
  xruns: number;
  /** Blocks the chain's safety layer had to replace. */
  safetyEvents: number;

  limiterGrDb: number;
  dynamicsGrDb: number;
  /** Per-band gain reduction of the multiband module, low → high. */
  multibandGrDb: readonly number[];
  /** De-esser gain reduction. */
  deessGrDb: number;
  /** Deepest hum notch currently applied. */
  dehumDepthDb: number;
  /** Measured long-term tonal curve, 32 log bands. */
  tonalCurveDb: readonly number[];
  /** Learned noise floor, folded onto 48 log bands.  Empty until learned. */
  denoiseProfileDb: readonly number[];

  latencySamples: number;
  monitorActive: boolean;
  /** Loudness the chain is adding, in dB (processed − dry). */
  loudnessDeltaDb: number;
  /** Gain the A/B level match is applying, in dB. */
  matchGainDb: number;
  dryLufs: number;
  wetLufs: number;
}

export const EMPTY_METRICS: RealtimePreviewMetrics = {
  updatedAt: 0,
  running: false,
  bypass: true,
  avgProcessMs: 0,
  peakProcessMs: 0,
  blockPeriodMs: 0,
  xruns: 0,
  safetyEvents: 0,
  limiterGrDb: 0,
  dynamicsGrDb: 0,
  multibandGrDb: [0, 0, 0, 0],
  deessGrDb: 0,
  dehumDepthDb: 0,
  tonalCurveDb: [],
  denoiseProfileDb: [],
  latencySamples: 0,
  monitorActive: false,
  loudnessDeltaDb: 0,
  matchGainDb: 0,
  dryLufs: Number.NEGATIVE_INFINITY,
  wetLufs: Number.NEGATIVE_INFINITY,
};

/** How often subscribers are notified.  Independent of message arrival. */
const NOTIFY_HZ = 10;

/** Latest values as written by the message handler.  Never read by React. */
let pending: RealtimePreviewMetrics = { ...EMPTY_METRICS };
/** The immutable snapshot React sees.  Replaced only on a notify tick. */
let snapshot: RealtimePreviewMetrics = EMPTY_METRICS;
/** True when `pending` has moved since the last notify. */
let dirty = false;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function startTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    // A fresh object each tick — `useSyncExternalStore` compares by
    // identity, so mutating in place would make it miss updates.
    snapshot = { ...pending };
    for (const l of listeners) l();
  }, 1000 / NOTIFY_HZ);
}

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Ingest a message from the worklet.
 *
 * Deliberately does NOT notify: it only marks the store dirty.  This is the
 * line that keeps the audio thread from driving React.
 */
export function ingestWorkletMetrics(msg: Record<string, unknown>): void {
  const n = (k: string, fallback = 0): number => {
    const v = msg[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const b = (k: string): boolean => msg[k] === true;
  const numArray = (v: unknown, fallback: readonly number[]): readonly number[] => (
    Array.isArray(v)
      ? (v as unknown[]).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : -140))
      : fallback
  );

  pending = {
    updatedAt: Date.now(),
    running: n('audioBlocks') > 0,
    bypass: b('bypass'),
    avgProcessMs: n('avgProcessMs'),
    peakProcessMs: n('peakProcessMs'),
    blockPeriodMs: n('blockPeriodMs'),
    xruns: n('xruns'),
    safetyEvents: n('safetyEvents'),
    limiterGrDb: n('limiterGrDb'),
    dynamicsGrDb: n('dynamicsGrDb'),
    multibandGrDb: Array.isArray(msg['multibandGrDb'])
      ? (msg['multibandGrDb'] as unknown[]).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
      : EMPTY_METRICS.multibandGrDb,
    deessGrDb: n('deessGrDb'),
    dehumDepthDb: n('dehumDepthDb'),
    tonalCurveDb: numArray(msg['tonalCurveDb'], EMPTY_METRICS.tonalCurveDb),
    denoiseProfileDb: numArray(msg['denoiseProfileDb'], EMPTY_METRICS.denoiseProfileDb),
    latencySamples: n('latencySamples'),
    monitorActive: b('monitorActive'),
    loudnessDeltaDb: n('loudnessDeltaDb'),
    matchGainDb: n('matchGainDb'),
    // -Infinity is a legitimate reading (silence), so it must survive the
    // `Number.isFinite` guard the other fields use.
    dryLufs: typeof msg['dryLufs'] === 'number' ? (msg['dryLufs'] as number) : Number.NEGATIVE_INFINITY,
    wetLufs: typeof msg['wetLufs'] === 'number' ? (msg['wetLufs'] as number) : Number.NEGATIVE_INFINITY,
  };
  dirty = true;
}

/** Clear the store — call when the preview detaches. */
export function resetPreviewMetrics(): void {
  pending = { ...EMPTY_METRICS };
  snapshot = EMPTY_METRICS;
  dirty = false;
  for (const l of listeners) l();
}

/** `useSyncExternalStore` subscribe. */
export function subscribePreviewMetrics(listener: () => void): () => void {
  listeners.add(listener);
  startTimer();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopTimer();
  };
}

/** `useSyncExternalStore` snapshot.  Stable between notify ticks. */
export function getPreviewMetrics(): RealtimePreviewMetrics {
  return snapshot;
}

/** Server snapshot (Storybook / SSR safety). */
export function getPreviewMetricsServer(): RealtimePreviewMetrics {
  return EMPTY_METRICS;
}
