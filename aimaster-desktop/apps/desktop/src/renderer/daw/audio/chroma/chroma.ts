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
// wrong sevenths in a template matcher, and the suppression below removes a
// bin when a NOTE exists below it at one of its subharmonic positions.  What
// it does not do is guess how loud that partial ought to be: on a plucked
// string the third partial can be more than twice its own fundamental, so a
// prediction scaled from the fundamental is smaller than the thing it is
// meant to cancel.  See `suppressHarmonics`.
//
// What suppression cannot reach is discounted by register instead.  Residue
// piles up ABOVE the highest note of a chord, where every bin is a partial of
// something; a chord is voiced within about two octaves of its own bass, so
// the fold's weight falls off above that.  See `weightByRegister`.
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
   * Harmonic suppression strength, 0 disables it.
   *
   * The fraction of a bin removed when a note certainly exists below it at one
   * of its subharmonic positions — partials 2 through 8.  See
   * `suppressHarmonics`; it is not a fraction of a predicted amplitude.
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
 * Measured, not chosen by taste.  Sawtooth chords, through this pipeline:
 *
 *   0.95 / 3  single C → C 0.98, next 0.08
 *             C major  → C, E, G 0.58 0.56 0.54, next 0.05
 *             C minor  → C, D♯, G 0.58 0.56 0.54
 *             Cmaj7    → C, E, B, G 0.50 0.49 0.49 0.47
 *             C7       → C, E, A♯, G 0.50 0.49 0.49 0.47, no B in the top five
 *
 * Suppression is near 1 because it is now a fraction of a bin that a note
 * below explains, not a fraction of a predicted amplitude: 0.85 through 1.00
 * all name the same 12 of 12 test chords and 0.8 starts missing them, so the
 * high end of that range is a plateau, not an edge.  Gamma above about 10
 * stops lifting quiet notes and starts lifting the noise floor with them.
 */
export const DEFAULT_CHROMA: ChromaOptions = {
  hopSec: 0.1,
  gamma: 3,
  harmonicSuppression: 0.95,
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
 * Partial number → how far above the fundamental, in semitones.
 *
 * `12·log2(h)`.  Stopping at the fifth partial was measured and was not
 * enough: a sawtooth C still read 8.5 % B♭ (partial 7), 3.6 % F♯ (partial 11)
 * and 3.6 % G♯ (partial 13).  Partial 7 is the one that matters — it is a
 * minor seventh, and leaving it in makes every plain triad look like a
 * dominant chord.
 */
const PARTIALS: readonly { harmonic: number; semitones: number }[] = [
  { harmonic: 2, semitones: 12.0000 },   // octave
  { harmonic: 3, semitones: 19.0196 },   // fifth
  { harmonic: 4, semitones: 24.0000 },   // two octaves
  // Partial 5 is a MAJOR THIRD: it is why an unsuppressed single note reads
  // as a major chord.
  { harmonic: 5, semitones: 27.8631 },
  { harmonic: 6, semitones: 31.0196 },   // fifth again
  // Partial 7 is a MINOR SEVENTH — the one that turns triads into 7 chords.
  { harmonic: 7, semitones: 33.6883 },
  { harmonic: 8, semitones: 36.0000 },   // three octaves
];

/**
 * How loud a fundamental has to be, as a fraction of the frame's loudest bin,
 * to count as present.
 *
 * Not a prediction of the partial's size — see `suppressHarmonics` for why
 * there is no such prediction to be had.  This is only the level below which a
 * bin is the analyser's own noise rather than a note somebody played.  Swept:
 * 0.03 to 0.10 all name the same 12 of 12 test chords, 0.15 starts missing
 * one, so 0.07 sits in the middle of a plateau rather than on a threshold.
 */
export const HARMONIC_PRESENCE_FLOOR = 0.07;

/**
 * Remove energy a lower note already explains.
 *
 * Asks whether a NOTE exists below this bin at one of its subharmonic
 * positions, and if one does, removes `strength` of the bin.  What it
 * deliberately does not do is predict how loud the partial should be.
 *
 * ── Why no prediction ───────────────────────────────────────────────────────
 *
 * This used to subtract `strength × (the fundamental's magnitude × 2/h)`, the
 * sawtooth envelope, and that assumes the fundamental is the loudest partial.
 * On a plucked string it is not.  A string plucked at a fraction `p` of its
 * length has partial `h` at `|sin(hπp)|`, so at the 13 % the acoustic guitar
 * uses the fundamental sits at 0.40 and the third partial at 0.94 — the
 * partial is 2.35× the thing that is supposed to predict it, and no strength
 * multiplies a smaller number into a larger one.  Measured: the guitar's
 * C major chord read C:maj7 at every strength from 0.6 to 0.95, because the B
 * that makes the seventh is the third partial of its E and the fifth of its G.
 *
 * The amplitude a partial "should" have depends on where the string was
 * plucked, which the analyser cannot know.  Presence does not: either there is
 * a note at the position a fundamental would occupy or there is not.  Over 47
 * chords — sawtooths, six-string guitar voicings at five pick positions, and
 * mixes with a bass, a melody and a noise floor — the subtractive form named
 * 22 correctly and this one names 44.
 *
 * ── The band that cannot be tested ──────────────────────────────────────────
 *
 * The lowest octave of the CQT has no subharmonic position inside the
 * transform, so nothing there can be tested at all.  Left at full level while
 * everything above it is scaled down, that band becomes the loudest thing in
 * the frame, and a noise floor in it then decides the chord: measured, a
 * guitar C major under broadband noise 14 dB down came back as C♯:minMaj7,
 * a root the audio never contained.  Gating it by the mean of what COULD be
 * tested keeps the registers in proportion, and the same case then reads
 * C:maj6 — still wrong, but wrong about the quality of the right chord.
 */
export function suppressHarmonics(
  frame: Float32Array, layout: CqtLayout, strength: number,
  out = new Float32Array(frame.length),
): Float32Array {
  if (strength <= 0) { out.set(frame); return out; }
  const perSemitone = layout.binsPerOctave / 12;
  let peak = 0;
  for (let k = 0; k < frame.length; k++) peak = Math.max(peak, frame[k] ?? 0);
  if (peak <= 0) { out.set(frame); return out; }
  const need = peak * HARMONIC_PRESENCE_FLOOR;

  // How sure each bin is that a note below explains it; −1 where none of its
  // subharmonic positions is inside the transform.
  const sure = new Float32Array(frame.length);
  let sum = 0;
  let testable = 0;
  for (let k = 0; k < frame.length; k++) {
    let best = -1;
    for (const partial of PARTIALS) {
      const at = k - partial.semitones * perSemitone;
      const lo = Math.floor(at);
      if (lo < 0 || lo + 1 >= frame.length) continue;
      const t = at - lo;
      const value = (frame[lo] ?? 0) * (1 - t) + (frame[lo + 1] ?? 0) * t;
      best = Math.max(best, Math.min(1, value / need));
    }
    sure[k] = best;
    if (best >= 0) { sum += best; testable += 1; }
  }
  const mean = testable > 0 ? sum / testable : 0;

  for (let k = 0; k < frame.length; k++) {
    const s = sure[k]! < 0 ? mean : sure[k]!;
    out[k] = Math.max(0, (frame[k] ?? 0) * (1 - strength * s));
  }
  return out;
}

// ── Register ────────────────────────────────────────────────────────────────

/**
 * How loud a bin must be, against the frame's loudest, to be read as the
 * lowest note sounding.
 */
export const CHROMA_BASS_FLOOR = 0.12;

/** How far above the lowest note a chord is voiced before the fold discounts it. */
export const CHROMA_REGISTER_OCTAVES = 2;

/** Semitones for that discount to halve, above the register. */
export const CHROMA_REGISTER_HALF_LIFE = 3;

/**
 * The lowest bin carrying a note, or 0 when nothing does.
 *
 * Read from the frame BEFORE suppression: on a plucked string a fundamental
 * can be quieter than its own partials, and suppression is the step that would
 * then take it away.
 */
export function lowestStrongBin(
  frame: Float32Array, floorRatio = CHROMA_BASS_FLOOR,
): number {
  let peak = 0;
  for (let k = 0; k < frame.length; k++) peak = Math.max(peak, frame[k] ?? 0);
  if (peak <= 0) return 0;
  const floor = peak * floorRatio;
  for (let k = 0; k < frame.length; k++) if ((frame[k] ?? 0) >= floor) return k;
  return 0;
}

/**
 * Discount the bins too far above the chord's own bass to be part of it.
 *
 * Suppression removes what a note below explains, and what it cannot remove
 * piles up in one place: above the highest note of the chord, where every bin
 * is some partial of something and no bin is a note. A chord is voiced within
 * about two octaves of its lowest note, so a bin four octaves up is evidence
 * about the instrument, not about the harmony.
 *
 * A ROLLOFF and not a ceiling, because a ceiling is a discontinuity a note can
 * cross between one frame and the next — and because real voicings do reach
 * above it. Measured over the 47 chords: a hard cut two octaves up names 43
 * and cuts the top of a rootless chord voiced over its own bass; halving every
 * three semitones above the same point names 44 and reads that chord as a
 * triad instead of a seventh, which is the cheaper mistake.
 *
 * `fromBin` is `lowestStrongBin` of the unsuppressed frame.
 */
export function weightByRegister(
  frame: Float32Array, layout: CqtLayout, fromBin: number,
  out = new Float32Array(frame.length),
): Float32Array {
  const perSemitone = layout.binsPerOctave / 12;
  const top = fromBin + CHROMA_REGISTER_OCTAVES * layout.binsPerOctave;
  for (let k = 0; k < frame.length; k++) {
    if (k < top) { out[k] = frame[k] ?? 0; continue; }
    const semitonesOver = (k - top) / perSemitone;
    out[k] = (frame[k] ?? 0) * Math.pow(0.5, semitonesOver / CHROMA_REGISTER_HALF_LIFE);
  }
  return out;
}

// ── The lowest note ─────────────────────────────────────────────────────────

/**
 * The pitch class of the LOWEST note sounding, or null.
 *
 * This is the bass, read out of the mix itself, and it settles a question no
 * chroma can: Am7 and C6 are the same four pitch classes — A C E G — and so
 * are Dm7 and F6, Em7 and G6, and every other minor seventh and its relative
 * major sixth.  Folding octaves throws away exactly the information that
 * tells them apart, and this puts one bit of it back.
 *
 * A dedicated bass stem is better and is used when there is one.  But the
 * ambiguity is not rare enough to leave to a setting: a measured progression
 * of Cmaj7–Am7–Dm7–G7 came back as Cmaj7–C6–F6–G7, which is the same notes,
 * the same sound, and the wrong chart.
 *
 * Read AFTER harmonic suppression on purpose.  A fundamental is not predicted
 * by anything below it so it survives suppression, while the partials that
 * would otherwise be mistaken for lower notes do not.
 */
export function lowestPitchClass(
  frame: Float32Array, layout: CqtLayout, floorRatio = 0.25,
): number | null {
  let peak = 0;
  for (let k = 0; k < frame.length; k++) peak = Math.max(peak, frame[k] ?? 0);
  if (peak <= 0) return null;
  const floor = peak * floorRatio;
  for (let k = 1; k < frame.length - 1; k++) {
    const v = frame[k] ?? 0;
    if (v < floor) continue;
    // A local maximum, so the rising skirt of a strong note does not read as
    // a quieter note a third of a semitone below it.
    if (v <= (frame[k - 1] ?? 0) || v < (frame[k + 1] ?? 0)) continue;
    return binPitchClass(layout, k);
  }
  return null;
}

/** The commonest non-null value, or null — a vote over a span's frames. */
export function majorityPitchClass(
  votes: readonly (number | null)[], minShare = 0,
): number | null {
  const counts = new Map<number, number>();
  let voted = 0;
  for (const v of votes) {
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    voted += 1;
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [pc, count] of counts) if (count > bestCount) { bestCount = count; best = pc; }
  if (best === null || voted === 0) return null;
  // A PLURALITY is not a bass note.  The lowest sounding note of an arpeggio
  // is whichever chord tone the pattern is on, so over a beat it might be the
  // root 40 % of the time and the third and fifth 30 % each — and answering
  // "the root" there states something about the harmony that the audio did
  // not say.  `minShare` is what makes it say "nothing" instead.
  return bestCount >= voted * minShare ? best : null;
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
  /**
   * The lowest note sounding in each frame, as a pitch class, or null.
   *
   * The bass, read out of the mix — see `lowestPitchClass` for why it is
   * worth carrying alongside a vector that deliberately discards octaves.
   */
  lowPitches: (number | null)[];
  /** Seconds between frames. */
  hopSec: number;
  /** What the tuning estimate found, in cents from A = 440. */
  tuningCents: number;
  /** Frames that were below the silence floor. */
  silentFrames: number;
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
  const weighted = new Float32Array(layout.bins);
  const frames: Float32Array[] = [];
  const lowPitches: (number | null)[] = [];
  let silentFrames = 0;

  for (const [index, frame] of gram.frames.entries()) {
    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] ?? 0;
    if (sum <= floor || frameRms(index) < SILENCE_RMS) {
      frames.push(new Float32Array(PITCH_CLASSES));
      lowPitches.push(null);
      silentFrames += 1;
      continue;
    }
    shiftForTuning(frame, layout, tuningCents, shifted);
    suppressHarmonics(shifted, layout, opt.harmonicSuppression, suppressed);
    // The register is read from the unsuppressed frame and applied to the
    // suppressed one — suppression is what would remove a bass fundamental
    // quieter than its own partials, and then the register would be measured
    // from whatever survived.
    weightByRegister(suppressed, layout, lowestStrongBin(shifted), weighted);
    const chroma = foldToChroma(weighted, layout);
    // Scaled to its own maximum BEFORE the logarithm.  Measured: compressing
    // raw magnitudes (which are in the thousands here) turned a 75 % / 8 %
    // split into 0.43 / 0.36 — the compression was not lifting quiet notes,
    // it was erasing the difference between every note and every artefact.
    // log(1 + γ·x) only means anything when x is already 0…1.
    lowPitches.push(lowestPitchClass(suppressed, layout));
    peakNormalize(chroma);
    normalize(compress(chroma, opt.gamma));
    frames.push(chroma);
  }

  return { frames, lowPitches, hopSec: hopSize / sampleRate, tuningCents, silentFrames };
}

/** The pitch class a CQT bin belongs to — exported for the self-test. */
export function binPitchClass(layout: CqtLayout, bin: number): number {
  const semitone = Math.round(bin / (layout.binsPerOctave / 12));
  return ((semitone % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
}

/** Centre frequency of a bin — re-exported so callers need one import. */
export { centreHz };
