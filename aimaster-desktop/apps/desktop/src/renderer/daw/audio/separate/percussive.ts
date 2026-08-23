// Is this bin a drum?
//
// The harmonic/percussive split answers a narrower question than it looks like
// it answers.  It asks whether a bin is a VERTICAL stripe or a HORIZONTAL one —
// whether the energy here is brief and broadband or steady and narrow — and
// then the separator has been treating "vertical" as a synonym for "drum".  On
// the synthetic fixture that held.  On a real record, measured band by band, it
// broke in both directions at once:
//
//   THE KICK'S SUB IS HORIZONTAL.  A modern kick is compressed until its low
//   tail holds for a quarter of a second, which to a median filter is a
//   sustained note.  Measured on a real song, 102 % of the drums' energy below
//   45 Hz and 87 % of it at 63 Hz came back inside the BASS stem — and the
//   drums stem kept 5 % of its own bottom octave.  That record's drums hold
//   over half their energy at 63 Hz, so this alone is most of what was wrong.
//
//   THE ARRANGEMENT IS VERTICAL.  A guitar is picked, a piano is struck, a
//   string section bows in unison, and every one of those is a transient.  Over
//   1–16 kHz, 67 to 90 % of the "그 외" truth landed in the drums stem.  So did
//   half the sibilance: a "s" is a burst of noise and the vocal was allowed to
//   claim only 35 % of one.
//
// Both are the same missing question.  "Vertical" is evidence that something
// was STRUCK; it is not evidence about WHAT.  `drums.ts` already answers the
// second question — it finds the onsets and scores each one against the four
// kit templates — and that answer was only being used to split the drum stem
// after the fact.  Here it is used to decide what the drum stem IS.
//
//     p = (1−h)·(1 − doubt·(1−e))  +  h · sustain · e
//
// with `h` the harmonic mask and `e` the drum evidence at that frame and bin.
// The first term hands back percussive-looking material that no drum was struck
// for; the second lets a drum that WAS struck keep ringing through material a
// median filter calls sustained.
//
// At `doubt = 0, sustain = 0` this is exactly `1 − h` — the behaviour before it
// existed — which is what the mask algebra in `separate.ts` was written against
// and what its sum-to-one proof still rests on.  The two numbers below were
// measured, and the measurements are in `separate-selftest.ts`.

import { DEFAULT_DRUMS, DRUM_PARTS, type DrumPart } from './drums.js';
import { runningMedian } from './median.js';

export interface DrumCreditOptions {
  /**
   * How much percussive-looking material is handed back when nothing was
   * struck there.
   *
   * Not 1.  The onset detector misses hits — a ghost note under a loud bar, a
   * hat inside a cymbal wash — and at 1 every frame it missed would be given
   * away entirely.  This is the fraction it is allowed to take back, so a
   * missed hit comes out quieter rather than absent.
   *
   * What it costs, said plainly: this one is a TRADE, not a free win.  Measured
   * on the hard fixture at 0.5 against 0, it takes three points off drum
   * recovery and gives back four points each of 그 외 and 보컬 that were landing
   * in the drums stem.  That is the right side of the trade on a record — on
   * the real song 그외→드럼 is 26 % and 보컬→드럼 21 %, both far worse than they
   * are here — and it would be the wrong side on a sparse recording of a kit.
   *
   * Scaling it by how sure the classifier was that anything was struck at all
   * was built and measured: it changed nothing to three decimal places, because
   * a kit rings above the floor in almost every frame of a record, so there is
   * no meaningful population of "no opinion" frames for it to protect.  It was
   * removed rather than kept as a guard that never fires.
   */
  doubt: number;
  /**
   * Evidence at or above this counts as a whole drum.
   *
   * `drums.ts` normalises its presences so a single hit's four shares sum to
   * one, then spreads them over each part's decay; a bin under a struck drum's
   * own template therefore sees something well under one, and this is the
   * divisor that turns it into a fraction.
   */
  full: number;
  /**
   * The floor `drums.ts` put under its presences, so it can be subtracted back
   * off.  Defaults to that file's own value; it is here only so a caller who
   * changes one changes both.
   */
  presenceFloor?: number;
  /**
   * How many frames the sub-band floor looks over.
   *
   * It has to be longer than a kick tail and shorter than a bass note, and
   * those two are not far apart: a compressed kick rings for about a quarter of
   * a second and a bass note at 120 BPM lasts half of one.  At the separation
   * hop — 1024 samples, so about 21 ms — 24 frames is half a second: twice the
   * tail, and one note.
   *
   * Both ends of that were measured and both ends cost something.  Too short
   * and the median tracks the kick it is meant to ignore: at 8 frames the hard
   * fixture keeps 드럼→베이스 at 15 % against 8 %.  Too long and it lags a
   * CHANGE OF NOTE — a running median takes half a window to cross a step, so
   * every note change leaves the excess reading high and the kick claims the
   * new note's first half-second: at 48 frames the easy fixture's 베이스 회수 is
   * 48 % against 67 % at 8.  24 is where the two curves cross.
   */
  floorFrames?: number;
}

export const DEFAULT_DRUM_CREDIT: DrumCreditOptions = {
  doubt: 0.5,
  full: 0.08,
  floorFrames: 24,
};

// A note on something that is NOT here.  The measured excess was gated on the
// onset detector's opinion, so that only a bin under a hit the detector had
// actually FOUND could be claimed.  Swept from a light touch to a hard gate it
// was monotonic and every setting was worse than none: the whole value of the
// floor is that it sees the part of the tail the exponential envelope has
// already given up on, and a gate made of that envelope hands exactly that part
// back.  Ungated, 드럼→베이스 is 8 % on the hard fixture; at the lightest gate
// that measured anything it is 16 %, and at a full one it is 26 % — which is
// the number without the floor at all.

/**
 * How many bins the kick's register covers — where the sub floor is needed.
 *
 * The kick template is the definition of "the kick's register", so this asks
 * it rather than repeating a frequency.
 */
export function subBinCount(kickTemplate: Float32Array, bins: number): number {
  let last = 0;
  for (let b = 0; b < bins; b++) if ((kickTemplate[b] ?? 0) > 0) last = b;
  return Math.min(bins, last + 1);
}

/**
 * How much of each sub bin is NOT the bass note, 0…1.
 *
 * Under the kick's ceiling two things are playing and the onset detector only
 * knows about one of them.  What separates them is not frequency — they are in
 * the same octave, which is the whole problem — it is PERSISTENCE:
 *
 *   the bass note is what is always there;
 *   the kick is what is sometimes there.
 *
 * So take the median of each bin over a window far longer than a kick tail.  A
 * kick that rings for a quarter of a second cannot move the median of two
 * seconds; a bass note holding a pitch is the median.  Everything above it is
 * the kick, and no onset detector is involved — which matters, because the
 * onset envelope is an exponential guess at how long a hit lasts and this is a
 * measurement of how long it actually lasted.
 *
 * A note on something that is NOT here.  The claim was once capped at the
 * MEDIAN excess across the whole register, on the theory that a kick is a thump
 * that lifts the bottom octave at once while a bass note lifts only its own
 * partials.  It reads well and it is false: a kick is a PITCHED drum — the real
 * song's holds 52 % of its energy in one band and 29 % in the next — so the cap
 * could not tell it from a bass note either.  Measured, it left 드럼→베이스 at
 * 20 % against 8 % without it.
 *
 * Protecting the tracked NOTE instead — letting the kick claim what is above
 * the floor except where the bass's own fundamental and harmonics are — was
 * built and measured too, and it bought three points of 베이스 회수 on the easy
 * fixture for a quarter of a decibel on the hard one.  It does so little
 * because at these frequencies the two are often the SAME note: that fixture's
 * kick sweeps 60 → 35 Hz straight through a bass sitting at 55.  Nothing here
 * separates a kick from a bass playing its pitch, and the honest place to say
 * so is here rather than in a knob that pretends otherwise.
 *
 * What this costs is real and is in `docs/DAW.md`: the bass stem comes back
 * smaller as well as cleaner, because its own note attacks rise above its floor
 * too.  On the hard fixture 베이스 회수 is 48 % against 62 %, while its SI-SDR
 * goes from −3.7 dB to +0.6 — the stem it loses was mostly somebody else's kick.
 *
 * `out` is frames × subBins, not frames × bins: the kick's register is about
 * fourteen bins at a 4096-point transform, and a full-size buffer for it would
 * be sixteen megabytes to hold eighty kilobytes of answer.
 */
export function kickExcess(
  out: Float32Array, magnitude: Float32Array, frames: number, bins: number,
  subBins: number, options: DrumCreditOptions = DEFAULT_DRUM_CREDIT,
): void {
  const width = Math.max(1, options.floorFrames ?? DEFAULT_DRUM_CREDIT.floorFrames ?? 96);
  const scratch = new Float32Array(width + 1);
  // The column is COPIED OUT rather than medianed in place through a stride.
  // `runningMedian` writes its answer at the same offsets it reads from — it is
  // built to filter a spectrogram into another spectrogram — so handing it a
  // frames-long output and a frames-long stride writes past the end of it and
  // leaves the answer as zeros.  Zeros here read as "the bass is silent", which
  // gives the kick every bin under 160 Hz and empties the bass stem: measured,
  // 베이스 회수 62 % → 7 % before this was found.
  const column = new Float32Array(frames);
  const floor = new Float32Array(frames);
  for (let b = 0; b < subBins; b++) {
    for (let f = 0; f < frames; f++) column[f] = magnitude[f * bins + b] ?? 0;
    runningMedian(column, floor, 0, frames, 1, width, scratch);
    for (let f = 0; f < frames; f++) {
      const m = column[f] ?? 0;
      out[f * subBins + b] = m > 0 ? Math.max(0, 1 - (floor[f] ?? 0) / m) : 0;
    }
  }

}

// A note on something that is NOT here.  The second term once had a weight of
// its own — how much of a harmonic bin a struck kick was allowed to claim —
// and it was swept from 0 to 1 against the fixture.  It was monotonic: the
// best value was always the largest one, so the knob could only ever be used
// to make the result worse, and `full` was doing all of the real work by
// deciding when the evidence counts as whole.  It was removed rather than
// shipped at 1.

/**
 * How much of a strike this bin is under, 0…1.
 *
 * `above` is each part's presence with the floor already taken off — the floor
 * is `drums.ts`'s tie-breaker for frames between hits, not evidence that
 * anything was struck, and reading it as evidence gives every drum template a
 * standing claim on the whole record.  Measured, that alone cost 1.9 dB.
 */
export function evidenceAt(
  above: Readonly<Record<DrumPart, number>>,
  templates: Record<DrumPart, Float32Array>,
  parts: readonly DrumPart[], bin: number, full: number,
): number {
  let raw = 0;
  for (const part of parts) raw += (above[part] ?? 0) * (templates[part][bin] ?? 0);
  return Math.min(1, raw / Math.max(full, 1e-6));
}

const KICK_ONLY: readonly DrumPart[] = ['kick'];

/**
 * How strongly ANY template reaches each bin, 0…1.
 *
 * This is the difference between "the classifier says no drum" and "the
 * classifier was not asked".  Only the first is evidence.
 */
export function templateCoverage(
  templates: Record<DrumPart, Float32Array>, bins: number,
): Float32Array {
  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let cover = 0;
    for (const part of DRUM_PARTS) cover = Math.max(cover, templates[part][b] ?? 0);
    out[b] = cover;
  }
  return out;
}

/**
 * The drum credit `p`, written into `out` frame-major.
 *
 * One fused pass rather than an evidence buffer and a second pass over it:
 * each of these arrays is frames × bins floats, sixteen megabytes on a
 * thirty-second chunk, and the separator already holds six of them.
 */
export function drumCredit(
  out: Float32Array, harmonic: Float32Array,
  presence: Record<DrumPart, Float32Array>,
  templates: Record<DrumPart, Float32Array>,
  frames: number, bins: number,
  options: DrumCreditOptions = DEFAULT_DRUM_CREDIT,
  excess: Float32Array | null = null, subBins = 0,
): void {
  const { doubt, full } = options;
  const floor = options.presenceFloor ?? DEFAULT_DRUMS.presenceFloor;
  const coverage = templateCoverage(templates, bins);
  const above: Record<DrumPart, number> = { kick: 0, snare: 0, toms: 0, cymbals: 0 };
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    let any = 0;
    for (const part of DRUM_PARTS) {
      const v = Math.max(0, (presence[part][f] ?? 0) - floor);
      above[part] = v;
      any += v;
    }
    for (let b = 0; b < bins; b++) {
      const i = base + b;
      const h = harmonic[i] ?? 0;
      const e = any > 0 ? evidenceAt(above, templates, DRUM_PARTS, b, full) : 0;
      let kick = any > 0 ? evidenceAt(above, templates, KICK_ONLY, b, full) : 0;
      // In the kick's register, prefer the measured excess over the guessed
      // envelope.  MAX, not multiply: they are two ways of knowing the same
      // thing, and a kick that the onset detector missed still shows up above
      // the floor.  Scaled by the template so the claim fades out with the
      // register rather than stopping at an edge.
      if (excess !== null && b < subBins) {
        const measured = (excess[f * subBins + b] ?? 0) * (templates.kick[b] ?? 0);
        if (measured > kick) kick = measured;
      }
      // How much doubt belongs at this bin.  Two things switch it off:
      //
      //   BELOW THE KICK there is nothing to hand the material back TO.  The
      //   bass shelf claims everything under 90 Hz unconditionally, so doubting
      //   a sub bin is not returning it to the arrangement, it is giving the
      //   kick to the bass — measured on the easy fixture, exactly that:
      //   킥→베이스 32 % → 41 %, 킥 회수 80 % → 70 %.
      //
      //   WHERE NO TEMPLATE REACHES the classifier has no opinion, and its
      //   silence is not a verdict.  All four curves are exactly 0 from 620 Hz
      //   to 1200 Hz — see `drums.ts` for why that is right of them — and
      //   without this the doubt term read that as "not a drum" and took half
      //   of every drum at a kilohertz.  On the real song 드럼→드럼 read
      //   63 % · 25 % · 58 % across three adjacent bands: a notch in the drum
      //   stem's spectrum, which is a scooped snare to a listener however the
      //   score reads.
      const room = (coverage[b] ?? 0) * (1 - (templates.kick[b] ?? 0));
      const struck = (1 - h) * (1 - doubt * room * (1 - e));
      const rings = h * kick;
      // Clamped because nothing stops the two terms summing past one on a bin
      // that is both plainly percussive and under a confident kick.  A mask
      // above one would put more energy in the drum stem than the mix contains,
      // and every other stem would come back negative to pay for it.
      out[i] = Math.max(0, Math.min(1, struck + rings));
    }
  }
}
