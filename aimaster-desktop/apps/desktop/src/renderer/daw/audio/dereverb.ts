// De-reverb — subtract the tail the room is still playing.
//
// Reverberation is the one restoration problem where the unwanted signal is
// made ENTIRELY out of the wanted one: the tail at any moment is a decayed,
// smeared copy of what was played a few tens of milliseconds ago.  That is
// also the handle.  Lebart's method estimates the late-field power in each
// bin from the SAME bin a short time earlier, scaled by the room's decay:
//
//     E_rev[t][b] = e^(−2·δ·Δ) · |X[t−Δ][b]|²        δ = 3·ln10 / T60
//
// and subtracts it.  Direct sound is whatever exceeds its own recent history;
// the tail is what merely continues it.  Two consequences worth stating:
//
//   • It needs T60, and a wrong T60 is the difference between de-reverb and
//     damage.  So T60 is measured from the material (`estimateReverbTime`)
//     rather than assumed, and it is exposed for the user to correct.
//   • It removes LATE reverberation only.  The early reflections inside Δ are
//     part of what makes a room sound like a room, and taking them out is
//     what makes a de-reverbed track sound like it was recorded in a pipe.
//
// And one limitation worth stating plainly rather than discovering by ear: a
// SUSTAINED tone satisfies the reverb model.  A note held longer than Δ looks
// exactly like "the same bin, one decay ago", so the subtraction attenuates it
// along with the tail.  This is a tool for transient material — speech, drums,
// plucked and struck instruments — and on a held pad it will thin the note.
// The `strength` control exists so that trade can be dialled rather than
// suffered.

import { binCount, frameMagnitude, istft, scaleBin, stft } from './stft.js';

export interface ReverbEstimate {
  /** Seconds for the tail to fall 60 dB. */
  t60: number;
  /** How many decay segments the estimate averaged. */
  segments: number;
  /** 0…1 — agreement between the segments that were measured. */
  confidence: number;
}

export interface EstimateOptions {
  /** Envelope hop. */
  hopMs?: number;
  /** dB below a peak where the fit starts (skips the direct sound). */
  startDb?: number;
  /** dB below a peak where the fit ends. */
  endDb?: number;
}

const ESTIMATE_DEFAULTS = { hopMs: 5, startDb: -5, endDb: -25 };

/** RMS envelope in dB, one value per hop. */
function envelopeDb(samples: Float32Array, hop: number): Float32Array {
  const frames = Math.max(1, Math.floor(samples.length / hop));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const from = f * hop;
    const to = Math.min(samples.length, from + hop);
    for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    out[f] = rms > 1e-9 ? 20 * Math.log10(rms) : -180;
  }
  return out;
}

/**
 * T60 from the material, by the T20 method: after each strong onset, measure
 * how long the envelope takes to fall from −5 dB to −25 dB below the peak, and
 * multiply by three.  Starting at −5 dB skips the direct sound; stopping at
 * −25 dB stays above the noise floor.
 *
 * Returns null when nothing in the take decays freely for long enough — which
 * is the honest answer for a wall-to-wall dense mix.
 */
export function estimateReverbTime(
  samples: Float32Array, sampleRate: number, options: EstimateOptions = {},
): ReverbEstimate | null {
  const hop = Math.max(1, Math.round(((options.hopMs ?? ESTIMATE_DEFAULTS.hopMs) / 1000) * sampleRate));
  const startDb = options.startDb ?? ESTIMATE_DEFAULTS.startDb;
  const endDb = options.endDb ?? ESTIMATE_DEFAULTS.endDb;
  const env = envelopeDb(samples, hop);
  if (env.length < 20) return null;

  const secondsPerFrame = hop / sampleRate;
  const times: number[] = [];

  for (let f = 1; f + 1 < env.length; f++) {
    const peak = env[f] ?? -180;
    if (peak < -60) continue;
    // Local maximum, and meaningfully above what came before.
    if (peak <= (env[f - 1] ?? -180) || peak < (env[f + 1] ?? -180)) continue;

    let crossedStart = -1;
    let crossedEnd = -1;
    for (let k = f + 1; k < env.length; k++) {
      const level = (env[k] ?? -180) - peak;
      // A new hit before the decay finished invalidates this segment.
      if (level > startDb && crossedStart >= 0) { crossedStart = -1; break; }
      if (crossedStart < 0 && level <= startDb) crossedStart = k;
      if (crossedStart >= 0 && level <= endDb) { crossedEnd = k; break; }
    }
    if (crossedStart < 0 || crossedEnd < 0) continue;

    const t20 = (crossedEnd - crossedStart) * secondsPerFrame;
    if (t20 <= 0) continue;
    times.push(t20 * 3);
    f = crossedEnd;                       // do not re-measure inside this decay
  }

  if (times.length === 0) return null;
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] ?? 0;
  if (median <= 0) return null;

  // Confidence: how tightly the segments agree with the median.
  let spread = 0;
  for (const t of times) spread += Math.abs(t - median) / median;
  spread /= times.length;

  return {
    t60: Math.min(6, Math.max(0.05, median)),
    segments: times.length,
    confidence: Math.max(0, Math.min(1, 1 - spread)),
  };
}

export interface DereverbOptions {
  fftSize?: number;
  hopSize?: number;
  /** How much of the estimated tail to subtract. */
  strength?: number;
  /** Deepest attenuation any bin may receive, dB. */
  reductionDb?: number;
  /** Look-back for the tail estimate.  Below this is treated as early
   *  reflections and left alone — they are the room, not the smear. */
  earlyMs?: number;
  /** Gain smoothing across time, 0…1. */
  smoothing?: number;
  /** `residual` outputs the tail that would be removed. */
  output?: 'clean' | 'residual';
}

const DEREVERB_DEFAULTS = {
  fftSize: 2048, strength: 1, reductionDb: 18, earlyMs: 40, smoothing: 0.3,
  output: 'clean' as const,
};

/** Subtract the late field from one channel. */
export function dereverb(
  samples: Float32Array, sampleRate: number, t60: number, options: DereverbOptions = {},
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  const fftSize = options.fftSize ?? DEREVERB_DEFAULTS.fftSize;
  const hopSize = options.hopSize ?? fftSize / 4;
  const strength = Math.max(0, options.strength ?? DEREVERB_DEFAULTS.strength);
  const reductionDb = Math.abs(options.reductionDb ?? DEREVERB_DEFAULTS.reductionDb);
  const earlyMs = options.earlyMs ?? DEREVERB_DEFAULTS.earlyMs;
  const smoothing = Math.min(0.99, Math.max(0, options.smoothing ?? DEREVERB_DEFAULTS.smoothing));
  const residual = (options.output ?? DEREVERB_DEFAULTS.output) === 'residual';

  const spec = stft(samples, sampleRate, { fftSize, hopSize });
  const bins = binCount(fftSize);
  const delay = Math.max(1, Math.round(((earlyMs / 1000) * sampleRate) / hopSize));

  // Power left after the room has decayed for `delay` frames.
  const decayRate = (3 * Math.LN10) / Math.max(0.01, t60);
  const kappa = Math.exp((-2 * decayRate * delay * hopSize) / sampleRate);
  const floor = Math.pow(10, -reductionDb / 20);

  // The tail estimate must read the ORIGINAL magnitudes, not ones this pass
  // already attenuated — otherwise the subtraction compounds on itself and
  // eats the signal.  A ring of the last `delay + 1` frames is all it takes,
  // which keeps the pass forward-going and the memory bounded.
  const history: Float32Array[] = [];
  for (let i = 0; i <= delay; i++) history.push(new Float32Array(bins));
  const previousGain = new Float32Array(bins).fill(1);

  for (let f = 0; f < spec.frames.length; f++) {
    const frame = spec.frames[f];
    if (!frame) continue;
    const current = history[f % history.length] as Float32Array;
    const past = f - delay >= 0 ? history[(f - delay) % history.length] : undefined;

    // Snapshot before anything is scaled.
    for (let bin = 0; bin < bins; bin++) current[bin] = frameMagnitude(frame, bin);

    for (let bin = 0; bin < bins; bin++) {
      const magnitude = current[bin] ?? 0;
      let gain = 1;
      if (past && magnitude > 1e-12) {
        const power = magnitude * magnitude;
        const tail = kappa * Math.pow(past[bin] ?? 0, 2);
        const clean = Math.max(0, power - strength * tail);
        gain = Math.min(1, Math.max(floor, Math.sqrt(clean / power)));
      }
      // Smooth the GAIN, never the magnitude: smoothing magnitudes would
      // soften every attack in the take.
      const smoothed = smoothing * (previousGain[bin] ?? 1) + (1 - smoothing) * gain;
      previousGain[bin] = smoothed;
      scaleBin(frame, bin, residual ? 1 - smoothed : smoothed, fftSize);
    }
  }

  return istft(spec);
}

export function dereverbChannels(
  channels: readonly Float32Array[], sampleRate: number, t60: number,
  options: DereverbOptions = {},
): Float32Array[] {
  return channels.map((ch) => dereverb(ch, sampleRate, t60, options));
}

export function describeReverb(estimate: ReverbEstimate | null): string {
  if (!estimate) return '자유 감쇠 구간이 없어 잔향 시간을 잴 수 없습니다';
  return `T60 ${estimate.t60.toFixed(2)} s · 감쇠 구간 ${estimate.segments}개`
    + ` · 확신도 ${(estimate.confidence * 100).toFixed(0)}%`;
}
