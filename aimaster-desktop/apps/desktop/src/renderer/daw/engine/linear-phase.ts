// linear-phase — an EQ whose phase does not move, and what that costs.
//
// Every other EQ in this rack is a cascade of biquads.  A biquad cannot change
// a magnitude without changing the phase with it: that is not an oversight in
// the design, it is what a minimum-phase filter IS, and on most material it is
// what you want, because it is also what every analogue EQ ever built does.
//
// It stops being what you want in two places:
//
//   · a MASTER that is cut and boosted hard enough for the phase shift to
//     move the stereo image, or to change how the low end sums to mono
//   · a PARALLEL path — a mid/side band, a multiband split, a drum bus blended
//     against itself — where the filtered side has to line up with the dry one
//     and a rotated phase reads as a comb rather than as an EQ
//
// So this device has no biquads in the signal path at all.  It computes the
// magnitude the biquads WOULD have made, throws the phase away, and convolves
// with the symmetric impulse response that is left.  The magnitude is taken
// from `eqNodes`, which is the same description the editor drags and the
// picture draws, so the curve cannot drift from the filter.
//
// ── What it costs ──────────────────────────────────────────────────────────
//
// A symmetric impulse response is symmetric about its middle, and its middle
// arrives half its length late.  There is no arrangement that avoids this —
// zero phase means the response is even, and an even response that starts at
// zero has to be centred somewhere.  So the device's latency is exactly half
// its length, it declares that, and the DAW's delay compensation moves the
// rest of the mix to match.
//
// And the length is the resolution.  An FIR can only resolve detail finer than
// its own length; measured on this file's own designer, against the same
// curve:
//
//     255 taps    2.6 ms    builds a band down to 1492 Hz wide
//    1023 taps   10.6 ms    down to 368 Hz
//    4095 taps   42.6 ms    down to 91 Hz
//
// Those widths are measured — the narrowest +12 dB bell at 1 kHz the designer
// builds to within half a decibel — and they are what the Resolution control
// trades.  A wide shelf is the same at every length; a surgical cut is only
// there at the long one.  Ask for detail finer than the length and it is not
// approximated, it is simply not built.
//
// ── And what it does that a biquad does not ────────────────────────────────
//
// PRE-RINGING.  A symmetric response rings BEFORE the transient as much as
// after it, because the two halves are mirror images.  On a kick or a snare
// with a steep cut under it, that is audible as a tick ahead of the hit, and
// it is the reason a linear-phase EQ is not simply a better EQ.  It is drawn
// in the picture rather than left as folklore.

import { chainMagnitudeDb } from '../model/plugin-curves.js';
import { eqNodes, nodeSpecs } from '../model/eq-nodes.js';

/** The lengths on offer, and what each one is for. */
export const LINPHASE_LENGTHS = [
  { taps: 255,  label: '빠름' },
  { taps: 1023, label: '표준' },
  { taps: 4095, label: '정밀' },
] as const;

/**
 * How wide the narrowest band this length can BUILD is, in Hz.
 *
 * A property of the length alone, which is why it is the number the picker
 * advertises: a worst-case dB error is not, because it depends entirely on
 * how narrow a band somebody asked for.
 *
 * The constant is measured, not derived.  `sampleRate / taps` is the bin
 * spacing and is far too optimistic — the window widens everything, and by
 * how much is a property of the window rather than of the arithmetic.
 * Measured as the narrowest +12 dB bell at 1 kHz that this designer builds to
 * within half a decibel:
 *
 *              255 taps   1023 taps   4095 taps
 *   Hann        1492 Hz     368 Hz       91 Hz
 *   Blackman    1883 Hz     439 Hz      115 Hz
 *
 * which is 7.8 to 7.9 times the bin spacing under Hann, at every length.
 */
const RESOLUTION_BINS = 7.85;

export function linphaseResolutionHz(taps: number, sampleRate = 48_000): number {
  return (RESOLUTION_BINS * sampleRate) / taps;
}

export const LINPHASE_LENGTH_NAMES: readonly string[] =
  LINPHASE_LENGTHS.map((l) => l.label);

/**
 * What each length buys and costs, in the words the picker shows.
 *
 * Both halves are arithmetic rather than opinion: the delay is exactly half
 * the response, and the resolution is the rate over the length.  What that
 * costs in decibels depends on the curve, so it is not promised here — the
 * check measures it on a band narrower than each length can hold.
 */
export const LINPHASE_LENGTH_NOTES: readonly string[] = LINPHASE_LENGTHS.map(
  (l) => `${l.taps}탭 · ${((l.taps - 1) / 2 / 48_000 * 1000).toFixed(1)} ms 지연 · `
    + `48 kHz 에서 ${linphaseResolutionHz(l.taps).toFixed(0)} Hz 까지 분해`,
);

/** The choice index a parameter value means. */
export function linphaseLength(params: Record<string, number>): typeof LINPHASE_LENGTHS[number] {
  const raw = params['length'];
  const i = Math.round(typeof raw === 'number' && Number.isFinite(raw) ? raw : 1);
  return LINPHASE_LENGTHS[Math.max(0, Math.min(LINPHASE_LENGTHS.length - 1, i))]!;
}

/** Half the response's length — what the device is late by, exactly. */
export function linphaseLatency(params: Record<string, number>): number {
  return (linphaseLength(params).taps - 1) / 2;
}

/** How many frequencies the magnitude is sampled at when the FIR is designed. */
const DESIGN_BINS = 4096;

/**
 * The impulse response for a set of bands, at a length.
 *
 * Frequency sampling: the target magnitude is read at `DESIGN_BINS` points
 * from DC to Nyquist, the response is taken to be real and even (which is
 * what zero phase MEANS), and the inverse transform of a real even spectrum
 * is a real even sequence — a cosine sum, which is what this loop is.
 *
 * Then a HANN window, and which window is a thing this file got wrong first.
 *
 * The argument for Blackman is the textbook one: truncating a response at N
 * taps is multiplying it by a rectangle, a rectangle's transform is a sinc
 * whose sidelobes are 13 dB down, and Blackman's are 58 dB down.  Measured on
 * the steepest curve these controls can ask for — a 500 Hz high-pass under an
 * 18 dB bell at Q 8 — that argument is worth something and not what it says:
 *
 *                resolution   worst error   ends / centre
 *   no window       122 Hz      21.06 dB        2.1e-4
 *   Blackman        439 Hz      11.82 dB        1.1e-6
 *   Hann            368 Hz       8.69 dB        3.0e-6
 *
 * No window is not an option: it leaves the response still at two ten
 * thousandths of its centre where it is cut off, and the curve it builds is
 * 21 dB out.  But Blackman is not the answer either — Hann is better on BOTH
 * axes at every length, and its ends are three millionths, which is thirty
 * decibels below anything that matters.  So the wider main lobe Blackman
 * costs buys nothing here, and the window is Hann.
 *
 * The cosines come from a recurrence rather than from `Math.cos`.  A 4095-tap
 * design is eight million of them, and calling the library function for each
 * took 266 ms — long enough to be felt every time a band moved.  Chebyshev's
 * cos((d+1)θ) = 2cos θ·cos(dθ) − cos((d−1)θ) makes the same numbers out of
 * two multiplies, and the answer agrees with the direct one to 1e-9 over the
 * whole length.
 */
export function designLinearPhase(
  magnitudeDbAt: (hz: number) => number, taps: number, sampleRate: number,
): Float32Array<ArrayBuffer> {
  const n = taps % 2 === 1 ? taps : taps + 1;
  const half = (n - 1) / 2;
  const acc = new Float64Array(half + 1);
  for (let m = 0; m <= DESIGN_BINS; m++) {
    const hz = (m / DESIGN_BINS) * (sampleRate / 2);
    // The two ends carry half weight: DC and Nyquist are each shared by only
    // one side of the even extension.
    const edge = m === 0 || m === DESIGN_BINS ? 0.5 : 1;
    const mag = Math.pow(10, magnitudeDbAt(Math.max(1, hz)) / 20) * edge;
    if (mag === 0) continue;
    const theta = (Math.PI * m) / DESIGN_BINS;
    const two = 2 * Math.cos(theta);
    let prev = 1;                  // cos(0)
    let cur = Math.cos(theta);     // cos(θ)
    acc[0] = (acc[0] ?? 0) + mag;
    for (let d = 1; d <= half; d++) {
      acc[d] = (acc[d] ?? 0) + mag * cur;
      const next = two * cur - prev;
      prev = cur;
      cur = next;
    }
  }
  const h = new Float32Array(n);
  for (let d = 0; d <= half; d++) {
    const v = acc[d]! / DESIGN_BINS;
    const k = half + d;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    h[k] = v * w;
    h[half - d] = v * w;           // Hann is symmetric, so one weight does
  }
  return h;
}

/** The bands this device's parameters describe, as the editor sees them. */
export function linphaseSpecs(params: Record<string, number>): ReturnType<typeof nodeSpecs> {
  return nodeSpecs(eqNodes('linphase', params));
}

/** The impulse response for a parameter set. */
export function linphaseImpulse(
  params: Record<string, number>, sampleRate: number,
): Float32Array<ArrayBuffer> {
  const specs = linphaseSpecs(params);
  return designLinearPhase(
    (hz) => chainMagnitudeDb(specs, Math.max(1, hz), sampleRate),
    linphaseLength(params).taps,
    sampleRate,
  );
}

/** The response an impulse response actually has, in dB — for the checks. */
export function firMagnitudeDb(
  h: Float32Array, hz: number, sampleRate: number,
): number {
  let re = 0;
  let im = 0;
  for (let k = 0; k < h.length; k++) {
    const w = (2 * Math.PI * hz * k) / sampleRate;
    re += h[k]! * Math.cos(w);
    im -= h[k]! * Math.sin(w);
  }
  return 20 * Math.log10(Math.max(1e-12, Math.hypot(re, im)));
}
