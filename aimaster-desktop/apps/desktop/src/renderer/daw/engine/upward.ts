// Upward compression — the arithmetic, in one place.
//
// Every other dynamics device in this app pushes DOWN: `comp`, `mbcomp` and
// `limiter` all start their ratio at 1:1 and go up, `gate` and `dyneq` only
// ever cut.  Nothing lifts the quiet parts, which is half of what dynamics
// control is, and it is the half that makes a quiet verse sit under a loud
// chorus without anybody riding a fader.
//
// The curve lives here rather than in the plugin because the plugin window
// draws it, and a picture built from a second copy of the maths is a picture
// that can disagree with the sound.

import { dbToGain } from './plugin-kit.js';

/**
 * Amplitude → decibels, with no epsilon under it.
 *
 * Zero comes back as −Infinity on purpose, and `upwardGainDb` answers unity
 * for it: silence is the one level an upward compressor must leave alone, and
 * a floor of 1e-12 here would instead hand it whatever the curve says about
 * −240 dBFS.
 */
const gainToDb = (g: number): number => 20 * Math.log10(Math.abs(g));

/**
 * How far below the floor the lift has faded away completely.
 *
 * Not a knob.  A floor with a corner on it is a floor that chatters — the
 * detector crosses it on the noise itself and the gain jumps — and a knee
 * wide enough to stop that is wide enough that a second control over it
 * would only ever be set wrong.  Twelve decibels is two doublings of
 * amplitude, which is far more than a noise floor wanders.
 */
export const UPWARD_KNEE_DB = 12;

/**
 * Points in the transfer curve handed to the WaveShaper.
 *
 * Bigger than any other curve in the engine, and for a reason that is
 * particular to upward compression: a WaveShaper's curve is indexed by
 * AMPLITUDE, linearly, while this device does its work at −20 to −60 dBFS
 * where linear indexing is sparse.  −60 dB is an amplitude of 0.001, which in
 * a 2048-point curve is index 1.
 *
 * Measured, worst error against the exact curve across −70…0 dBFS:
 *
 *      2048   1.115 dB        32768   0.061 dB
 *      8192   0.673 dB       131072   0.005 dB
 *
 * 32768 buys the last decibel of that for 128 KiB, and 131072 buys almost
 * nothing more for four times as much.  The error that remains sits at
 * −66 dBFS, inside the floor's knee, where the lift is a decibel or two and
 * fading.
 */
export const UPWARD_CURVE_POINTS = 32768;

/** A soft minimum, so the depth ceiling has no corner for the curve to miss. */
function softMin(value: number, ceiling: number, k = 2): number {
  const z = k * (ceiling - value);
  return ceiling - (z > 30 ? ceiling - value : Math.log1p(Math.exp(z)) / k);
}

/**
 * How much gain a signal sitting at `levelDb` is given, in decibels.
 *
 * The textbook curve, with two things bolted to it that the textbook leaves
 * out and that decide whether the device is usable:
 *
 *   depth — the most it will ever add.  Without it the lift grows without
 *           bound as the signal falls, and the first thing it finds on the
 *           way down is the room.
 *   floor — where it lets go.  Depth alone does not save you: a −60 dB hiss
 *           under a −20 dB threshold is still handed the whole of the depth.
 *           Below the floor the lift fades out over `UPWARD_KNEE_DB`.
 *
 * Returns 0 (unity) at and above the threshold, and 0 again below the floor's
 * knee — the two ends where an upward compressor must do nothing at all.
 */
export function upwardGainDb(
  levelDb: number, thresholdDb: number, ratio: number,
  depthDb: number, floorDb: number,
): number {
  if (!Number.isFinite(levelDb) || levelDb >= thresholdDb) return 0;
  const raw = (thresholdDb - levelDb) * (1 - 1 / Math.max(1, ratio));
  const capped = Math.max(0, softMin(raw, Math.max(0, depthDb)));
  // The floor is never allowed above the threshold: a device whose two ends
  // have crossed over has no region left to work in, and silently doing
  // nothing is worse than being obviously wrong.
  const floor = Math.min(floorDb, thresholdDb - UPWARD_KNEE_DB);
  const t = Math.max(0, Math.min(1, (levelDb - (floor - UPWARD_KNEE_DB)) / UPWARD_KNEE_DB));
  return capped * (t * t * (3 - 2 * t));
}

/**
 * Where a signal at `inputDb` comes OUT, in decibels — the line a transfer
 * plot draws.
 */
export function upwardOutputDb(
  inputDb: number, thresholdDb: number, ratio: number,
  depthDb: number, floorDb: number,
): number {
  return inputDb + upwardGainDb(inputDb, thresholdDb, ratio, depthDb, floorDb);
}

/**
 * The detector's envelope → the VCA's gain, as a WaveShaper curve.
 *
 * Only the upper half is ever reached — the input is a rectified envelope —
 * and the lower half mirrors it so the shaper stays well defined.
 */
export function upwardCurve(
  thresholdDb: number, ratio: number, depthDb: number, floorDb: number,
): Float32Array<ArrayBuffer> {
  const n = UPWARD_CURVE_POINTS;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.abs((i / (n - 1)) * 2 - 1);
    curve[i] = dbToGain(upwardGainDb(gainToDb(env), thresholdDb, ratio, depthDb, floorDb));
  }
  return curve;
}

/**
 * The loudest the device can get, so the output trim has something honest to
 * be measured against.
 */
export function upwardPeakGainDb(
  thresholdDb: number, ratio: number, depthDb: number, floorDb: number,
): number {
  let most = 0;
  for (let db = -90; db <= 0; db += 0.1) {
    most = Math.max(most, upwardGainDb(db, thresholdDb, ratio, depthDb, floorDb));
  }
  return most;
}
