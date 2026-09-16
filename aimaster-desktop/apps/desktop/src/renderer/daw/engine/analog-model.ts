// What actually makes a synthesiser sound analogue.
//
// "Add noise and detune it" is the usual answer and it is wrong — a detuned
// digital oscillator is still a digital oscillator, just two of them.  The
// differences that matter are six, and every one of them is a thing a
// mathematically perfect oscillator does NOT do:
//
//   1. THE PITCH WANDERS.  A VCO is an analogue integrator and its frequency
//      moves with temperature, supply and component ageing.  Two oscillators
//      nominally in unison are never in unison, and the error CHANGES over
//      seconds rather than sitting still.  This is the single most
//      recognisable thing, and it is not detune: detune is a fixed offset,
//      drift is a moving one.
//
//   2. THE OSCILLATORS ARE FREE-RUNNING.  Nothing resets them when a key goes
//      down, so the same note struck twice starts at a different point in the
//      cycle and a chord's oscillators have no fixed phase relationship.  The
//      attack transient is different every time, and two notes a fifth apart
//      sum differently on every repeat.
//
//   3. EVERY VOICE IS DIFFERENT HARDWARE.  A Prophet-5 has five filters and
//      five VCAs, built from components with a tolerance, so voice 1 and
//      voice 4 do not have the same cutoff or the same envelope times.  A
//      chord is five slightly different instruments playing together, which
//      is why an analogue poly sounds wide before anybody touches a chorus.
//
//   4. THE FILTER IS NONLINEAR.  A transistor ladder saturates: the resonance
//      limits itself instead of exploding, driving it harder changes the
//      harmonic content rather than just the level, and — the part everybody
//      knows — IT LOSES BASS AS THE RESONANCE COMES UP, because the feedback
//      subtracts the low end.  A clean state-variable filter does none of
//      this, and no amount of EQ afterwards puts it back.
//
//   5. THE ENVELOPES ARE CAPACITORS.  Charge and discharge are exponential,
//      not linear.  An exponential decay spends most of its time near the
//      bottom, which is why an analogue envelope sounds snappy at settings
//      where a linear one sounds flat.
//
//   6. NOTHING IS BAND-LIMITED FOR FREE.  A real VCO's saw has every harmonic
//      and the ear never hears aliasing because there is no sample rate.  A
//      digital one has to be made band-limited deliberately, and the standard
//      way is PolyBLEP — which is used here rather than a wavetable because
//      pulse width has to be CONTINUOUS, and a table would need a frame for
//      every width.
//
// ── Why the drift is a sum of sines and not filtered noise ──────────────────
//
// This engine's standing rule is that an offline bounce is bit-identical to
// the preview, so every source of variation has to be a FUNCTION of the note
// rather than a running generator.  A random walk built by filtering noise
// has to be played from t = 0 to know its value at t, and an offline render
// that starts in the middle of a held note would get a different answer.
// Three sines at incommensurate rates, with phases seeded from the note, are
// closed-form at any t and look like a slow random walk over the seconds a
// note lasts.  The same argument the sample-and-hold LFO makes.

/** Deterministic 0…1 from a few integers.  The only randomness in the model. */
export function analogHash(a: number, b: number, c = 0): number {
  let h = (Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 40503) ^ Math.imul(c | 0, 2246822519)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 2246822519) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/**
 * How far a VCO has wandered at time `t`, in cents.
 *
 * Three components at 0.07, 0.19 and 0.53 Hz — slow enough to hear as
 * wandering rather than as vibrato, and incommensurate so the sum does not
 * repeat inside a note anybody will play.  `depth` is the peak excursion in
 * cents; a well-serviced VCO sits around 2 to 4, a cold or elderly one at 10
 * and above, which is where "vintage" starts meaning "out of tune".
 */
export function driftCents(t: number, depth: number, seed: number): number {
  const p1 = analogHash(seed, 1) * Math.PI * 2;
  const p2 = analogHash(seed, 2) * Math.PI * 2;
  const p3 = analogHash(seed, 3) * Math.PI * 2;
  const v = 0.55 * Math.sin(2 * Math.PI * 0.07 * t + p1)
    + 0.32 * Math.sin(2 * Math.PI * 0.19 * t + p2)
    + 0.13 * Math.sin(2 * Math.PI * 0.53 * t + p3);
  return v * depth;
}

/**
 * A voice's own component tolerance — the thing that makes voice 1 and voice
 * 4 different instruments.
 *
 * Returns a multiplier around 1 for whatever it is applied to.  `spread` is
 * the tolerance as a fraction: 0.02 is a 2% part, which is what a decent
 * 1970s resistor was, and 0.08 is a machine nobody has serviced.
 *
 * `slot` is which of the synth's voices this note landed on.  It is NOT the
 * pitch: the whole point is that playing the same note twice on a busy
 * keyboard puts it through different hardware each time.
 */
export function voiceTolerance(slot: number, spread: number, which: number): number {
  return 1 + (analogHash(slot + 1, which, 77) * 2 - 1) * spread;
}

// ── Band-limited oscillators ────────────────────────────────────────────────

/**
 * PolyBLEP: the correction that removes a discontinuity's aliasing.
 *
 * A naive saw is a straight ramp with a vertical jump, and that jump has
 * infinite bandwidth — every harmonic above Nyquist folds back.  This
 * subtracts a two-sample polynomial approximation of the band-limited step at
 * the exact fractional position of the jump, which is why it works at any
 * frequency without a table per octave.
 *
 * Measured against a naive saw — non-harmonic energy relative to the
 * fundamental, and these are the real numbers rather than the round ones:
 *
 *      A3    −42.0 dB  ->  −52.9 dB
 *      C6    −30.7 dB  ->  −45.4 dB
 *      C7    −33.7 dB  ->  −64.4 dB
 *
 * PolyBLEP is a TWO-POINT approximation of the band-limited step, so it does
 * not reach the −100 dB a mip-mapped wavetable does (see `wavetable.ts`); it
 * buys 11 to 31 dB for four arithmetic operations and no table at all, which
 * is the trade an oscillator with continuously variable pulse width has to
 * make.  The figures at the lower pitches are also partly this measurement's
 * own leakage — at A3 the harmonics are 220 Hz apart and a probe is never far
 * from one — which is why the selftest states the claim differentially.
 */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export const ANALOG_SHAPES = ['saw', 'pulse', 'triangle', 'sine'] as const;

/**
 * One sample of an analogue oscillator.
 *
 * `phase` is where the oscillator is, 0…1, and the caller advances it — the
 * oscillator is FREE-RUNNING, so nothing here knows about notes.
 *
 * The triangle is the integral of the pulse rather than a shape of its own,
 * which is how an analogue one is made and why its width control does
 * something: integrating an asymmetric pulse gives an asymmetric triangle,
 * on the way to a saw.
 */
export function analogSample(
  shape: number, phase: number, dt: number, width: number, triState: { value: number },
): number {
  const t = phase - Math.floor(phase);
  const w = Math.min(0.94, Math.max(0.06, width));
  switch (Math.max(0, Math.min(3, Math.round(shape)))) {
    case 0: {
      return 2 * t - 1 - polyBlep(t, dt);
    }
    case 1: {
      const shifted = t + (1 - w);
      const t2 = shifted - Math.floor(shifted);
      const value = (2 * t - 1 - polyBlep(t, dt)) - (2 * t2 - 1 - polyBlep(t2, dt));
      // The saw pair leaves a DC step that follows the width; taking it out
      // is what keeps a narrow pulse centred instead of riding upward.
      return value + (2 * w - 1);
    }
    case 2: {
      const shifted = t + (1 - w);
      const t2 = shifted - Math.floor(shifted);
      const square = (2 * t - 1 - polyBlep(t, dt)) - (2 * t2 - 1 - polyBlep(t2, dt)) + (2 * w - 1);
      // Leaky integrator: the leak is what stops a DC offset accumulating
      // over a long note, and a real one leaks for the same reason.
      triState.value = triState.value * 0.9995 + square * dt * 4;
      return triState.value;
    }
    default:
      return Math.sin(2 * Math.PI * t);
  }
}

// ── The ladder ──────────────────────────────────────────────────────────────

/**
 * A four-pole transistor ladder, with the nonlinearity that makes it one.
 *
 * Four one-pole stages in the zero-delay form, so the cutoff is where the
 * knob says at every frequency, with the output fed back to the input
 * through a `tanh`.  That saturation is the whole character:
 *
 *   · the resonance limits itself instead of exploding, so the filter can be
 *     pushed to self-oscillation and used as a sine source
 *   · driving it harder changes the harmonics rather than only the level
 *   · and the feedback SUBTRACTS the low end, so the bass thins as the
 *     resonance comes up — the thing everybody knows about a Moog and the
 *     thing a clean filter cannot be made to do afterwards
 *
 * `compensation` puts the bass back by feeding some input forward around the
 * loop.  At 0 it is the real behaviour; at 1 the low end holds.  It is a knob
 * rather than a decision because both are wanted: the bass loss is the sound
 * on a lead and a problem on a bassline.
 *
 * Taps at stage 2, 3 and 4 give 12, 18 and 24 dB per octave, which is what
 * the switch on a ladder-filter synth is actually doing.
 */
export class Ladder {
  private s = new Float64Array(4);
  private z = 0;

  reset(): void { this.s.fill(0); this.z = 0; }

  /**
   * @param g     tan(pi·fc/sr), the pre-warped cutoff
   * @param k     resonance, 0…4.  Self-oscillates near 4.
   * @param poles 2, 3 or 4
   */
  step(
    x: number, g: number, k: number, compensation: number, poles: number, drive = 1,
  ): number {
    const G = g / (1 + g);
    // The feedback uses the PREVIOUS output.  Solving the loop exactly needs
    // an iteration per sample for a difference nobody can hear at these
    // cutoffs, and the one-sample delay is what every hardware model does.
    const fb = k * (this.z - compensation * x);
    // DRIVE is how hard the input stage is pushed into the `tanh`, and it is
    // a parameter because without it the saturation is not reachable.
    // Measured before it existed: six decibels more input gave 5.94 dB more
    // output — a nonlinearity inside a negative feedback loop is linearised
    // by the loop, so at ordinary levels the filter was clean whatever the
    // resonance.  With the input driven the compression is real, and a real
    // ladder is driven the same way: you turn the input up.
    let v = Math.tanh(drive * x - fb);
    for (let i = 0; i < 4; i++) {
      const si = this.s[i] ?? 0;
      const d = (v - si) * G;
      const y = si + d;
      this.s[i] = y + d;
      v = y;
      if (i === 1 && poles <= 2) break;
      if (i === 2 && poles === 3) break;
    }
    this.z = this.s[3] ?? 0;
    return v;
  }
}

// ── Envelopes ───────────────────────────────────────────────────────────────

/**
 * A capacitor's charge curve, not a straight line.
 *
 * A real envelope is an RC network, so the attack approaches its target
 * asymptotically and the stage ends when it gets close enough — which is why
 * an analogue "attack time" is a time CONSTANT rather than a duration, and
 * why the same number sounds faster than a digital one.
 *
 * `curve` is how far from linear: 0 is the straight line a digital ADSR
 * draws, 1 is the capacitor.  Having both is the point — this is the control
 * that makes a digital envelope sound digital, and hiding it would be
 * modelling one instrument rather than offering a choice.
 */
export function analogEnv(
  t: number, gate: number, a: number, d: number, s: number, r: number, curve: number,
): number {
  const c = Math.max(0, Math.min(1, curve));
  // 63% in one time constant is what an RC network does; three constants is
  // 95%, which is where a real envelope's stage is called finished.
  const rise = (x: number): number => (c <= 0 ? x : (1 - Math.exp(-3 * x)) / (1 - Math.exp(-3)));
  const fall = (x: number): number => (c <= 0 ? 1 - x : Math.exp(-3 * x) * (1 / (1 - Math.exp(-3)))
    - Math.exp(-3) / (1 - Math.exp(-3)));

  const mix = (linear: number, curved: number): number => linear + (curved - linear) * c;

  if (t < 0) return 0;
  if (t < gate) {
    if (t < a) return a <= 0 ? 1 : mix(t / a, rise(t / a));
    const dt = t - a;
    if (dt < d) {
      const x = d <= 0 ? 1 : dt / d;
      return s + (1 - s) * mix(1 - x, fall(x));
    }
    return s;
  }
  const held = gate < a
    ? (a <= 0 ? 1 : mix(gate / a, rise(gate / a)))
    : (gate - a < d
      ? s + (1 - s) * mix(1 - (d <= 0 ? 1 : (gate - a) / d), fall(d <= 0 ? 1 : (gate - a) / d))
      : s);
  const rt = t - gate;
  if (r <= 0) return 0;
  const x = Math.min(1, rt / r);
  return held * mix(1 - x, fall(x));
}
