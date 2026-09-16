// A struck BAR — the mallet instruments.
//
// A bar is not a string, and the difference is the only interesting thing
// about it.  A string's partials are at 1, 2, 3, 4 …; a free bar's are at
//
//     1 : 2.756 : 5.404 : 8.933 : 13.34
//
// which is not a harmonic series and does not sound like a note.  Struck on
// its own, a plain bar rings with a definite pitch and an audible clang
// somewhere between a minor tenth and a twelfth above it, which is why a
// glockenspiel sounds like a glockenspiel and why nobody writes chords for it.
//
// ── What a maker does about that ────────────────────────────────────────────
//
// Undercuts the bar.  Planing an arch into the underside lowers the higher
// modes far more than the fundamental — the second mode has a node where the
// wood is being removed and the first does not — and a maker keeps planing
// until the second mode lands on a musical interval.  Which interval is the
// instrument:
//
//     marimba        1 : 4 : 10        second mode two octaves up
//     vibraphone     1 : 4 : 9.2       the same, in aluminium
//     xylophone      1 : 3 : 6.0       a twelfth — brighter, more cutting
//     glockenspiel   1 : 2.756 : 5.404 not undercut at all
//
// The glockenspiel is the control in that table: its bars are small enough
// that the inharmonic partials die before they offend anybody, so nobody
// bothers, and its ratios are the raw bar's.  Which means this model gets
// checked against a real number rather than against a taste — 2.756 is a
// property of a free beam, not a choice.
//
// Everything else — the decay, the mallet's hardness, the resonator tube —
// follows the same argument the piano's hammer does, and the modes are
// rendered by the same `renderModes` the piano uses.  A bar and a string
// differ in where the partials go, not in what a decaying partial is.

import type { Mode } from './struck-string.js';

export type BarKind = 'marimba' | 'vibraphone' | 'xylophone' | 'glockenspiel';

/** The order the `bar` parameter selects from — an index, like the synth's wave. */
export const BAR_KINDS: readonly BarKind[] = ['marimba', 'vibraphone', 'xylophone', 'glockenspiel'];

export interface BarProfile {
  /** Partial ratios, fundamental first. */
  ratios: readonly number[];
  /**
   * How long each partial rings relative to the fundamental.
   *
   * Written out rather than derived from a slope, because a bar's modes do
   * not follow one: the undercut that tunes mode 2 also changes how well it
   * couples to the air, and wood and metal disagree about which modes they
   * hold on to.
   */
  decays: readonly number[];
  /** Seconds the fundamental rings, at the instrument's middle. */
  ringSeconds: number;
  /** Where the mallet's own softness puts the corner, in hertz. */
  malletHz: number;
  /** Whether the resonator tubes have a motor in them. */
  motor: boolean;
}

export const BAR_PROFILES: Readonly<Record<BarKind, BarProfile>> = {
  // Rosewood, tuned to the octave and the two-octave-plus-major-third.  Wood
  // does not hold a note: the fundamental is a couple of seconds and the
  // partials are gone almost at once, which is why a marimba roll exists.
  marimba: {
    ratios: [1, 4, 10, 19.6],
    decays: [1, 0.22, 0.1, 0.05],
    ringSeconds: 2.1, malletHz: 2400, motor: false,
  },
  // Aluminium, and aluminium rings.  Ten seconds undamped on the low bars is
  // ordinary, which is why this is the one instrument in the family that
  // needs a pedal.
  vibraphone: {
    ratios: [1, 4, 9.2, 16],
    decays: [1, 0.3, 0.16, 0.08],
    ringSeconds: 9, malletHz: 1900, motor: true,
  },
  // Tuned a twelfth rather than an octave, which is most of why it cuts
  // through an orchestra that a marimba disappears into.
  xylophone: {
    ratios: [1, 3, 6, 9.2],
    decays: [1, 0.25, 0.12, 0.06],
    ringSeconds: 0.8, malletHz: 4200, motor: false,
  },
  // Not undercut — see the header.  These are a free beam's own ratios.
  glockenspiel: {
    ratios: [1, 2.756, 5.404, 8.933],
    decays: [1, 0.45, 0.25, 0.14],
    ringSeconds: 4.5, malletHz: 6500, motor: false,
  },
};

export function barProfile(index: number): BarProfile {
  const kind = BAR_KINDS[Math.max(0, Math.min(BAR_KINDS.length - 1, Math.round(index)))];
  return BAR_PROFILES[kind ?? 'marimba'];
}

export interface BarSpec {
  freqHz: number;
  sampleRate: number;
  profile: BarProfile;
  /** 0..1 — a harder stroke reaches the higher modes, as on the piano. */
  velocity: number;
  /** Seconds the fundamental rings, overriding the profile. */
  ringSeconds: number;
  /** Multiplies the profile's mallet corner: soft yarn against hard rubber. */
  hardness: number;
}

/**
 * The modes of one struck bar.
 *
 * Short — four partials, not forty.  A bar radiates almost nothing above its
 * fourth mode, and the brightness people hear in a xylophone is the ATTACK,
 * which is the mallet's own noise and belongs to the voice rather than to the
 * bar.  Padding this list out with inaudible modes would cost time and add
 * a hiss that no mallet instrument has.
 */
export function barModes(spec: BarSpec): Mode[] {
  const corner = Math.max(300, spec.profile.malletHz * spec.hardness
    * Math.pow(0.3 + 0.7 * Math.min(1, Math.max(0, spec.velocity)), 2));
  const nyquist = spec.sampleRate * 0.47;
  const out: Mode[] = [];
  spec.profile.ratios.forEach((ratio, i) => {
    const f = spec.freqHz * ratio;
    if (f >= nyquist) return;
    const soft = 1 / (1 + Math.pow(f / corner, 2));
    // Higher modes start quieter as well as dying sooner: the strike is a
    // blunt object on a wide bar, and a blunt object drives the shapes with
    // more nodes less well.  1/(i+1) is the same falling weight the struck
    // string's 1/n is, and for the same reason.
    const amp = (1 / (i + 1)) * soft;
    if (amp < 1e-4) return;
    out.push({
      freqHz: f, amp,
      t60: Math.max(0.03, spec.ringSeconds * (spec.profile.decays[i] ?? 0.05)),
    });
  });
  return out;
}
