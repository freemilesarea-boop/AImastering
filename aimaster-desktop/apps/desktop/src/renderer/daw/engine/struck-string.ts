// A struck piano string, computed partial by partial.
//
// ── Why this is not the plucked string with different numbers ────────────────
//
// `string-model.ts` is a Karplus-Strong loop, and a KS loop is HARMONIC by
// construction: the delay line has one length, so partial n sits at exactly
// n·f0 and there is nowhere to put anything else.  A piano string is stiff,
// and stiffness is most of what a piano sounds like:
//
//     f(n) = n · f0 · sqrt(1 + B·n²)
//
// The partials are STRETCHED.  By the 10th partial of a middle-C string the
// stretch is already about 18 cents, and by the 20th it is 70 — which is why
// a piano has to be tuned with stretched octaves, and why a "piano" built out
// of a harmonic string sounds like an electric piano no matter what filter is
// put after it.  There is no EQ that moves a partial.
//
// So this is additive: every partial is placed where the stiffness puts it and
// decays at its own rate.  That costs more per sample than a delay line, and
// it buys the four things below, none of which a KS loop can do at all.
//
// ── The four things ─────────────────────────────────────────────────────────
//
// 1. INHARMONICITY.  Above.  `partialFrequency` is the whole of it, and
//    `inharmonicity()` is a fit — see its own note for what it is fitted to.
//
// 2. THE HAMMER'S STRIKE POINT.  A hammer landing at a fraction p of the
//    string's length cannot excite a partial with a node there, so
//
//        amplitude(n) ∝ |sin(n·π·p)|
//
//    At the usual p ≈ 1/8 that is a NOTCH at the 8th partial, and it is not a
//    coincidence: the 7th partial of a major scale degree is the flat seventh,
//    audibly out of tune with everything, and piano builders put the hammer
//    where it is to kill it.  Modelling the hammer as "a low-pass" loses this
//    entirely, and it is the difference between a piano and a struck tine.
//
// 3. VELOCITY IS BRIGHTNESS, NOT VOLUME.  A hammer hit harder is in contact
//    with the string for LESS time, so its excitation reaches higher.  Here
//    that is a corner frequency that rises with velocity, and the same
//    argument the plucked string already makes about a strum versus a caress.
//
// 4. TWO-STAGE DECAY.  A piano note does not decay exponentially.  It drops
//    fast for a second or so and then hangs on for ten, and the second part
//    is most of what "sustain" means at a piano.  The mechanism is that each
//    string vibrates in two planes: the one perpendicular to the soundboard
//    drives the bridge hard and dies quickly, the one parallel to it barely
//    drives the bridge at all and rings on.  So every partial here is TWO
//    decaying sinusoids, a loud fast one and a quiet slow one, slightly apart
//    in frequency so they beat.
//
//    Stated plainly as a limit: this is a SUM of independent modes, not a
//    coupled model.  Real strings exchange energy — the fast plane feeds the
//    slow one and, later, back again.  A sum reproduces the envelope's shape
//    and the beating and does not reproduce that exchange, so a note held for
//    thirty seconds decays a little too cleanly at the very end.
//
// ── Why a recursion and not Math.sin ────────────────────────────────────────
//
// A decaying sinusoid satisfies
//
//     y[n] = 2·r·cos(ω)·y[n−1] − r²·y[n−2]
//
// which is four arithmetic operations per sample per mode against a `Math.sin`
// and a `Math.pow`.  `renderModes` uses it, and `struck-string-selftest`
// checks the recursion against the closed form it is supposed to equal,
// because a marginally stable two-pole recursion run for a million samples is
// exactly the kind of thing that is right in principle and drifts in practice.
//
// Everything here is deterministic — no `Math.random()` anywhere — for the
// same reason the plucked string is: a bounce has to sound like the preview.

/** One decaying sinusoid: where it is, how loud it starts, how long it rings. */
export interface Mode {
  freqHz: number;
  /** Starting amplitude, linear. */
  amp: number;
  /** Seconds to fall 60 dB. */
  t60: number;
}

/**
 * Where partial n of a stiff string actually sits.
 *
 * B is the inharmonicity coefficient — dimensionless, and for a piano it runs
 * from about 5e-5 in the tenor to 2e-2 at the very top.  At B = 0 this is
 * n·f0 and the string is an ideal one.
 */
export function partialFrequency(f0: number, n: number, B: number): number {
  return n * f0 * Math.sqrt(1 + Math.max(0, B) * n * n);
}

/**
 * How far partial n is stretched, in cents.
 *
 * Exported because it is the readable form of the claim — "the 10th partial
 * of middle C is 18 cents sharp" is checkable against a piano, and
 * `partialFrequency`'s raw hertz are not.
 */
export function stretchCents(f0: number, n: number, B: number): number {
  return 1200 * Math.log2(partialFrequency(f0, n, B) / (n * f0));
}

/**
 * The inharmonicity of a grand piano string at a given MIDI pitch.
 *
 * ── What this is fitted to ──────────────────────────────────────────────────
 *
 * Two published anchor points for a concert grand, which is all a two-term fit
 * can honestly carry:
 *
 *     C4  (MIDI 60, 261.6 Hz)    B ≈ 2.5e-4    (10th partial ~21 cents sharp)
 *     C7  (MIDI 96, 2093 Hz)     B ≈ 4e-3
 *
 * Both are the middle of a wide published spread — a nine-foot concert grand
 * sits below them and a five-foot parlour grand well above, because B falls
 * with the cube of string length.  The first fit used 4e-4 and 8e-3, the top
 * of that spread, and the measured consequence was a 10th partial 34 cents
 * sharp at middle C where a real one is nearer 20: audible as a piano that
 * had been left to go out of tune with itself.
 *
 * log10 B is close to linear in pitch between them, so the main branch is that
 * line, extended in both directions.
 *
 * ── Why there is a second branch ────────────────────────────────────────────
 *
 * Extending the line downwards is wrong, and audibly so.  A piano's bass
 * strings are WOUND — a thin steel core carrying a copper winding — precisely
 * so that they can be heavy without being stiff, and below the bass break they
 * are also foreshortened because the case has to end somewhere.  Both effects
 * push B back UP as the pitch falls, so real inharmonicity is a V with its
 * minimum around the break, not a straight line.  The second branch is that
 * rise; `Math.max` of the two puts the minimum at MIDI 40 — E2, which is
 * where a medium grand's bass break usually is.
 *
 * This is a FIT, not a measurement of any particular instrument, and two
 * pianos of the same size disagree with each other by more than the fit
 * disagrees with either.  `scale` is how an upright differs: shorter strings
 * at the same pitch, so more of everything.
 */
export function inharmonicity(pitch: number, scale = 1): number {
  const treble = Math.pow(10, -3.602 + 0.03344 * (pitch - 60));
  const bass = Math.pow(10, -3.9 - 0.02 * (pitch - 21));
  return Math.max(treble, bass) * Math.max(0.05, scale);
}

export interface StruckStringSpec {
  /** Pitch of the note, in hertz, as the tuner would call it. */
  freqHz: number;
  sampleRate: number;
  /** How much audio to compute.  The tail beyond the decay is silence. */
  seconds: number;
  /** Inharmonicity coefficient — see `inharmonicity`. */
  B: number;
  /** 0..1, how hard the key was struck. */
  velocity: number;
  /**
   * Where the hammer lands, as a fraction of the string.  1/8 on a real
   * grand, a little lower in the bass.  This is the notch — see the header.
   */
  strikePosition: number;
  /**
   * The hammer's corner frequency at full velocity, in hertz.  Lower is a
   * softer, older, more felt-covered hammer.
   */
  hammerHz: number;
  /** Seconds for the fundamental's fast plane to fall 60 dB. */
  t60: number;
  /**
   * How much longer the slow plane rings than the fast one.  This is the
   * aftersound, and at 1 there isn't one.
   */
  aftersound: number;
  /** How loud the slow plane starts, relative to the fast one. */
  aftersoundLevel: number;
  /**
   * How much faster high partials die than the fundamental.  Internal losses
   * in the wire grow with frequency, so this is a real effect and not a tone
   * control — but it is the one knob here with no published number behind it.
   */
  hfDamping: number;
  /** Detune of the unison strings, in cents.  0 is a perfect (and dead) unison. */
  unisonCents: number;
  /** How many strings this note has.  1 in the bass, 2 at the break, 3 above. */
  strings: number;
  /** Hard ceiling on partials, before the Nyquist cut. */
  maxPartials?: number;
  /**
   * Above this partial, the unison collapses to one string.
   *
   * Not a shortcut — a measurement.  Three strings 1.2 cents apart beat at a
   * rate proportional to their frequency, so at the 20th partial they beat
   * twenty times faster than at the fundamental.  By then the partial has also
   * been damped for twenty times as long (see `hfDamping`) and is gone inside
   * a tenth of a second, which is less than one beat period.  A beat whose
   * first cycle never completes is not audible AS a beat; it is a fixed level
   * offset, and summing three strings to get one is cheaper and sounds the
   * same.  What it does change is cost, by rather a lot: see the module note.
   */
  unisonPartials?: number;
  /**
   * Above this partial, there is no slow plane.
   *
   * The aftersound is the part that rings for ten seconds, and only the low
   * partials are still there to ring: at the 20th the fast plane is already
   * down to a tenth of a second, and a slow plane a quarter its height and
   * eight times its length is inaudible under the partials below it.
   */
  aftersoundPartials?: number;
}

/**
 * How many strings a piano note actually has.
 *
 * Wound single strings at the bottom, two through the crossover, three from
 * about F2 up.  It matters more than it sounds like it should: a single
 * string cannot beat with itself, so the bottom octave has a completely
 * different decay character from everything above it.
 */
export function stringsForPitch(pitch: number): number {
  if (pitch < 28) return 1;
  if (pitch < 41) return 2;
  return 3;
}

/**
 * How long the fundamental rings, in seconds, at a given pitch.
 *
 * Fitted the same way as the inharmonicity — anchored at C4 ≈ 12 s and C7
 * ≈ 1.2 s, which is a slope of about 1.1 in log-log — and then CLAMPED at the
 * bottom, because extending that slope to A0 predicts 145 seconds and the
 * real answer is nearer 40.  The clamp is the honest way to say the two-term
 * fit has run out; a third term would be fitting noise.
 */
export function ringSeconds(freqHz: number): number {
  const raw = 12 * Math.pow(261.63 / Math.max(20, freqHz), 1.1);
  return Math.min(30, Math.max(0.35, raw));
}

/**
 * Every mode of one struck note: partials × strings × two planes.
 *
 * Exported so the tests can look at where the partials landed and how loud
 * they started, rather than inferring it from the audio — a test that can only
 * hear the result finds out that the hammer notch is missing several hours
 * after a test that can read `modes` would have.
 */
export function struckModes(spec: StruckStringSpec): Mode[] {
  const f0 = Math.max(8, spec.freqHz);
  const nyquist = spec.sampleRate * 0.5;
  // Stop short of Nyquist: a mode sitting on it is a half-sample-rate
  // alternation, which is not a partial, it is a buzz.
  const ceiling = nyquist * 0.94;
  const cap = Math.max(1, spec.maxPartials ?? 48);

  const vel = Math.min(1, Math.max(0, spec.velocity));
  // Contact time falls with velocity, so the corner rises.  Squared rather
  // than linear because the audible change between a whisper and a fortissimo
  // is much bigger than the change between forte and fortissimo.
  //
  // The constants put a pianissimo's corner near 600 Hz and a fortissimo's at
  // the full `hammerHz`, which is close to three octaves.  The first pair was
  // 0.32/0.68 and measured only 6.6 dB of high-frequency swing across the
  // whole velocity range — a velocity knob that was still mostly a volume
  // knob, which is the exact thing this model exists to stop being.
  const corner = Math.max(180, spec.hammerHz * Math.pow(0.22 + 0.78 * vel, 2));
  const p = Math.min(0.5, Math.max(0.02, spec.strikePosition));

  const strings = Math.max(1, Math.round(spec.strings));
  const unisonTo = spec.unisonPartials ?? 12;
  const slowTo = spec.aftersoundPartials ?? 16;
  const modes: Mode[] = [];

  for (let n = 1; n <= cap; n++) {
    const f = partialFrequency(f0, n, spec.B);
    if (f >= ceiling) break;

    // The hammer: its strike point, the 1/n of a struck string's initial
    // shape, and its own softness.
    const notch = Math.abs(Math.sin(n * Math.PI * p));
    const soft = 1 / (1 + Math.pow(f / corner, 2));
    const amp = (notch / n) * soft;
    // 90 dB under the fundamental and falling.  The first threshold was
    // 1e-5, which at a pianissimo's corner frequency kept two dozen partials
    // per note that were each a hundred thousandth of the note's amplitude.
    if (amp < 3e-5) continue;

    // Internal losses rise with frequency, so a partial's ring is shorter
    // than the fundamental's by a factor that grows with n².
    const fast = Math.max(0.02, spec.t60 / (1 + spec.hfDamping * (n * n - 1)));
    const slow = fast * Math.max(1, spec.aftersound);

    const voices = n <= unisonTo ? strings : 1;
    for (let s = 0; s < voices; s++) {
      // Unison spread, centred: with three strings that is one on pitch and
      // one either side, which is how a tuner leaves it.
      const offset = voices === 1 ? 0 : (s / (voices - 1) - 0.5) * 2 * spec.unisonCents;
      const detuned = f * Math.pow(2, offset / 1200);
      if (detuned >= ceiling) continue;
      // The collapsed unison keeps the note's energy: one string standing in
      // for three has to be as loud as the three were, or the top of every
      // note would step down at partial 13.
      const share = 1 / voices;

      modes.push({ freqHz: detuned, amp: amp * share, t60: fast });
      if (n <= slowTo && spec.aftersoundLevel > 0.001 && spec.aftersound > 1.001) {
        // The slow plane, a shade off the fast one.  Same string, so the
        // offset is tiny — a plane that rang at the same frequency would not
        // beat, and beating is what an aftersound audibly does.
        modes.push({
          freqHz: detuned * Math.pow(2, 0.35 / 1200),
          amp: amp * share * spec.aftersoundLevel,
          t60: slow,
        });
      }
    }
  }
  return modes;
}

/**
 * Sum a set of decaying sinusoids into a buffer.
 *
 * Partial-major, not sample-major: each mode's two-pole state stays in
 * registers for its whole run, and the only memory touched repeatedly is the
 * output, which streams.  The other order reloads every mode's state on every
 * sample and measured several times slower.
 *
 * A mode is dropped once it is below −70 dB, since it will never come back —
 * which is what keeps a 30-second bass ring from paying for 48 partials all
 * the way to the end.
 */
export function renderModes(
  modes: readonly Mode[], sampleRate: number, seconds: number,
): Float32Array {
  const n = Math.max(1, Math.round(sampleRate * Math.max(0.005, seconds)));
  const out = new Float32Array(n);

  for (const mode of modes) {
    const w = (2 * Math.PI * mode.freqHz) / sampleRate;
    if (!(w > 0) || w >= Math.PI) continue;
    // r^(t60·sr) = 10^(−3): sixty decibels is a factor of a thousand.
    const r = Math.pow(10, -3 / (Math.max(0.005, mode.t60) * sampleRate));
    // Everything past here is inaudible, so it is not computed.
    const audible = Math.min(n, Math.ceil(mode.t60 * sampleRate * (70 / 60)) + 2);

    const c = 2 * r * Math.cos(w);
    const r2 = r * r;
    let y2 = 0;                               // y[0] — sine phase starts at zero
    let y1 = mode.amp * r * Math.sin(w);      // y[1]
    if (audible > 1) out[1] = (out[1] ?? 0) + y1;
    for (let i = 2; i < audible; i++) {
      const y = c * y1 - r2 * y2;
      out[i] = (out[i] ?? 0) + y;
      y2 = y1;
      y1 = y;
    }
  }
  return out;
}

/** The closed form `renderModes` is a recursion for.  Used by its test. */
export function modeSample(mode: Mode, sampleRate: number, index: number): number {
  const w = (2 * Math.PI * mode.freqHz) / sampleRate;
  const r = Math.pow(10, -3 / (Math.max(0.005, mode.t60) * sampleRate));
  return mode.amp * Math.pow(r, index) * Math.sin(w * index);
}

/**
 * The reference loudness a struck note is divided by.
 *
 * The modes are summed raw, and their sum depends on velocity — which is the
 * point, since a harder blow adds partials rather than just gain.  Dividing by
 * the CURRENT sum would undo exactly that, so the divisor is the sum at full
 * velocity: loud notes come out near one, quiet ones come out quieter, and the
 * dynamic range survives.
 */
export function referenceSum(spec: StruckStringSpec): number {
  const loudest = struckModes({ ...spec, velocity: 1 });
  let sum = 0;
  for (const mode of loudest) sum += mode.amp;
  return Math.max(1e-6, sum);
}

/** One struck note, as samples. */
export function struckString(spec: StruckStringSpec): Float32Array {
  const modes = struckModes(spec);
  const norm = 1 / referenceSum(spec);
  const out = renderModes(modes, spec.sampleRate, spec.seconds);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * norm;
  return out;
}
