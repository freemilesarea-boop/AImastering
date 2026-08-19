// De-click — find the clicks, then rebuild what was under them.
//
// Detection.  A click is a DISCONTINUITY, so the detector looks at the second
// difference of the waveform: smooth audio, however loud, produces almost
// nothing there, while a one-sample jump produces a spike.  That is what
// separates a click from a loud passage.
//
// What it does NOT separate is a click from a snare hit — both are sharp.  The
// discriminator is DURATION.  A click is over in a millisecond or two; a drum
// attack keeps feeding energy into the high band for tens of milliseconds as
// it decays.  So a candidate has to be both sharp AND brief, and the width
// test is what stops the repairer from eating the drummer.
//
// Repair.  For a gap of 50–150 samples, interpolating a smooth curve across it
// leaves an audible dull patch — every harmonic above a few hundred Hz is gone
// for those milliseconds.  The classic answer is Janssen's method: fit an
// autoregressive model to the audio around the gap, then solve for the
// samples that best satisfy that model.  The interpolation then carries the
// same harmonic content as its surroundings, because the model was built from
// them.

export interface ClickEvent {
  startSec: number;
  endSec: number;
  /** Peak of the detection signal, relative to the local baseline. */
  strength: number;
}

export interface ClickOptions {
  /** How far above the local baseline the second difference must jump. */
  sensitivity?: number;
  /** Longer than this and it is a musical transient, not a click. */
  maxWidthMs?: number;
  /** Events closer than this are merged into one. */
  minSpacingMs?: number;
  /** Baseline window. */
  baselineMs?: number;
  /** Absolute floor — nothing is a click in silence. */
  floor?: number;
}

const CLICK_DEFAULTS = {
  sensitivity: 8, maxWidthMs: 3, minSpacingMs: 5, baselineMs: 50, floor: 1e-5,
};

/** |x[n] − 2x[n−1] + x[n−2]| — near zero for smooth audio, huge at a jump. */
export function secondDifference(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 2; i < samples.length; i++) {
    out[i] = Math.abs((samples[i] ?? 0) - 2 * (samples[i - 1] ?? 0) + (samples[i - 2] ?? 0));
  }
  return out;
}

/** Running mean over a window, via a prefix sum so it is O(n). */
function runningMean(values: Float32Array, window: number): Float32Array {
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] ?? 0) + (values[i] ?? 0);
  const out = new Float32Array(n);
  const half = Math.max(1, Math.floor(window / 2));
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(n, i + half);
    out[i] = ((prefix[to] ?? 0) - (prefix[from] ?? 0)) / Math.max(1, to - from);
  }
  return out;
}

export function detectClicks(
  samples: Float32Array, sampleRate: number, options: ClickOptions = {},
): ClickEvent[] {
  const sensitivity = options.sensitivity ?? CLICK_DEFAULTS.sensitivity;
  const maxWidth = Math.max(1, Math.round(((options.maxWidthMs ?? CLICK_DEFAULTS.maxWidthMs) / 1000) * sampleRate));
  const minSpacing = Math.round(((options.minSpacingMs ?? CLICK_DEFAULTS.minSpacingMs) / 1000) * sampleRate);
  const baselineWindow = Math.round(((options.baselineMs ?? CLICK_DEFAULTS.baselineMs) / 1000) * sampleRate);
  const floor = options.floor ?? CLICK_DEFAULTS.floor;
  if (samples.length < baselineWindow) return [];

  const detection = secondDifference(samples);
  const baseline = runningMean(detection, baselineWindow);

  const events: ClickEvent[] = [];
  let i = 2;
  while (i < detection.length) {
    const value = detection[i] ?? 0;
    const local = Math.max(floor, baseline[i] ?? 0);
    if (value < local * sensitivity) { i++; continue; }

    // Walk the run of samples that stay above half the peak.
    let peak = value;
    let end = i;
    for (let j = i; j < Math.min(detection.length, i + maxWidth * 4); j++) {
      const v = detection[j] ?? 0;
      if (v > peak) peak = v;
      if (v >= local * sensitivity * 0.5) end = j;
      else if (j - end > maxWidth) break;
    }
    const width = end - i + 1;

    // Sharp AND brief.  A drum attack passes the first test and fails this one.
    if (width <= maxWidth) {
      const previous = events[events.length - 1];
      if (previous && i - previous.endSec * sampleRate < minSpacing) {
        previous.endSec = (end + 1) / sampleRate;
        previous.strength = Math.max(previous.strength, peak / local);
      } else {
        events.push({
          startSec: i / sampleRate,
          endSec: (end + 1) / sampleRate,
          strength: peak / local,
        });
      }
    }
    i = end + 1;
  }
  return events;
}

// ── Autoregressive interpolation (Janssen) ───────────────────────────────────

/**
 * LPC coefficients by Levinson-Durbin.  Returns a[1…order] such that
 * x[n] ≈ Σ a[k]·x[n−k].
 */
export function lpcCoefficients(frame: ArrayLike<number>, order: number): Float64Array {
  return lpcFromSegments([frame], order);
}

/**
 * The same, fitted to several disjoint stretches of audio.
 *
 * This matters for gap repair: the known audio is the piece BEFORE the gap and
 * the piece AFTER it.  Concatenating them puts a step discontinuity in the
 * middle of the training data, and the model then spends its order describing
 * that step instead of the music.  Summing each segment's autocorrelation
 * keeps them separate, which is what they are.
 */
export function lpcFromSegments(segments: ReadonlyArray<ArrayLike<number>>, order: number): Float64Array {
  const r = new Float64Array(order + 1);
  for (const frame of segments) {
    const n = frame.length;
    for (let lag = 0; lag <= order && lag < n; lag++) {
      let sum = 0;
      for (let i = lag; i < n; i++) sum += (frame[i] ?? 0) * (frame[i - lag] ?? 0);
      r[lag] = (r[lag] ?? 0) + sum;
    }
  }
  const a = new Float64Array(order + 1);
  // A flat or silent frame has no model — predict nothing rather than divide
  // by zero.
  if ((r[0] ?? 0) <= 1e-12) return a;
  // Ridge: a touch of white noise on the diagonal keeps the recursion stable
  // on very tonal material, where the matrix is near-singular.
  r[0] = (r[0] ?? 0) * 1.0001 + 1e-9;

  let error = r[0] ?? 0;
  for (let i = 1; i <= order; i++) {
    let acc = r[i] ?? 0;
    for (let j = 1; j < i; j++) acc -= (a[j] ?? 0) * (r[i - j] ?? 0);
    const k = acc / error;
    const previous = a.slice(0, i);
    a[i] = k;
    for (let j = 1; j < i; j++) a[j] = (previous[j] ?? 0) - k * (previous[i - j] ?? 0);
    error *= 1 - k * k;
    if (error <= 1e-12) break;
  }
  return a;
}

/** Solve A·x = b in place by Gaussian elimination with partial pivoting. */
function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(A[col * n + col] ?? 0);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(A[row * n + col] ?? 0);
      if (v > best) { best = v; pivot = row; }
    }
    if (best < 1e-12) return null;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const tmp = A[col * n + k] ?? 0;
        A[col * n + k] = A[pivot * n + k] ?? 0;
        A[pivot * n + k] = tmp;
      }
      const tmp = b[col] ?? 0;
      b[col] = b[pivot] ?? 0;
      b[pivot] = tmp;
    }
    const diagonal = A[col * n + col] ?? 1;
    for (let row = col + 1; row < n; row++) {
      const factor = (A[row * n + col] ?? 0) / diagonal;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) {
        A[row * n + k] = (A[row * n + k] ?? 0) - factor * (A[col * n + k] ?? 0);
      }
      b[row] = (b[row] ?? 0) - factor * (b[col] ?? 0);
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row] ?? 0;
    for (let k = row + 1; k < n; k++) sum -= (A[row * n + k] ?? 0) * (x[k] ?? 0);
    x[row] = sum / (A[row * n + row] ?? 1);
  }
  return x;
}

/** Cubic Hermite across the gap — the fallback when the model is unusable. */
function hermiteFill(samples: Float32Array, gapStart: number, gapLength: number): void {
  const before = gapStart - 1;
  const after = gapStart + gapLength;
  const p0 = samples[before] ?? 0;
  const p1 = samples[after] ?? 0;
  const m0 = p0 - (samples[before - 1] ?? p0);
  const m1 = (samples[after + 1] ?? p1) - p1;
  for (let i = 0; i < gapLength; i++) {
    const t = (i + 1) / (gapLength + 1);
    const t2 = t * t;
    const t3 = t2 * t;
    samples[gapStart + i] =
      (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0
      + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
  }
}

export interface InterpolateOptions {
  /** AR model order.  32 covers a voice; 64 a dense mix. */
  order?: number;
  /**
   * Context each side, in multiples of the order.  This is the parameter that
   * decides the result: the window has to span SEVERAL periods of the lowest
   * note present, or the autocorrelation never sees the fundamental and the
   * model has nothing to lock onto.  The default (32 × order ≈ 23 ms at
   * 44.1 kHz) covers two periods of an 85 Hz voice and five of a 220 Hz one.
   */
  contextFactor?: number;
  /**
   * Janssen refinement passes.  The first estimate is fitted to the audio
   * around the hole; each pass re-fits the model INCLUDING the samples it just
   * filled, so the model and the fill converge on each other.  Two or three
   * passes is where it stops moving.
   */
  iterations?: number;
}

/**
 * Rebuild `gapLength` samples starting at `gapStart`, in place.
 *
 * The model is fitted to the audio on BOTH sides of the gap (the two stretches
 * concatenated), then the unknown samples are chosen to minimise the model's
 * prediction error across the whole neighbourhood.  That is why the result
 * keeps the harmonics: they are in the model.
 */
export function interpolateGap(
  samples: Float32Array, gapStart: number, gapLength: number, options: InterpolateOptions = {},
): void {
  const order = Math.max(4, options.order ?? 32);
  const factor = Math.max(2, options.contextFactor ?? 32);
  const iterations = Math.max(1, options.iterations ?? 3);
  const context = order * factor;
  if (gapLength <= 0) return;

  const left = Math.max(0, gapStart - context);
  const right = Math.min(samples.length, gapStart + gapLength + context);
  if (gapStart - left < order + 2 || right - (gapStart + gapLength) < order + 2) {
    hermiteFill(samples, gapStart, gapLength);
    return;
  }

  for (let pass = 0; pass < iterations; pass++) {
    // First pass fits the known audio either side; later passes include the
    // filled samples, so the model and the fill refine each other.
    const a = pass === 0
      ? lpcFromSegments([
        samples.subarray(left, gapStart),
        samples.subarray(gapStart + gapLength, right),
      ], order)
      : lpcFromSegments([samples.subarray(left, right)], order);
    if (!fillOnce(samples, gapStart, gapLength, left, right, order, a)) {
      hermiteFill(samples, gapStart, gapLength);
      return;
    }
  }
}

/** One Janssen solve.  Returns false when the model cannot be trusted. */
function fillOnce(
  samples: Float32Array, gapStart: number, gapLength: number,
  left: number, right: number, order: number, a: Float64Array,
): boolean {

  // b = [1, −a1, −a2, …]; the prediction error is the convolution of x with b.
  const b = new Float64Array(order + 1);
  b[0] = 1;
  for (let k = 1; k <= order; k++) b[k] = -(a[k] ?? 0);

  // Autocorrelation of b — the quadratic form's kernel.
  const rb = new Float64Array(order + 1);
  for (let d = 0; d <= order; d++) {
    let sum = 0;
    for (let k = 0; k + d <= order; k++) sum += (b[k] ?? 0) * (b[k + d] ?? 0);
    rb[d] = sum;
  }

  // Region the error is summed over: the gap plus `order` samples each side.
  const regionStart = Math.max(left, gapStart - order);
  const regionEnd = Math.min(right, gapStart + gapLength + order);
  const m = gapLength;
  const A = new Float64Array(m * m);
  const rhs = new Float64Array(m);

  for (let i = 0; i < m; i++) {
    const gi = gapStart + i;
    for (let j = 0; j < m; j++) {
      const d = Math.abs(gi - (gapStart + j));
      A[i * m + j] = d <= order ? (rb[d] ?? 0) : 0;
    }
    // Known samples move to the right-hand side.
    let sum = 0;
    for (let n = regionStart; n < regionEnd; n++) {
      if (n >= gapStart && n < gapStart + gapLength) continue;
      const d = Math.abs(gi - n);
      if (d > order) continue;
      sum += (rb[d] ?? 0) * (samples[n] ?? 0);
    }
    rhs[i] = -sum;
    // Ridge on the diagonal, scaled to the kernel: a long gap in near-silence
    // is otherwise singular.
    A[i * m + i] = (A[i * m + i] ?? 0) + (rb[0] ?? 1) * 1e-7;
  }

  const solved = solve(A, rhs, m);
  if (!solved) return false;

  // A solution that explodes means the model was wrong about this passage;
  // a dull patch is a better failure than a new click.
  let peak = 0;
  for (let i = 0; i < m; i++) peak = Math.max(peak, Math.abs(solved[i] ?? 0));
  let neighbourhood = 0;
  for (let n = regionStart; n < regionEnd; n++) {
    if (n >= gapStart && n < gapStart + gapLength) continue;
    neighbourhood = Math.max(neighbourhood, Math.abs(samples[n] ?? 0));
  }
  if (peak > Math.max(1e-6, neighbourhood) * 4) return false;

  for (let i = 0; i < m; i++) samples[gapStart + i] = solved[i] ?? 0;
  return true;
}

export interface RepairOptions extends InterpolateOptions {
  /** Extra samples repaired each side of the detected event. */
  guardSamples?: number;
  /** Refuse to interpolate anything longer than this, in ms. */
  maxGapMs?: number;
}

export interface RepairResult {
  samples: Float32Array;
  repaired: number;
  skipped: number;
}

/** Repair every detected click in one pass.  Returns a new buffer. */
export function repairClicks(
  samples: Float32Array, sampleRate: number,
  clicks: readonly ClickEvent[], options: RepairOptions = {},
): RepairResult {
  const out = Float32Array.from(samples);
  const guard = options.guardSamples ?? 2;
  const maxGap = Math.round(((options.maxGapMs ?? 10) / 1000) * sampleRate);
  let repaired = 0;
  let skipped = 0;

  for (const click of clicks) {
    const start = Math.max(1, Math.floor(click.startSec * sampleRate) - guard);
    const end = Math.min(out.length - 1, Math.ceil(click.endSec * sampleRate) + guard);
    const length = end - start;
    if (length <= 0) { skipped++; continue; }
    if (length > maxGap) { skipped++; continue; }
    interpolateGap(out, start, length, options);
    repaired++;
  }
  return { samples: out, repaired, skipped };
}

/** Detect and repair in one call — the "scan and fix" button. */
export function declick(
  samples: Float32Array, sampleRate: number,
  options: ClickOptions & RepairOptions = {},
): RepairResult & { detected: number } {
  const clicks = detectClicks(samples, sampleRate, options);
  const result = repairClicks(samples, sampleRate, clicks, options);
  return { ...result, detected: clicks.length };
}

/**
 * Repair every channel using ONE detection pass over the mono sum.  A click on
 * the disc hits both channels; detecting per channel would repair one of them
 * at a slightly different place and turn a click into a stereo artefact.
 */
export function declickChannels(
  channels: readonly Float32Array[], sampleRate: number,
  options: ClickOptions & RepairOptions = {},
): { channels: Float32Array[]; detected: number; repaired: number } {
  if (channels.length === 0) return { channels: [], detected: 0, repaired: 0 };
  const first = channels[0] ?? new Float32Array(0);
  let reference = first;
  if (channels.length > 1) {
    reference = new Float32Array(first.length);
    for (let i = 0; i < first.length; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i] ?? 0;
      reference[i] = sum / channels.length;
    }
  }
  const clicks = detectClicks(reference, sampleRate, options);
  let repaired = 0;
  const out = channels.map((ch) => {
    const result = repairClicks(ch, sampleRate, clicks, options);
    repaired = result.repaired;
    return result.samples;
  });
  return { channels: out, detected: clicks.length, repaired };
}
