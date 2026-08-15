// spectrum-axis — one frequency ruler for every display that has one.
//
// The EQ curve, the noise profile, the de-esser band and the reference
// match all draw on a log-frequency axis. If each owned its own tick list
// and its own padding, a 200 Hz feature would sit at a different x in each
// panel, and comparing two of them by eye — which is the entire reason to
// draw them the same way — would quietly stop working.

export const AXIS_MIN_HZ = 20;
export const AXIS_MAX_HZ = 20_000;

/** Decade and half-decade points: brighter line, and a number. */
export const AXIS_MAJOR_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];
/** Everything between: a faint line only. */
export const AXIS_MINOR_HZ = [
  30, 40, 60, 70, 80, 90,
  300, 400, 600, 700, 800, 900,
  3000, 4000, 6000, 7000, 8000, 9000,
  15_000,
];

export interface AxisPad { left: number; right: number; top: number; bottom: number }

/** The padding the EQ graph uses; shared so panels line up. */
export const AXIS_PAD: AxisPad = { left: 10, right: 30, top: 12, bottom: 20 };

export function hzToX(hz: number, width: number, pad: AxisPad = AXIS_PAD): number {
  const t = Math.log(Math.max(hz, AXIS_MIN_HZ) / AXIS_MIN_HZ) / Math.log(AXIS_MAX_HZ / AXIS_MIN_HZ);
  return pad.left + t * (width - pad.left - pad.right);
}

export function xToHz(x: number, width: number, pad: AxisPad = AXIS_PAD): number {
  const t = (x - pad.left) / Math.max(1, width - pad.left - pad.right);
  return AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, Math.min(1, Math.max(0, t)));
}

/** Ruler formatting — terse, because the tick already says where it is. */
export function fmtAxisHz(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

/** Readout formatting — keeps a decimal, because 1.2k and 1.9k differ. */
export function fmtHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 0 : 1)}k` : `${Math.round(hz)}`;
}

/**
 * Centre frequency of one band on an N-band log grid spanning the axis.
 * Used by every folded curve — the chain's 32-band tonal curve, the
 * worklet's 48-band noise profile — so they land on the same ruler.
 */
export function logBandHz(index: number, bands: number): number {
  const t = bands <= 1 ? 0 : index / (bands - 1);
  return AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, t);
}
