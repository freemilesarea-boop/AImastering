// What a plugin is doing, as a curve.
//
// A knob with a number next to it tells you the value.  A curve tells you the
// SOUND: where the EQ actually sits between the shelf and the peak, how hard
// the compressor is squeezing above the knee.  That is the difference between
// setting a plugin and hearing one, and it is the whole reason a plugin window
// is a window and not a list of sliders.
//
// The maths here is the maths the engine runs, not a decorative approximation:
// these are the Audio EQ Cookbook transfer functions that `BiquadFilterNode`
// implements, evaluated at the same coefficients the graph is using.  If the
// picture and the sound disagree, one of them is lying, and it must not be the
// picture.
//
// Pure, so it is tested without an AudioContext.

export interface BiquadSpec {
  type: 'lowshelf' | 'highshelf' | 'peaking' | 'highpass' | 'lowpass';
  freq: number;
  /** dB, for shelves and peaks. */
  gain: number;
  /**
   * Cookbook Q for peaks and shelves; RESONANCE IN DECIBELS for lowpass and
   * highpass, which is how Web Audio defines it (0 dB = Butterworth).  The
   * same number means two different things depending on the filter, and
   * getting it wrong draws the wrong filter.
   */
  q: number;
}

/**
 * Magnitude response of one biquad at `hz`, in dB.
 *
 * Coefficients follow the Audio EQ Cookbook, which is what Web Audio's
 * BiquadFilterNode is specified to implement, so this curve is the filter the
 * listener is hearing rather than a sketch of one.
 */
export function biquadMagnitudeDb(spec: BiquadSpec, hz: number, sampleRate = 48_000): number {
  const w0 = (2 * Math.PI * Math.max(1, spec.freq)) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const A = Math.pow(10, spec.gain / 40);

  // Web Audio reads `Q` on lowpass and highpass as a resonance in DECIBELS,
  // not as a cookbook Q — 0 dB is Butterworth.  Drawing it as a linear Q put
  // the corner at -3 dB when the engine was actually producing +0.7 dB, which
  // is a picture of a filter nobody was listening to.
  const q = spec.type === 'lowpass' || spec.type === 'highpass'
    ? Math.pow(10, spec.q / 20)
    : spec.q;
  const alpha = sinW0 / (2 * Math.max(0.0001, q));

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  switch (spec.type) {
    case 'lowshelf': {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
      b2 = A * ((A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = (A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = -2 * ((A - 1) + (A + 1) * cosW0);
      a2 = (A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    case 'highshelf': {
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
      b2 = A * ((A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha);
      a0 = (A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha;
      a1 = 2 * ((A - 1) - (A + 1) * cosW0);
      a2 = (A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha;
      break;
    }
    case 'peaking': {
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
      break;
    }
    case 'highpass': {
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
    case 'lowpass': {
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    }
  }

  // |H(e^jw)| at the frequency we are plotting, not at the corner.
  const w = (2 * Math.PI * Math.max(1, hz)) / sampleRate;
  const cosW = Math.cos(w), cos2W = Math.cos(2 * w);
  const sinW = Math.sin(w), sin2W = Math.sin(2 * w);

  const numReal = b0 + b1 * cosW + b2 * cos2W;
  const numImag = -(b1 * sinW + b2 * sin2W);
  const denReal = a0 + a1 * cosW + a2 * cos2W;
  const denImag = -(a1 * sinW + a2 * sin2W);

  const num = Math.hypot(numReal, numImag);
  const den = Math.hypot(denReal, denImag);
  if (den === 0) return 0;
  return 20 * Math.log10(Math.max(1e-9, num / den));
}

/** Combined response of a chain of biquads, in dB. */
export function chainMagnitudeDb(
  specs: readonly BiquadSpec[], hz: number, sampleRate = 48_000,
): number {
  let db = 0;
  for (const spec of specs) db += biquadMagnitudeDb(spec, hz, sampleRate);
  return db;
}

/** Log-spaced frequency points across the audible band, for plotting. */
export function logFrequencies(count: number, from = 20, to = 20_000): number[] {
  const out: number[] = [];
  const ratio = Math.log(to / from);
  for (let i = 0; i < count; i++) {
    out.push(from * Math.exp((ratio * i) / Math.max(1, count - 1)));
  }
  return out;
}

/** Where a frequency sits across a log-scaled x axis, 0..1. */
export function freqToX(hz: number, from = 20, to = 20_000): number {
  return Math.log(Math.max(from, Math.min(to, hz)) / from) / Math.log(to / from);
}

// ── Dynamics ────────────────────────────────────────────────────────────────

export interface CompressorSpec {
  thresholdDb: number;
  ratio: number;
  /** Soft-knee width in dB.  The engine's detector is hard-knee at 0. */
  kneeDb?: number;
  makeupDb?: number;
}

/**
 * Output level for a given input level, in dB — the transfer curve.
 *
 * The straight 1:1 line below the threshold and the flattening above it is the
 * one picture that makes a compressor legible: you can see how much of the
 * performance is even reaching the knee.
 */
export function compressorOutputDb(spec: CompressorSpec, inputDb: number): number {
  const { thresholdDb, ratio } = spec;
  const knee = Math.max(0, spec.kneeDb ?? 0);
  const makeup = spec.makeupDb ?? 0;
  const r = Math.max(1, ratio);

  const over = inputDb - thresholdDb;
  let out: number;

  if (knee > 0 && over > -knee / 2 && over < knee / 2) {
    // Quadratic bridge across the knee, continuous in value and slope.
    const x = over + knee / 2;
    out = inputDb + ((1 / r - 1) * x * x) / (2 * knee);
  } else if (over <= 0) {
    out = inputDb;
  } else {
    out = thresholdDb + over / r;
  }
  return out + makeup;
}

/** How many dB the compressor is taking off at this input level. */
export function gainReductionDb(spec: CompressorSpec, inputDb: number): number {
  const withoutMakeup: CompressorSpec = { ...spec, makeupDb: 0 };
  return inputDb - compressorOutputDb(withoutMakeup, inputDb);
}

/** A limiter is the ceiling case: everything above it comes back down to it. */
export function limiterOutputDb(ceilingDb: number, inputDb: number): number {
  return Math.min(inputDb, ceilingDb);
}

// ── Time-based ──────────────────────────────────────────────────────────────

/**
 * Echo levels for a delay, as [timeSec, gain] pairs.
 *
 * Drawn rather than described because "70 % feedback" means nothing until you
 * see that it is still audible eight repeats later.
 */
export function delayTaps(
  delaySec: number, feedback: number, maxTaps = 24, floorGain = 0.01,
): Array<{ timeSec: number; gain: number }> {
  const taps: Array<{ timeSec: number; gain: number }> = [];
  const fb = Math.max(0, Math.min(0.99, feedback));
  let gain = 1;
  for (let i = 1; i <= maxTaps; i++) {
    gain *= fb;
    if (gain < floorGain) break;
    taps.push({ timeSec: delaySec * i, gain });
  }
  return taps;
}

/** Decay envelope of a reverb tail, for a simple visual. */
export function reverbEnvelope(decaySec: number, points = 48): number[] {
  const out: number[] = [];
  const tail = Math.max(0.05, decaySec);
  for (let i = 0; i < points; i++) {
    const t = (i / Math.max(1, points - 1)) * tail;
    // -60 dB over the decay time is what a decay time means.
    out.push(Math.pow(10, (-60 * (t / tail)) / 20));
  }
  return out;
}
