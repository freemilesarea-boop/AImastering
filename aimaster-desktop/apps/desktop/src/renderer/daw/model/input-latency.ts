// input-latency.ts — putting the take back where it was played.
//
// A recorded overdub is ALWAYS late.  The sound leaves the instrument, goes
// through the interface's converters and driver buffer to reach the app, and
// meanwhile what the player was listening to had already left the app through
// the same chain in the other direction.  Nothing in the recording path was
// compensating for either half, so every take landed late by the round trip —
// and the error is consistent, so it compounds: a drum overdub against a late
// guitar against a late scratch vocal ends up a comfortable distance from
// where anybody played.
//
// The correction is a subtraction, and the whole difficulty is knowing what to
// subtract.  Three sources, in descending order of trustworthiness:
//
//   1. MEASURED — the user plays a loopback (output cabled back to input, or a
//      speaker and a mic) and the app finds the delay in the recording.  This
//      is the only number that includes everything, converters included.
//   2. REPORTED — `AudioContext.baseLatency` + `outputLatency`.  Chromium
//      reports these honestly for the output side and for its own processing,
//      but they do NOT include the interface's own input converter delay, so
//      this under-compensates on real hardware.
//   3. NOTHING — what the app did before, which is not a choice, it is the
//      absence of one.
//
// The default is (2), because it is free and always better than (3), and the
// panel says plainly that it is an estimate until somebody calibrates.

/** Where a compensation number came from — shown so nobody trusts an estimate. */
export type LatencySource = 'measured' | 'reported' | 'none';

export const LATENCY_LABELS: Record<LatencySource, string> = {
  measured: '측정됨',
  reported: '추정 (드라이버 보고값)',
  none:     '보정 없음',
};

/**
 * A round trip longer than this is a mistake, not an interface.
 *
 * Half a second is far beyond any real device — a measurement that says more
 * than this found a reflection, a second click, or noise, and applying it
 * would move the take somewhere it never was.
 */
export const MAX_LATENCY_SEC = 0.5;

export interface LatencyConfig {
  /** Round trip, in seconds. */
  seconds: number;
  source: LatencySource;
  /** Set false to keep the number but stop applying it — for A/B. */
  enabled: boolean;
}

export const NO_LATENCY: LatencyConfig = { seconds: 0, source: 'none', enabled: true };

export function clampLatency(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(MAX_LATENCY_SEC, seconds);
}

/** What the browser is willing to say, in seconds.  Zero when it says nothing. */
export function reportedLatency(ctx: {
  baseLatency?: number; outputLatency?: number;
} | null | undefined): number {
  if (!ctx) return 0;
  // `baseLatency` is the context's own processing delay; `outputLatency` is the
  // time from the graph to the speaker.  Both are output-side, so this is half
  // the round trip plus the app's own — an underestimate, and named as one.
  const base = Number.isFinite(ctx.baseLatency) ? (ctx.baseLatency as number) : 0;
  const out = Number.isFinite(ctx.outputLatency) ? (ctx.outputLatency as number) : 0;
  return clampLatency(base + out);
}

export function latencyFromContext(ctx: Parameters<typeof reportedLatency>[0]): LatencyConfig {
  const seconds = reportedLatency(ctx);
  return seconds > 0
    ? { seconds, source: 'reported', enabled: true }
    : { ...NO_LATENCY };
}

/** The correction actually applied — zero when disabled or unknown. */
export function activeLatency(config: LatencyConfig): number {
  return config.enabled ? clampLatency(config.seconds) : 0;
}

/**
 * Shift a capture back by the round trip.
 *
 * Applied to the CAPTURE side, not the timeline side.  Moving the clip's
 * `startSec` earlier would push it before the record point — and before zero
 * for a take that starts at the top of the song, where there is no room.
 * Reading FURTHER INTO the capture instead keeps every timeline position
 * exactly where the transport put it, and the samples that arrive late are
 * simply the ones that get used.
 */
export function compensateOffset(offsetSec: number, latencySec: number): number {
  return Math.max(0, offsetSec + clampLatency(latencySec));
}

/**
 * How much of the take the capture did not reach.
 *
 * The correction reads FURTHER INTO the capture, and at the front that is
 * always possible — the pre-roll guarantees there is audio before the record
 * point.  The cost lands at the other end: moving the read point later by the
 * round trip means the last `latencySec` of the performance is only there if
 * the capture kept running past the stop.  It usually does, because the
 * recorder is stopped after the transport; when it does not, the take is short
 * and the caller says so rather than quietly handing back a clipped one.
 *
 * All three arguments are seconds INTO THE CAPTURE, not timeline positions.
 */
export function captureShortfall(
  readFromSec: number, wantedSec: number, capturedSec: number,
): number {
  const end = Math.max(0, readFromSec) + Math.max(0, wantedSec);
  return Math.max(0, end - Math.max(0, capturedSec));
}

// ── Calibration ─────────────────────────────────────────────────────────────

/**
 * Find the round trip in a loopback recording.
 *
 * The app plays a click at a known moment and records whatever comes back; the
 * delay between the two IS the round trip, converters and all.  The click is
 * short and loud, so the measurement is the first sample that crosses a
 * threshold well above the room — no correlation needed, and a threshold is
 * something a person can reason about when it goes wrong.
 *
 * Returns null when nothing crossed, which is the honest answer for "the cable
 * is not plugged in" and much better than a confident zero.
 */
export function measureLoopback(
  captured: Float32Array, sampleRate: number,
  { playedAtSec = 0, thresholdDb = -30, searchSec = MAX_LATENCY_SEC } = {},
): number | null {
  if (sampleRate <= 0 || captured.length === 0) return null;
  const threshold = Math.pow(10, thresholdDb / 20);
  const from = Math.max(0, Math.floor(playedAtSec * sampleRate));
  const to = Math.min(captured.length, from + Math.ceil(searchSec * sampleRate));

  // A noise floor above the threshold means the level is wrong, not that the
  // click arrived at sample zero.  Checked first so a hot input reports
  // "cannot tell" rather than "zero latency".
  const quietTo = Math.min(to, from + Math.floor(0.002 * sampleRate));
  let floor = 0;
  for (let i = from; i < quietTo; i++) floor = Math.max(floor, Math.abs(captured[i] as number));
  if (floor >= threshold) return null;

  for (let i = from; i < to; i++) {
    if (Math.abs(captured[i] as number) >= threshold) {
      const seconds = (i - from) / sampleRate;
      return seconds <= MAX_LATENCY_SEC ? seconds : null;
    }
  }
  return null;
}

/**
 * How far two measurements of the same click may differ and still be it.
 *
 * The capture's zero is only known to a render block, so two runs of an
 * identical click land a block or so apart — 5 ms covers that at every rate
 * this app runs at, and is far tighter than the spacing of anything that is
 * not the click.
 */
export const CALIBRATION_AGREE_SEC = 0.005;

/**
 * Reconcile repeated measurements of the same click.
 *
 * A threshold detector finds the first thing above the threshold, and with no
 * cable plugged in that is whatever the room, the interface, or a fake device
 * happened to do — which is how a calibration returns a confident 239 ms for
 * an input that is not connected to anything.  Two identical clicks answer
 * that: the round trip does not change between them, and an unrelated
 * transient does not repeat at the same distance from OUR click.  Anything
 * that disagrees is refused rather than averaged.
 */
export function agreeLoopback(measurements: readonly (number | null)[]): number | null {
  if (measurements.length === 0) return null;
  const found: number[] = [];
  for (const m of measurements) {
    if (m === null) return null;
    found.push(m);
  }
  const min = Math.min(...found);
  const max = Math.max(...found);
  if (max - min > CALIBRATION_AGREE_SEC) return null;
  return found.reduce((a, b) => a + b, 0) / found.length;
}

export function describeLatency(config: LatencyConfig): string {
  const ms = (clampLatency(config.seconds) * 1000).toFixed(1);
  if (!config.enabled) return `${ms} ms — 보정 꺼짐`;
  if (config.source === 'none') return '보정 없음 — 녹음이 친 것보다 늦게 들어옵니다';
  if (config.source === 'reported') {
    return `${ms} ms — 드라이버 보고값 (인터페이스 입력단 지연은 빠져 있어 보통 이보다 깁니다)`;
  }
  return `${ms} ms — 루프백으로 측정됨`;
}
