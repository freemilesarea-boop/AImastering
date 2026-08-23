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
}

export const DEFAULT_DRUM_CREDIT: DrumCreditOptions = {
  doubt: 0.5,
  full: 0.08,
};

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
): void {
  const { doubt, full } = options;
  const floor = options.presenceFloor ?? DEFAULT_DRUMS.presenceFloor;
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
      const kick = any > 0 ? evidenceAt(above, templates, KICK_ONLY, b, full) : 0;
      // Doubt is spent only ABOVE the kick's register.  Below it there is
      // nothing to hand the material back TO: the bass shelf claims everything
      // under 90 Hz unconditionally, so doubting a sub bin is not returning it
      // to the arrangement, it is giving the kick to the bass — measured on the
      // easy fixture, exactly that, 킥→베이스 32 % → 41 %.  The bass has its own
      // two claims on that region (the shelf and the comb that follows the
      // note) and does not need a third one made out of the drums' uncertainty.
      const room = 1 - (templates.kick[b] ?? 0);
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
