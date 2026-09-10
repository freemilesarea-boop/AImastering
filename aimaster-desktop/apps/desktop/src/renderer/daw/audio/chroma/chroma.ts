// Chroma — twelve numbers that say which notes are sounding.
//
// The constant-Q transform gives one magnitude per third of a semitone from
// C2 to C7.  A chord does not care which octave a note is in, so those 180
// numbers fold down to 12: how much C, how much C#, how much D.  That vector
// is what a chord template is matched against, and everything that makes the
// match wrong happens on the way here.
//
// Three things happen between the transform and the vector, and each one is a
// specific failure this file exists to prevent:
//
// ── 1. Tuning ───────────────────────────────────────────────────────────────
//
// Records are not all at A = 440.  Analogue tape drifts, orchestras tune to
// 442, a lot of older material is a quarter-tone off for no reason anybody
// wrote down, and a sample pitched by ear is wherever it landed.  Fold a
// track that sits 40 cents sharp straight into 12 bins and EVERY note leaks
// most of its energy into its neighbour — the chroma is not noisy, it is
// systematically wrong, and nothing downstream can tell.
//
// Three bins per semitone is what makes this fixable: the peak's position
// WITHIN its semitone is measurable, so the offset can be estimated over the
// whole file and the bin axis shifted before folding.
//
// ── 2. Harmonics ────────────────────────────────────────────────────────────
//
// A single sawtooth C has partials at C (×2), G (×3), C (×4), E (×5), G (×6),
// B♭ (×7).  Fold that naively and one note reads as C7 — the chroma of a
// chord nobody played.  This is the biggest single source of wrong thirds and
// wrong sevenths in a template matcher, and it is why the suppression below
// is subtractive: energy that is PREDICTED by a lower partial is removed
// before folding.
//
// ── 3. Loudness ─────────────────────────────────────────────────────────────
//
// A chord in a quiet verse and the same chord in a loud chorus must give the
// same vector, so each frame is log-compressed and normalised.  Frames with
// no music in them are returned as ZERO rather than as normalised noise —
// silence is an answer ("no chord"), and normalising it would invent one.

import { cqtgram, centreHz, type CqtLayout, type Cqtgram, DEFAULT_CQT } from './cqt.js';

export const PITCH_CLASSES = 12;

export interface ChromaOptions {
  /** Frames per second of chroma.  10 is plenty for chords. */
  hopSec: number;
  /** Log compression: log(1 + gamma·x).  Higher lifts quiet partials. */
  gamma: number;
  /**
   * Harmonic suppression strength, 0 disables it.  Applied to partials 2…5.
   */
  harmonicSuppression: number;
  /**
   * Below this fraction of the file's loudest frame, a frame is silence.
   * Returned as a zero vector rather than normalised noise.
   */
  silenceFloor: number;
  /** Skip the tuning estimate and assume A = 440. */
  assumeConcertPitch?: boolean;
}

/**
 * Measured, not chosen by taste.  A sweep of suppression × gamma over a
 * single sawtooth, a major triad, a minor triad, a maj7 and a dom7:
 *
 *   0.5 / 3   single C → C 0.98, next 0.10
 *             C major  → C, E, G all 0.58, next 0.05
 *             C minor  → C, D♯, G all 0.58
 *             Cmaj7    → C, E, G 0.51 and B 0.47
 *             C7       → C, E, G 0.51 and A♯ 0.47, no B in the top five
 *
 * Lower suppression leaves the fifth and third of the harmonic series
 * standing (0.3 gave a single C a G at 0.15); higher risks eating a real
 * fifth that happens to coincide with a partial.  Gamma above about 10 stops
 * lifting quiet notes and starts lifting the noise floor with them.
 */
export const DEFAULT_CHROMA: ChromaOptions = {
  hopSec: 0.1,
  gamma: 3,
  harmonicSuppression: 0.5,
  silenceFloor: 0.02,
};

/**
 * Absolute silence, in RMS.  −80 dBFS.
 *
 * The relative floor below is a fraction of the LOUDEST frame in the file,
 * which is right for a quiet recording and wrong for a file that contains
 * nothing but noise: there the loudest frame is noise, and 2 % of noise is
 * quieter than noise.  Measured — a file of ±1e-7 dither produced a confident
 * twelve-note chroma before this existed.
 */
export const SILENCE_RMS = 1e-4;

// ── Tuning ──────────────────────────────────────────────────────────────────

/**
 * Where a peak really is, to a fraction of a bin.
 *
 * A peak that lands between two bins reads as the nearer bin, which quantises
 * the tuning estimate to a third of a semitone — and a third of a semitone is
 * 33 cents, which is most of the error we are trying to measure.  A parabola
 * through the three log magnitudes recovers the sub-bin position, which is
 * the standard trick and costs three logarithms.
 */
export function refinePeak(left: number, centre: number, right: number): number {
  const a = Math.log(Math.max(1e-12, left));
  const b = Math.log(Math.max(1e-12, centre));
  const c = Math.log(Math.max(1e-12, right));
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < 1e-12) return 0;
  const delta = (0.5 * (a - c)) / denom;
  // A parabola fitted to noise can put the vertex anywhere; a real peak is
  // within half a bin of the sample that won.
  return Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * The recording's tuning, in cents from A = 440.
 *
 * Every strong peak in every frame votes, and the votes are averaged AS
 * ANGLES: the quantity wraps at a semitone, so a peak 49 cents sharp and one
 * 49 cents flat are 2 cents apart, not 98.  An arithmetic mean of those two
 * gives 0 — the one answer that is certainly wrong.
 *
 * Returns 0 when nothing is loud enough to vote.
 */
export function estimateTuningCents(gram: Cqtgram): number {
  const { binsPerOctave } = gram.layout;
  const perSemitone = binsPerOctave / 12;
  let sumSin = 0;
  let sumCos = 0;

  for (const frame of gram.frames) {
    // Peaks only.  Every bin voting would drown the peaks in the skirts of
    // their own windows, which sit symmetrically around them and average to
    // no offset at all.
    let peak = 0;
    for (let k = 0; k < frame.length; k++) peak = Math.max(peak, frame[k] ?? 0);
    if (peak <= 0) continue;
    const floor = peak * 0.1;

    for (let k = 1; k < frame.length - 1; k++) {
      const v = frame[k] ?? 0;
      if (v < floor) continue;
      if (v <= (frame[k - 1] ?? 0) || v < (frame[k + 1] ?? 0)) continue;
      const delta = refinePeak(frame[k - 1] ?? 0, v, frame[k + 1] ?? 0);
      const semitones = (k + delta) / perSemitone;
      const frac = semitones - Math.round(semitones);      // −0.5 … 0.5
      const angle = 2 * Math.PI * frac;
      sumSin += v * Math.sin(angle);
      sumCos += v * Math.cos(angle);
    }
  }

  if (sumSin === 0 && sumCos === 0) return 0;
  const mean = Math.atan2(sumSin, sumCos) / (2 * Math.PI);   // −0.5 … 0.5
  return mean * 100;
}

/**
 * Shift the bin axis so the recording's notes sit on bin centres.
 *
 * A track 30 cents sharp has its peaks 30 cents ABOVE centre, so the axis is
 * read 30 cents higher — the sign is the one thing here that is easy to get
 * backwards, and getting it backwards doubles the error instead of removing
 * it, which looks exactly like the transform not working.
 */
export function shiftForTuning(
  frame: Float32Array, layout: CqtLayout, cents: number,
  out = new Float32Array(frame.length),
): Float32Array {
  const shift = (cents / 100) * (layout.binsPerOctave / 12);
  if (shift === 0) { out.set(frame); return out; }
  for (let k = 0; k < frame.length; k++) {
    const at = k + shift;
    const lo = Math.floor(at);
    const t = at - lo;
    const a = lo >= 0 && lo < frame.length ? (frame[lo] ?? 0) : 0;
    const b = lo + 1 >= 0 && lo + 1 < frame.length ? (frame[lo + 1] ?? 0) : 0;
    out[k] = a * (1 - t) + b * t;
  }
  return out;
}

// ── Harmonics ───────────────────────────────────────────────────────────────

/**
 * Partial number → how far above the fundamental, in semitones, and how loud
 * to expect it.
 *
 * `12·log2(h)`, and the weights are `2/h` — the envelope of a sawtooth, which
 * is the worst case a real instrument approaches from below.  Stopping at the
 * fifth partial was measured and was not enough: a sawtooth C still read 8.5 %
 * B♭ (partial 7), 3.6 % F♯ (partial 11) and 3.6 % G♯ (partial 13).  Partial 7
 * is the one that matters — it is a minor seventh, and leaving it in makes
 * every plain triad look like a dominant chord.
 */
const PARTIALS: readonly { harmonic: number; semitones: number; weight: number }[] = [
  { harmonic: 2, semitones: 12.0000, weight: 1.000 },   // octave
  { harmonic: 3, semitones: 19.0196, weight: 0.667 },   // fifth
  { harmonic: 4, semitones: 24.0000, weight: 0.500 },   // two octaves
  // Partial 5 is a MAJOR THIRD: it is why an unsuppressed single note reads
  // as a major chord.
  { harmonic: 5, semitones: 27.8631, weight: 0.400 },
  { harmonic: 6, semitones: 31.0196, weight: 0.333 },   // fifth again
  // Partial 7 is a MINOR SEVENTH — the one that turns triads into 7 chords.
  { harmonic: 7, semitones: 33.6883, weight: 0.286 },
  { harmonic: 8, semitones: 36.0000, weight: 0.250 },   // three octaves
];

/**
 * Remove energy a lower partial already explains.
 *
 * Subtractive rather than additive on purpose.  Summing harmonics into the
 * fundamental reinforces a root that is really there, and equally reinforces
 * one that is not — a fifth in the bass with no root above it becomes a root.
 * Subtracting asks the narrower question: is there energy HERE beyond what the
 * note an octave (or a twelfth, or a seventeenth) below would produce?
 *
 * Clamped at zero.  A negative magnitude is not a quieter note, it is a sign
 * error waiting to be normalised into nonsense.
 */
export function suppressHarmonics(
  frame: Float32Array, layout: CqtLayout, strength: number,
  out = new Float32Array(frame.length),
): Float32Array {
  if (strength <= 0) { out.set(frame); return out; }
  const perSemitone = layout.binsPerOctave / 12;
  for (let k = 0; k < frame.length; k++) {
    let predicted = 0;
    for (const partial of PARTIALS) {
      const at = k - partial.semitones * perSemitone;
      const lo = Math.floor(at);
      if (lo < 0 || lo + 1 >= frame.length) continue;
      const t = at - lo;
      const value = (frame[lo] ?? 0) * (1 - t) + (frame[lo + 1] ?? 0) * t;
      predicted += value * partial.weight;
    }
    out[k] = Math.max(0, (frame[k] ?? 0) - strength * predicted);
  }
  return out;
}

// ── Folding ─────────────────────────────────────────────────────────────────

/**
 * 180 bins → 12, by pitch class.
 *
 * The three bins of a semitone are summed rather than max-ed: after the
 * tuning shift the energy of a note genuinely straddles them, and taking the
 * maximum throws away the part that leaked.
 *
 * `layout.minHz` is a C, so bin 0 is pitch class 0 — if that ever stops being
 * true this function is wrong in a way nothing else would notice, which is
 * why the self-test checks a known A against pitch class 9.
 */
export function foldToChroma(
  frame: Float32Array, layout: CqtLayout,
  out = new Float32Array(PITCH_CLASSES),
): Float32Array {
  out.fill(0);
  const perSemitone = layout.binsPerOctave / 12;
  for (let k = 0; k < frame.length; k++) {
    const semitone = Math.round(k / perSemitone);
    const pc = ((semitone % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
    out[pc] = (out[pc] ?? 0) + (frame[k] ?? 0);
  }
  return out;
}

/** log(1 + γ·x) — lifts the quiet partials that carry the sevenths. */
export function compress(vector: Float32Array, gamma: number): Float32Array {
  for (let i = 0; i < vector.length; i++) {
    vector[i] = Math.log(1 + gamma * Math.max(0, vector[i] ?? 0));
  }
  return vector;
}

/** Scale so the largest value is 1.  An all-zero vector stays all-zero. */
export function peakNormalize(vector: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < vector.length; i++) peak = Math.max(peak, vector[i] ?? 0);
  if (peak <= 1e-12) { vector.fill(0); return vector; }
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / peak;
  return vector;
}

/** L2 normalise in place.  An all-zero vector stays all-zero. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += (vector[i] ?? 0) ** 2;
  const norm = Math.sqrt(sum);
  if (norm <= 1e-12) { vector.fill(0); return vector; }
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

// ── The whole thing ─────────────────────────────────────────────────────────

export interface Chromagram {
  /** One 12-vector per frame, L2-normalised.  Silence is all zeros. */
  frames: Float32Array[];
  /** Seconds between frames. */
  hopSec: number;
  /** What the tuning estimate found, in cents from A = 440. */
  tuningCents: number;
  /** Frames that were below the silence floor. */
  silentFrames: number;
}

export function chromaTimeSec(gram: Chromagram, index: number): number {
  return index * gram.hopSec;
}

/**
 * Audio in, chroma out.
 *
 * Mono is the caller's job — a chord is the same chord in both channels, and
 * summing here would hide a caller that meant to analyse one side.
 */
export function chromagram(
  samples: ArrayLike<number>, sampleRate: number,
  options: Partial<ChromaOptions> = {}, layout: CqtLayout = DEFAULT_CQT,
): Chromagram {
  const opt = { ...DEFAULT_CHROMA, ...options };
  const hopSize = Math.max(1, Math.round(opt.hopSec * sampleRate));
  const gram = cqtgram(samples, sampleRate, hopSize, layout);
  const tuningCents = opt.assumeConcertPitch ? 0 : estimateTuningCents(gram);

  // The silence floor is relative to the LOUDEST frame in this file, not to
  // an absolute level: a quiet recording is still music, and an absolute
  // threshold would call all of it silence.
  let loudest = 0;
  for (const frame of gram.frames) {
    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] ?? 0;
    if (sum > loudest) loudest = sum;
  }
  const floor = loudest * opt.silenceFloor;

  /** Time-domain level around a frame — the absolute half of the floor. */
  const frameRms = (index: number): number => {
    const centre = index * hopSize;
    const from = Math.max(0, centre - hopSize);
    const to = Math.min(samples.length, centre + hopSize);
    if (to <= from) return 0;
    let sum = 0;
    for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
    return Math.sqrt(sum / (to - from));
  };

  const shifted = new Float32Array(layout.bins);
  const suppressed = new Float32Array(layout.bins);
  const frames: Float32Array[] = [];
  let silentFrames = 0;

  for (const [index, frame] of gram.frames.entries()) {
    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] ?? 0;
    if (sum <= floor || frameRms(index) < SILENCE_RMS) {
      frames.push(new Float32Array(PITCH_CLASSES));
      silentFrames += 1;
      continue;
    }
    shiftForTuning(frame, layout, tuningCents, shifted);
    suppressHarmonics(shifted, layout, opt.harmonicSuppression, suppressed);
    const chroma = foldToChroma(suppressed, layout);
    // Scaled to its own maximum BEFORE the logarithm.  Measured: compressing
    // raw magnitudes (which are in the thousands here) turned a 75 % / 8 %
    // split into 0.43 / 0.36 — the compression was not lifting quiet notes,
    // it was erasing the difference between every note and every artefact.
    // log(1 + γ·x) only means anything when x is already 0…1.
    peakNormalize(chroma);
    normalize(compress(chroma, opt.gamma));
    frames.push(chroma);
  }

  return { frames, hopSec: hopSize / sampleRate, tuningCents, silentFrames };
}

/** The pitch class a CQT bin belongs to — exported for the self-test. */
export function binPitchClass(layout: CqtLayout, bin: number): number {
  const semitone = Math.round(bin / (layout.binsPerOctave / 12));
  return ((semitone % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
}

/** Centre frequency of a bin — re-exported so callers need one import. */
export { centreHz };
