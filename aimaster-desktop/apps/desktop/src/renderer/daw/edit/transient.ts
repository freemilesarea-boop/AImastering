// Tab to Transient — onset detection plus the navigation it feeds.
//
// Pro Tools' Tab key jumps the play head to the next clip boundary; with
// "Tab to Transient" armed it jumps to the next attack inside the audio.
// That single key is most of what makes editing fast, so the detector has to
// be both quick (it runs on decoded peaks, not on an FFT) and stable (no
// double-triggering on one hit).
//
// Algorithm — energy-flux onset detection:
//   1. Rectified envelope at a fixed hop (default ~2.7 ms at 48 k).
//   2. A slow moving baseline of that envelope (~60 ms).
//   3. An onset is a local maximum that rises a set ratio above the baseline
//      and is at least `minSpacingSec` after the previous onset.
//
// Everything is pure and array-based so it is testable with synthetic
// impulse trains.

export interface TransientOptions {
  /** Envelope hop in samples. */
  hopSamples: number;
  /** Baseline window in seconds. */
  baselineSec: number;
  /** How far above the baseline the envelope must rise (linear ratio). */
  threshold: number;
  /** Minimum gap between two detected transients. */
  minSpacingSec: number;
  /** Envelope floor — silence never produces onsets. */
  floor: number;
}

export const DEFAULT_TRANSIENT_OPTIONS: TransientOptions = {
  hopSamples: 128,
  baselineSec: 0.06,
  threshold: 1.8,
  minSpacingSec: 0.03,
  floor: 1e-4,
};

/** Rectified peak envelope, one value per hop. */
export function peakEnvelope(samples: ArrayLike<number>, hopSamples: number): Float32Array {
  const hop = Math.max(1, Math.floor(hopSamples));
  const count = Math.ceil(samples.length / hop);
  const env = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const from = i * hop;
    const to = Math.min(samples.length, from + hop);
    let peak = 0;
    for (let j = from; j < to; j++) {
      const v = Math.abs(samples[j] ?? 0);
      if (v > peak) peak = v;
    }
    env[i] = peak;
  }
  return env;
}

/**
 * Detect transient times (seconds from the start of `samples`).
 * `sampleRate` is the rate of the incoming samples, not of the session.
 */
export function detectTransients(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: Partial<TransientOptions> = {},
): number[] {
  const opt = { ...DEFAULT_TRANSIENT_OPTIONS, ...options };
  if (sampleRate <= 0 || samples.length === 0) return [];

  const env = peakEnvelope(samples, opt.hopSamples);
  const hopSec = opt.hopSamples / sampleRate;
  const baselineHops = Math.max(1, Math.round(opt.baselineSec / hopSec));
  const minSpacingHops = Math.max(1, Math.round(opt.minSpacingSec / hopSec));

  // Trailing moving average of what came BEFORE each hop.  Excluding the
  // current hop matters: an attack must be compared with the level it rose
  // from, otherwise it partly masks itself and the first hit of a file — where
  // there is no history at all — never triggers.
  const baseline = new Float32Array(env.length);
  let acc = 0;
  let count = 0;
  for (let i = 0; i < env.length; i++) {
    baseline[i] = count > 0 ? acc / count : 0;
    acc += env[i] ?? 0;
    count += 1;
    if (count > baselineHops) { acc -= env[i - baselineHops] ?? 0; count = baselineHops; }
  }

  const onsets: number[] = [];
  let lastHop = -Infinity;
  for (let i = 0; i < env.length; i++) {
    const v = env[i] ?? 0;
    if (v < opt.floor) continue;
    const base = Math.max(baseline[i] ?? 0, opt.floor);
    if (v < base * opt.threshold) continue;
    // Local maximum — the peak of the attack, not its rising flank.
    if (v < (env[i - 1] ?? 0) || v < (env[i + 1] ?? 0)) continue;
    if (i - lastHop < minSpacingHops) continue;
    lastHop = i;
    onsets.push(i * hopSec);
  }
  return onsets;
}

// ── Navigation ────────────────────────────────────────────────────────────────

const EPS = 1e-6;

/** First value strictly greater than `from`, or null at the end. */
export function nextAfter(sorted: readonly number[], from: number): number | null {
  for (const t of sorted) if (t > from + EPS) return t;
  return null;
}

/** Last value strictly less than `from`, or null at the start. */
export function prevBefore(sorted: readonly number[], from: number): number | null {
  let found: number | null = null;
  for (const t of sorted) {
    if (t < from - EPS) found = t;
    else break;
  }
  return found;
}

/** Merge boundary and transient marks into one sorted, de-duplicated list. */
export function mergeMarks(...lists: ReadonlyArray<readonly number[]>): number[] {
  const all: number[] = [];
  for (const l of lists) all.push(...l);
  all.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) {
    const last = out[out.length - 1];
    if (last === undefined || t - last > EPS) out.push(t);
  }
  return out;
}
