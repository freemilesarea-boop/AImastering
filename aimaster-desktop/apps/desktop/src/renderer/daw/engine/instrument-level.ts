// What "Level 0.7" means, and why it is not the same number on every
// instrument.
//
// Measured before any of this was written: playing ONE phrase through the
// five instruments at their own defaults put them 16.4 LU apart, and three
// of the five went over 0 dBFS on a four-note chord played as hard as MIDI
// allows.  Switching instrument was therefore a level change, and the loud
// ones clipped before the mixer ever saw them.
//
// The fix is NOT to move the Level knob.  Level is a knob the user reaches
// for, so it has to sit somewhere usable and mean the same thing everywhere;
// the numbers normalisation actually needs are 0.08 for the poly synth and
// 0.06 for the Rhodes, and a Level resting at 6% reads as broken and leaves
// no resolution underneath it.  So the knob rests at CALIBRATED_LEVEL on
// every instrument and the difference lives in INSTRUMENT_TRIM, where the
// user never has to look at it.
//
// Every number in that table is MEASURED, not chosen — rendered through the
// reference material below and metered with the app's own loudness meter.
//
// Measured IN THE APP, which turned out to matter: `node-web-audio-api`, the
// renderer the test suite uses, is not the one the user hears.  The two agree
// exactly wherever the audio is arithmetic this repo wrote — buffers through
// biquads, and now the synth, whose waves are built from explicit harmonic
// coefficients — and disagree wherever an implementation gets to choose,
// which is its own band-limited oscillators.  It was 1.40 dB on the poly
// synth until that synth stopped using the built-in `sawtooth`; the drum kit,
// still built from them, is 0.85 LU apart.
//
// So `measure-levels-in-app.mjs` derives these against the running app, and
// `instrument-level-selftest.ts` re-measures under node and fails on drift
// from what THAT renderer saw when they were set.

/** One note in the reference material.  Seconds, not beats: no session here. */
export interface LevelEvent {
  pitch: number;
  /** Seconds from the start of the render. */
  at: number;
  dur: number;
  vel: number;
}

/**
 * Where a single instrument sits when its Level is at rest.
 *
 * −26 LUFS puts the reference phrase's peaks between −12 and −6 dBFS, which
 * is the gain staging every mixing text asks for and leaves a mix of twenty
 * tracks room to sum.  It is deliberately far below a mastered −14: this is
 * one track, not a record.
 */
export const LEVEL_TARGET_LUFS = -26;

/**
 * The ceiling a REALISTIC worst case may not cross — a four-note chord, or a
 * whole bar of drums, played as hard as MIDI goes.
 *
 * This is not a promise that nothing can ever clip: pile on ten voices and
 * it will.  It is the promise that ordinary hard playing does not, which is
 * the case that was failing.
 */
export const LEVEL_PEAK_CEILING_DBTP = -3;

/** Where the Level knob rests, on every instrument, once calibrated. */
export const CALIBRATED_LEVEL = 0.7;

/**
 * Per-instrument output trim.
 *
 * Each number is the previous one times `10^(shift/20)`, where
 *
 *     shift = min(LEVEL_TARGET_LUFS − measured LUFS,
 *                 LEVEL_PEAK_CEILING_DBTP − measured hard-hit peak)
 *
 * — loudness decides unless that would push the hard hit over the ceiling,
 * and then the ceiling decides.  The kit is the one the ceiling decides: it
 * is eleven kits, its loudness is taken from the median and its ceiling from
 * the loudest, so the family lands near −27 rather than −26.
 *
 * The acoustic guitar used to be the other one — 23 dB of crest, and
 * bringing it to −26 would have put its hard chord at −2.9.  It is not any
 * more.  Its tone filter's `Q` was written as a cookbook 0.707 where Web
 * Audio reads decibels (see `BUTTERWORTH_Q`), and the 0.7 dB of resonance
 * that made was worth 2.4 dB of PEAK on a plucked transient and almost
 * nothing in loudness: with the filter corrected the same chord peaks at
 * −4.97, so the ceiling no longer binds the guitar at all.
 *
 * That correction is also why four of these numbers are not what the in-app
 * measurement produced.  A plain rolloff where there had been a resonant
 * bump made the plucked instruments and the kit quieter — agtr 0.42 dB, egtr
 * 1.37, bass 1.09, the median kit 0.72 — and each trim was multiplied back
 * by exactly that, restoring every instrument to the loudness the reference
 * table already records.  The shift is a filter's magnitude, which does not
 * depend on the sample rate, so applying it to a 48 kHz table from a 44.1
 * kHz measurement is sound where re-deriving the table from 44.1 would not
 * have been — the bass is a delay line and reads 0.13 LU apart at the two
 * rates.
 *
 * Run `measure-levels-in-app.mjs` to re-derive them; a correct table makes it
 * print a shift of 0 for every instrument.
 *
 * The sampler is 1 on purpose.  Its loudness is the loudness of the file the
 * user dropped in, and no constant here can know that.
 */
export const INSTRUMENT_TRIM = {
  polysynth: 0.1326,
  epiano: 0.2276,
  piano: 0.5813,
  upright: 0.6473,
  wavesynth: 0.0943,
  analog: 0.2012,
  fm: 0.0762,
  drummachine: 0.3183,
  bass: 0.1996,
  mallet: 0.2005,
  organ: 0.0755,
  agtr: 0.4520,
  egtr: 0.3172,
  drumkit: 0.6127,
  bowed: 0.0206,
  sampler: 1,
} as const;

/**
 * The Level default each instrument shipped with before calibration.
 *
 * Kept because a session saved by an older build stored a Level that meant
 * one of these, and opening it has to re-read that number in the new scale.
 * See the v2 → v3 migration.
 */
export const LEGACY_LEVEL_DEFAULTS: Readonly<Record<string, number>> = {
  polysynth: 0.22,
  epiano: 0.25,
  agtr: 0.32,
  egtr: 0.3,
  drumkit: 0.8,
  sampler: 0.7,
};

/**
 * The instruments that existed when the calibration happened.
 *
 * `LEGACY_LEVEL_DEFAULTS` is a migration table, and a migration table is a
 * claim about what a v2 file on disk can contain.  These six are what such a
 * file can contain; an instrument added afterwards cannot appear in one, so
 * it has no old Level to re-read and must not have an entry here.  Giving it
 * one would not break anything — no session would ever match — it would make
 * the table say something untrue about the past, which is the only thing a
 * table like this is for.
 *
 * So this list is what the level suite checks the migration table against,
 * rather than checking it against "every instrument", which is what it used
 * to do and which fails the moment an instrument is added.
 */
export const PRE_CALIBRATION_INSTRUMENTS: readonly string[] = [
  'polysynth', 'epiano', 'agtr', 'egtr', 'drumkit', 'sampler',
];

// ── The reference material ───────────────────────────────────────────────────
//
// ONE phrase for every melodic instrument and ONE beat for every kit.  A
// patch measured on its own favourite material is not measured.

export const REFERENCE_BPM = 92;
const BEAT = 60 / REFERENCE_BPM;

/** The root each instrument is measured at — guitars an octave up from keys. */
export const REFERENCE_ROOT: Readonly<Record<string, number>> = {
  polysynth: 48, epiano: 48, agtr: 52, egtr: 52, piano: 48, upright: 48, bass: 33, mallet: 60, organ: 48, wavesynth: 48, analog: 48, fm: 48,
  // The violin's open G is 55; a reference phrase rooted lower would be asking
  // the instrument for notes it does not have.
  bowed: 55,
};

/** A maj7 chord, an eighth-note line over it, then the chord up a fourth. */
export function referencePhrase(root: number): LevelEvent[] {
  const chord = [0, 4, 7, 11].map((i) => root + i);
  const line = [12, 11, 9, 7, 4, 7, 9, 11];
  const out: LevelEvent[] = [];
  for (const p of chord) out.push({ pitch: p, at: 0, dur: BEAT * 2.2, vel: 0.62 });
  line.forEach((s, i) => out.push({
    pitch: root + s, at: BEAT * (2.2 + i * 0.5),
    dur: BEAT * 0.45, vel: 0.7 - (i % 2) * 0.12,
  }));
  for (const p of chord) out.push({ pitch: p + 5, at: BEAT * 6.4, dur: BEAT * 2.6, vel: 0.7 });
  return out;
}

/** Seconds of silence the phrase needs to ring out in. */
export const REFERENCE_PHRASE_SECONDS = 9.5;

/** The worst a player realistically does: four notes at once, as hard as MIDI goes. */
export function hardChord(root: number): LevelEvent[] {
  return [0, 4, 7, 11].map((i) => ({ pitch: root + i, at: 0.05, dur: 2.0, vel: 1 }));
}

const KICK = 36, SNARE = 38, HAT = 42, HAT_OPEN = 46, CRASH = 49, RIDE = 51;

/**
 * Two bars of a straight beat.  `velocityScale` above 1 is the hard case —
 * a whole bar hit as hard as the kit can be hit.
 */
export function referenceBeat(velocityScale = 1): LevelEvent[] {
  const out: LevelEvent[] = [];
  const hit = (pitch: number, b: number, vel: number): void => {
    out.push({ pitch, at: b * BEAT, dur: 0.3, vel: Math.min(1, vel * velocityScale) });
  };
  hit(CRASH, 0, 0.8);
  for (const b of [0, 2.5, 4, 6.5]) hit(KICK, b, 0.95);
  for (const b of [1, 3, 5, 7]) hit(SNARE, b, 0.85);
  for (let i = 0; i < 16; i += 1) {
    hit(i % 8 === 7 ? HAT_OPEN : HAT, i * 0.5, i % 2 === 0 ? 0.55 : 0.38);
  }
  for (const b of [4.25, 5.75]) hit(RIDE, b, 0.5);
  return out;
}

/** Seconds the two-bar beat needs. */
export const REFERENCE_BEAT_SECONDS = 6;
