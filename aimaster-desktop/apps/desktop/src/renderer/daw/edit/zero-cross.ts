// Cutting where the waveform is already at zero.
//
// A cut in the middle of a waveform leaves a step: the signal is at −0.4, the
// next sample is whatever the neighbouring clip starts at, and the speaker
// gets a discontinuity.  That is the *click* everybody hears after their first
// edit and nobody can find the cause of, because the edit looks right — the
// waveform drawing at timeline zoom is far too coarse to show a single-sample
// step.
//
// The fix is old and exact: move the cut to the nearest sample where the
// signal crosses zero.  At 48 kHz the move is well under a millisecond, which
// is inaudible as timing and completely removes the step.
//
// Two rules keep it from doing harm.
//
// IT ONLY EVER MOVES A LITTLE.  The search is bounded (`MAX_SEARCH_SEC`).  A
// quiet passage can be thousands of samples from a crossing, and dragging an
// edit 40 ms to find one would be a worse edit than the click.  No crossing
// inside the window means the cut stays exactly where the user put it.
//
// IT PREFERS RISING CROSSINGS.  Two clips joined at rising crossings continue
// each other's phase; joining a rising edge to a falling one still steps,
// just from a smaller number.  When both are in range the rising one wins.
//
// Pure over a sample array, so it is tested against synthesised tones where
// every crossing is known by arithmetic.

/** How far a cut may be moved to find a crossing.  ~5 ms at 48 kHz. */
export const MAX_SEARCH_SEC = 0.005;

export interface ZeroCrossOptions {
  maxSearchSec: number;
  /** Prefer a crossing where the signal is going up. */
  preferRising: boolean;
}

export const DEFAULT_ZERO_CROSS: ZeroCrossOptions = {
  maxSearchSec: MAX_SEARCH_SEC,
  preferRising: true,
};

const isRising = (a: number, b: number): boolean => a <= 0 && b > 0;
const isFalling = (a: number, b: number): boolean => a >= 0 && b < 0;

/**
 * The sample index nearest `atSample` where the signal crosses zero.
 *
 * Returns `atSample` unchanged when there is none inside the window — which is
 * the honest answer for a fade tail or a silent passage, and better than a
 * long jump to the nearest one.
 */
export function nearestZeroCrossing(
  samples: ArrayLike<number>,
  atSample: number,
  sampleRate: number,
  options: ZeroCrossOptions = DEFAULT_ZERO_CROSS,
): number {
  const n = samples.length;
  if (n < 2 || !Number.isFinite(atSample)) return atSample;
  const centre = Math.max(0, Math.min(n - 1, Math.round(atSample)));
  const window = Math.max(1, Math.round(options.maxSearchSec * sampleRate));

  let bestRising = -1;
  let bestAny = -1;

  // Outward from the centre, so the first hit at a given distance wins and
  // ties resolve toward the earlier sample.
  for (let d = 0; d <= window; d++) {
    for (const i of d === 0 ? [centre] : [centre - d, centre + d]) {
      if (i < 0 || i >= n - 1) continue;
      const a = samples[i] ?? 0;
      const b = samples[i + 1] ?? 0;
      if (isRising(a, b)) {
        if (bestRising < 0) bestRising = i;
        if (bestAny < 0) bestAny = i;
      } else if (isFalling(a, b)) {
        if (bestAny < 0) bestAny = i;
      }
    }
    if (options.preferRising && bestRising >= 0) return bestRising;
    if (!options.preferRising && bestAny >= 0) return bestAny;
  }
  return bestAny >= 0 ? bestAny : centre;
}

/** The same question in seconds, which is what the timeline speaks. */
export function snapSecToZero(
  samples: ArrayLike<number>,
  timeSec: number,
  sampleRate: number,
  options: ZeroCrossOptions = DEFAULT_ZERO_CROSS,
): number {
  if (!(sampleRate > 0)) return timeSec;
  const snapped = nearestZeroCrossing(samples, timeSec * sampleRate, sampleRate, options);
  return snapped / sampleRate;
}

/** How far a snap moved the cut, in milliseconds — for the status line. */
export function snapDistanceMs(fromSec: number, toSec: number): number {
  return (toSec - fromSec) * 1000;
}
