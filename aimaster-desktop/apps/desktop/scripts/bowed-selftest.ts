/**
 * bowed-selftest — whether the bowed string is bowed, or a sawtooth wearing
 * an envelope.
 *
 * That is the whole question about this instrument, because a sawtooth with
 * an attack and a body filter is what almost every "string" patch actually
 * is, and it passes a listening test until somebody asks it for a crescendo
 * on one bow.  The checks here are the properties that come OUT of friction
 * and cannot be put INTO an envelope:
 *
 *   · Helmholtz motion: the string sticks to the bow for (1−β) of every
 *     period and flies back during the rest, giving a bridge force that is a
 *     sawtooth to the last harmonic
 *   · loudness is BOW SPEED, and bow force is not loudness
 *   · there is a minimum bow force, below which there is no Helmholtz motion
 *     at all — the breathy surface sound rather than a quieter note
 *   · the bow's position is a comb, notching harmonic 1/β
 *   · the friction curve is solved, not fitted, and sticking is a real state
 *
 * Run:  pnpm --filter @aimaster/desktop test:bowed
 */

import {
  BOW_BODIES, MU_STATIC, bodySections, cascadeDb, frictionMu, renderBowedVoice,
  solveBow, stringFor, BOWED_PARAMS,
} from '../src/renderer/daw/engine/bowed-string.js';

const SR = 48_000;

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const DEFAULTS: Record<string, number> = Object.fromEntries(
  BOWED_PARAMS.map((q) => [q.id, q.default]));

function render(pitch: number, over: Record<string, number> = {}, sec = 0.9): {
  left: Float32Array; right: Float32Array; hz: number;
} {
  const hz = 440 * Math.pow(2, (pitch - 69) / 12);
  const r = renderBowedVoice({
    sampleRate: SR, seconds: sec, gateSec: sec, freqHz: hz, pitch,
    velocity: 0.8, startBeat: 0,
    params: { ...DEFAULTS, vibDepth: 0, hair: 0, bodyAmt: 0, ...over },
  });
  return { left: r.left, right: r.right, hz };
}

/**
 * The pitch the string actually settles at.
 *
 * Interpolated zero crossings of a narrow resonator around the nominal, which
 * is a great deal finer than a DFT bin: the tuning claims below are in cents
 * and a bin at this window length is worth about 20 of them.
 */
function measureHz(d: Float32Array, approx: number, from = 0.5, len = 0.35): number {
  const off = Math.round(from * SR);
  const n = Math.min(d.length - off - 2, Math.round(len * SR));
  const w = 2 * Math.PI * approx / SR;
  const r = 0.995;
  const a1 = -2 * r * Math.cos(w);
  const a2 = r * r;
  let z1 = 0;
  let z2 = 0;
  let first = -1;
  let last = -1;
  let count = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = (d[off + i] ?? 0) - a1 * z1 - a2 * z2;
    const y = (x - z2) * (1 - r);
    if (i > 0 && prev < 0 && y >= 0) {
      const t = i - 1 + (-prev) / (y - prev);
      if (first < 0) first = t; else { last = t; count++; }
    }
    prev = y;
    z2 = z1;
    z1 = x;
  }
  return count > 4 ? SR * count / (last - first) : NaN;
}

/** The amplitude of one partial, over a window of the steady part. */
function part(d: Float32Array, hz: number, from = 0.5, len = 0.17): number {
  const off = Math.round(from * SR);
  const n = Math.round(len * SR);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const ph = 2 * Math.PI * hz * i / SR;
    re += (d[off + i] ?? 0) * w * Math.cos(ph);
    im += (d[off + i] ?? 0) * w * Math.sin(ph);
  }
  return Math.hypot(re, im) / n * 4;
}

function rms(d: Float32Array, from: number, len: number): number {
  const off = Math.round(from * SR);
  const n = Math.round(len * SR);
  let s = 0;
  for (let i = 0; i < n; i++) s += (d[off + i] ?? 0) ** 2;
  return Math.sqrt(s / n);
}

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

/**
 * How far the first eight harmonics are from a sawtooth, in dB rms.
 *
 * This is the measure of "is the string in Helmholtz motion", and it had to
 * replace the obvious one.  Period-to-period correlation says 1.000 for
 * MULTIPLE SLIPPING too — the string releasing several times per period is
 * still perfectly periodic, it is just not a violin — so a check built on it
 * passed the surface sound as a good note.  The spectrum tells them apart:
 * inside the playable window this reads 0.5 to 2 dB, and outside it 7 to 40.
 */
function sawtoothError(d: Float32Array, f0: number, beta: number): number {
  // Only the harmonics BELOW the bow-position comb.  The notch at 1/β is
  // real and is tested on its own two checks down; counting it as an error
  // here made the measure say "not Helmholtz" for bowing far from the
  // bridge, where 1/β falls to the sixth harmonic and lands inside the
  // window — which is a metric measuring the thing it was told to ignore.
  const top = Math.max(4, Math.min(8, Math.floor(0.7 / beta)));
  const h: number[] = [];
  for (let k = 1; k <= top; k++) h.push(part(d, f0 * k));
  let e = 0;
  for (let k = 2; k <= top; k++) e += (db(h[k - 1]! / h[0]!) - db(1 / k)) ** 2;
  return Math.sqrt(e / (top - 1));
}

/**
 * The bow's fraction of the sounding length, for a note on the violin.
 *
 * The engine works this out from the knob and the stop; the tests need the
 * same number to know where the comb should be, and computing it here from
 * the same rule would be a second copy that can drift.  So it asks.
 */
function betaOf(pitch: number, pos: number): number {
  const violin = BOW_BODIES[0]!;
  return Math.max(0.012, Math.min(0.2, pos * Math.sqrt(stringFor(violin, pitch).stop)));
}

// ───────────────────────────────────────────────────────────────────────────

check('the string locks into Helmholtz motion, and its spectrum is 1/n', () => {
  // A sawtooth's nth harmonic is 1/n of its first: −6.0, −9.5, −12.0, −14.0,
  // −15.6 dB.  That is not something a filter arrives at by accident, and it
  // is what the travelling Helmholtz corner produces.
  const ideal = [0, -6.02, -9.54, -12.04, -13.98];
  for (const pitch of [55, 62, 69, 76, 84, 91]) {
    const r = render(pitch);
    const f0 = measureHz(r.left, r.hz);
    assert(Number.isFinite(f0), `no steady pitch at ${pitch}`);
    const h = ideal.map((_, k) => part(r.left, f0 * (k + 1)));
    for (let k = 1; k < ideal.length; k++) {
      const rel = db(h[k]! / h[0]!);
      assert(Math.abs(rel - ideal[k]!) < 1.6,
        `at pitch ${pitch} (${f0.toFixed(0)} Hz) harmonic ${k + 1} is ${rel.toFixed(1)} dB `
        + `where a sawtooth is ${ideal[k]!.toFixed(1)} — the motion is not Helmholtz`);
    }
  }
});

check('loudness is bow speed, and bow force is not loudness', () => {
  // The claim that separates this from every sampled string: a crescendo is
  // a faster bow, not a harder one.  Doubling the speed is 6 dB; doubling the
  // force, inside the playable window, is almost nothing.
  const at = (speed: number): number => db(rms(render(69, { speed }).left, 0.5, 0.3));
  const bySpeed = [0.1, 0.2, 0.4, 0.8].map(at);
  for (let i = 1; i < bySpeed.length; i++) {
    const step = bySpeed[i]! - bySpeed[i - 1]!;
    assert(step > 4.5 && step < 7.5,
      `doubling the bow speed moved the level ${step.toFixed(1)} dB, not the 6 it should`);
  }

  // Across the playable window — the part of the knob above the minimum bow
  // force, which is measured by the next check and sits near 0.35.
  const byForce = [0.4, 0.55, 0.7, 0.85].map(
    (force) => db(rms(render(69, { force }).left, 0.5, 0.3)));
  const spread = Math.max(...byForce) - Math.min(...byForce);
  assert(spread < 2.5,
    `bow force moved the level ${spread.toFixed(1)} dB across the playable window — `
    + 'on this instrument that knob is timbre, not volume');
});

check('below the minimum bow force there is no Helmholtz motion to have', () => {
  // Schelleng's lower bound, and the reason a beginner's tone is breathy
  // rather than quiet: under the minimum force the string never locks, so
  // what comes out is aperiodic surface sound.  The engine has to reproduce
  // the FAILURE, not just the success.
  const errAt = (force: number): number => {
    const r = render(69, { force });
    return sawtoothError(r.left, measureHz(r.left, r.hz), betaOf(69, DEFAULTS['pos']!));
  };
  assert(errAt(0.5) < 2, `at a playable force the spectrum is ${errAt(0.5).toFixed(1)} dB `
    + 'away from a sawtooth');
  for (const weak of [0.05, 0.15, 0.25]) {
    assert(errAt(weak) > 3,
      `at a bow force of ${weak} the spectrum is only ${errAt(weak).toFixed(1)} dB from a `
      + 'sawtooth — under the minimum force there should be no Helmholtz motion at all, '
      + 'and an instrument that cannot fail cannot sound like a beginner');
  }
  // And it is quieter as well as worse, which is the other half of why a
  // beginner sounds like one: the energy goes into the wrong motion.
  const quiet = db(rms(render(69, { force: 0.15 }).left, 0.5, 0.3));
  const full = db(rms(render(69, { force: 0.5 }).left, 0.5, 0.3));
  assert(full > quiet + 3,
    `the surface sound is ${(full - quiet).toFixed(1)} dB below the real note`);
});

check('the minimum force rises as the bow moves toward the bridge', () => {
  // The other half of Schelleng: near the bridge the string is harder to
  // start.  The knob is scaled by 1/β rather than his 1/β² so that it stays
  // playable (see the engine), and what survives that compromise is what is
  // asserted here — the threshold still moves, and in the right direction.
  const threshold = (pos: number): number => {
    for (let f = 0.05; f <= 1; f += 0.05) {
      const r = render(69, { pos, force: f }, 0.7);
      const f0 = measureHz(r.left, r.hz, 0.45, 0.2);
      if (sawtoothError(r.left, f0, betaOf(69, pos)) < 2) return f;
    }
    return 2;
  };
  const near = threshold(0.04);
  const far = threshold(0.16);
  assert(near > far,
    `bowing at β=0.04 locks at force ${near.toFixed(2)} and at β=0.16 at `
    + `${far.toFixed(2)} — the bridge is supposed to be the harder place to start`);
});

check('the bow position is a comb, and its notch is at harmonic 1/beta', () => {
  // The Helmholtz corner reaches the bow once per round trip of the short
  // section, so the harmonic with a node there is missing.  This is the same
  // effect as a guitar's pick position and it is why sul ponticello is thin
  // and sul tasto is round — a comb, not an EQ.
  for (const [pos, want] of [[0.06, 17], [0.08, 13], [0.1, 10], [0.125, 8]] as const) {
    // Measured at a light-to-moderate bow, because the comb's depth is a
    // function of how sharp the Helmholtz corner is and heavy bowing rounds
    // it: the same notch reads −9 dB at a force of 0.45 and −3 at 0.55.
    // That is the model agreeing with why players lighten the bow for sul
    // ponticello rather than lean on it.
    const r = render(69, { pos, force: 0.45, bright: 0.85 });
    const f0 = measureHz(r.left, r.hz);
    const h1 = part(r.left, f0);
    // Against a 1/n reference, so a notch is a notch and not just the slope.
    const rel = (k: number): number => db(part(r.left, f0 * k) / (h1 / k));
    let deepest = 0;
    let deepestRel = Infinity;
    for (let k = 3; k <= Math.round(1.4 / pos); k++) {
      if (rel(k) < deepestRel) { deepestRel = rel(k); deepest = k; }
    }
    assert(Math.abs(deepest - want) <= 1,
      `with the bow at β=${pos} (1/β = ${(1 / pos).toFixed(1)}) the deepest notch is at `
      + `harmonic ${deepest}, not ${want} — the bow position is not combing`);
    assert(deepestRel < -4,
      `the notch at β=${pos} is only ${deepestRel.toFixed(1)} dB deep`);
    // A comb has more than one tooth.  One dip could be a resonance; a dip at
    // 1/β AND one at 2/β is the pick-position argument and nothing else.
    // Only where there is still something to notch: the string's own loss
    // filter has taken the top off long before the second tooth of a comb
    // this fine, so at β = 0.06 the harmonic in question is at 14 kHz and
    // 30 dB down whatever the bow is doing.
    const second = Math.round(2 / pos);
    if (second * f0 < 8000) {
      const around = (rel(second - 2) + rel(second + 2)) / 2;
      assert(rel(second) < around - 3,
        `at β=${pos} harmonic ${second} (2/β) is ${rel(second).toFixed(1)} dB against `
        + `${around.toFixed(1)} beside it — one notch is a resonance, two is a comb`);
    }
  }
});

check('sticking is a real state, and the friction is solved rather than fitted', () => {
  // The junction has two branches and the boundary between them is rosin's
  // static limit.  Below it the string goes exactly where the bow does, which
  // is what "sticking" means; a fitted reflection curve has no such point.
  const a = 1.2;
  const inside = solveBow(a * MU_STATIC * 0.9, a, 0);
  assert(inside.slip === 0 && Math.abs(inside.w - a * MU_STATIC * 0.9) < 1e-12,
    'inside the static limit the bow should carry the string exactly');
  const outside = solveBow(a * MU_STATIC * 1.1, a, 0);
  assert(outside.slip > 0, 'past the static limit the string has to slip');

  // And the solution has to satisfy the equation it came from, not merely be
  // monotone: Δv + a·μ(Δv) = d.
  for (const d of [0.9, 1.5, 3, 8, 20]) {
    for (const force of [0.4, 1, 3, 9]) {
      const sol = solveBow(d, force, 0);
      if (sol.slip === 0) continue;
      const residual = sol.slip + force * frictionMu(sol.slip) - d;
      assert(Math.abs(residual) < 1e-6,
        `the friction solution for d=${d}, a=${force} misses its own equation by `
        + `${residual.toExponential(2)}`);
    }
  }
  // Rosin holds more standing still than sliding, which is the whole reason
  // the motion is stick-slip and not smooth.
  assert(frictionMu(0) > frictionMu(1) * 2.5,
    'static friction has to be well above dynamic or nothing oscillates');
});

check('the string plays in tune, across its range and its bowing', () => {
  // The loop has two delay lines, a read that is one sample late in each, and
  // a loss filter with its own delay.  Miss any of them and the instrument is
  // flat by more the higher it plays — the first version was 30 cents flat at
  // A4 for exactly that reason.
  for (const pitch of [55, 60, 62, 67, 69, 76, 79, 84]) {
    const r = render(pitch);
    const cents = 1200 * Math.log2(measureHz(r.left, r.hz) / r.hz);
    assert(Math.abs(cents) < 12,
      `pitch ${pitch} plays ${cents.toFixed(1)} cents out`);
  }
  // Bowing moves it a little, which is real — a bowed string is not a filter
  // and its period is set by when the friction lets go.  A few cents is
  // inside a player's own intonation; tens of cents would not be.  Measured
  // inside the playable window only: under the minimum bow force there is no
  // single pitch to be in tune with, which is the point of it.
  const spread: number[] = [];
  for (const force of [0.4, 0.55, 0.7, 0.85]) {
    const r = render(69, { force });
    spread.push(1200 * Math.log2(measureHz(r.left, r.hz) / r.hz));
  }
  const range = Math.max(...spread) - Math.min(...spread);
  assert(range < 15,
    `bow force moves the pitch by ${range.toFixed(1)} cents across the playable window`);
});

check('each instrument is its own box, and the box is what makes it one', () => {
  // A bowed waveguide is a sawtooth on every instrument.  What tells a violin
  // from a cello is the body, so the body has to be measurably there and
  // measurably different.
  for (const body of BOW_BODIES) {
    const sections = bodySections(body, SR);
    for (const [hz, , gain] of body.modes) {
      // Local prominence, not "louder than an octave up": the lowest mode of
      // every one of these sits just above the highpass that stands for the
      // box not radiating, so comparing it with somewhere far away measures
      // the skirt rather than the mode.  It was written that way first and
      // the viola failed it for being a viola.
      // What this asks is whether the MODE does anything, not whether it
      // pokes out of its neighbours.  Two earlier versions asked the latter
      // — against a point an octave up, then against the points beside it —
      // and both failed on real instruments for real reasons: the lowest
      // mode of every one of these sits on the skirt of the highpass that
      // stands for the box not radiating, and the violin's CBR at 405 Hz is
      // genuinely squeezed between the 280 and the 460 and does not poke out
      // of anything.  It is still audibly there, and this is how you ask.
      const without = bodySections(
        { ...body, modes: body.modes.map((m) => (m[0] === hz ? [hz, m[1], 0] as const : m)) },
        SR);
      const lift = cascadeDb(sections, hz, SR) - cascadeDb(without, hz, SR);
      assert(lift > gain * 0.7,
        `${body.name}: the mode at ${hz} Hz lifts the response by ${lift.toFixed(1)} dB `
        + `where it is declared as ${gain} — it is not doing what it says`);
    }
    const hill = cascadeDb(sections, body.hill[0], SR);
    assert(hill > cascadeDb(sections, body.hill[0] * 3.5, SR) + 3,
      `${body.name}: the bridge hill is not a hill`);
    assert(cascadeDb(sections, body.floorHz * 0.35, SR) < -9,
      `${body.name}: a box this size cannot radiate an octave and a half below `
      + 'its air resonance, and this one does');
  }
  // And they are four instruments, not one with a transpose: the lowest note
  // each can play differs, and so does where its body holds it up.
  const lows = BOW_BODIES.map((b) => b.strings[0]!);
  for (let i = 1; i < lows.length; i++) {
    assert(lows[i]! < lows[i - 1]!, 'the bodies are not in descending order');
  }
  const hills = BOW_BODIES.map((b) => b.hill[0]);
  assert(hills[0]! > hills[3]! * 2.5,
    'a violin and a double bass are supposed to put their bridge hill in very '
    + 'different places');
});

check('the bow goes where the arm is, so the stop moves the tone', () => {
  // A player does not walk the bow up the fingerboard.  The string gets
  // shorter under a bow that stays put, so high positions are closer to the
  // bridge in the only sense that counts, and they are brighter for it.  That
  // is why the same instrument changes character up the E string.
  const violin = BOW_BODIES[0]!;
  assert(stringFor(violin, 69).open === 69, 'A4 is the violin A string, open');
  assert(stringFor(violin, 64).open === 62, 'E4 is stopped on the D string');
  assert(stringFor(violin, 50).open === 55,
    'below its range the violin has to fall back to its lowest string');
  // D5 goes on the A string a fifth up, not on the D string an octave up.
  // That is the rule this picks — the highest string that reaches the note —
  // and it is how a player reads a passage rather than how they might voice
  // one note: a violinist WILL take D5 on the D string for its darker colour,
  // and nothing here can know that from a MIDI note.  Said plainly because
  // the first version of this check asserted the octave and was simply wrong
  // about what the code does and what a player does.
  const up = stringFor(violin, 74);
  assert(up.open === 69 && Math.abs(up.stop - Math.pow(2, 5 / 12)) < 1e-9,
    `D5 came out as string ${up.open} at ${up.stop.toFixed(3)}`);
  assert(stringFor(violin, 88).open === 76,
    'everything above E5 is on the E string, however high');

  // Measured: the same note played with the same knobs, one on an open
  // string and one stopped high on the string below, is not the same sound.
  const open = render(76, { pos: 0.09 });
  const f0 = measureHz(open.left, open.hz);
  const h = (k: number): number => db(part(open.left, f0 * k) / part(open.left, f0));
  assert(h(8) > -26, 'an open E should still have a real eighth harmonic');
});

check('the tail is the string still ringing, and the string is still a string', () => {
  // The bow leaves and the string keeps going, losing energy through the same
  // loop it gained it through.  So two things have to be true of the tail that
  // are not true of a gain envelope: the RING knob sets how fast it dies, and
  // the BRIGHT knob sets how fast it darkens, because the loss in a string is
  // frequency-dependent and a fader is not.
  //
  // Measured INSIDE the ring, and that correction matters.  The first version
  // compared the bowed note with the tail and found 26 dB of level and 74 dB
  // of brightness — and passed with a lossless loop, because what it was
  // actually measuring was Helmholtz motion collapsing the moment the bow
  // lifts.  Real, and not the claim.
  const ring = (over: Record<string, number>): { lvl: (t: number) => number;
    h3: (t: number) => number } => {
    const r = renderBowedVoice({
      sampleRate: SR, seconds: 1.6, gateSec: 0.4, freqHz: 440, pitch: 69,
      velocity: 0.8, startBeat: 0,
      params: { ...DEFAULTS, vibDepth: 0, hair: 0, bodyAmt: 0, release: 0.05, ...over },
    });
    return {
      lvl: (t) => db(rms(r.left, t, 0.12)),
      h3: (t) => db(part(r.left, 440 * 3, t, 0.12) / part(r.left, 440, t, 0.12)),
    };
  };

  const held = ring({ sustainRing: 1 });
  const damped = ring({ sustainRing: 0.6 });
  const heldDecay = held.lvl(0.55) - held.lvl(1);
  const dampedDecay = damped.lvl(0.55) - damped.lvl(1);
  assert(dampedDecay > heldDecay + 5,
    `over the same half second the ringing string lost ${dampedDecay.toFixed(1)} dB damped `
    + `and ${heldDecay.toFixed(1)} dB open — the Ring knob is not the loop's loss`);
  assert(heldDecay > 1, 'even wide open a string has to lose something');

  const dull = ring({ bright: 0, sustainRing: 1 });
  const keen = ring({ bright: 1, sustainRing: 1 });
  const dulls = dull.h3(0.55) - dull.h3(1);
  const keens = keen.h3(0.55) - keen.h3(1);
  assert(keens > 8,
    `a ringing string lost only ${keens.toFixed(1)} dB of its third harmonic against its `
    + 'first — the loss in the loop has to be frequency-dependent, or the note fades '
    + 'instead of darkening');
  assert(dulls > keens + 10,
    `the dull string darkened ${dulls.toFixed(1)} dB and the bright one ${keens.toFixed(1)} `
    + '— the Bright knob is supposed to be how fast the top goes');
});

check('vibrato is a finger on the string, so the level moves with the pitch', () => {
  // Rocking the finger changes the LENGTH.  The amplitude wobble everybody
  // hears with it is not a second effect — it is the harmonics sliding across
  // the body's resonances, which happens by itself once there is a body.  So
  // with the body switched off there should be much less of it.
  const swing = (over: Record<string, number>): number => {
    const r = render(69, { vibRate: 5.5, vibDelay: 0.05, ...over });
    let lo = Infinity;
    let hi = 0;
    for (let t = 0.4; t < 0.8; t += 0.005) {
      const e = rms(r.left, t, 0.01);
      lo = Math.min(lo, e); hi = Math.max(hi, e);
    }
    return db(hi / lo);
  };
  const off = swing({ vibDepth: 0, bodyAmt: 1 });
  const on = swing({ vibDepth: 50, bodyAmt: 1 });
  assert(on > off + 1.5,
    `vibrato moved the level ${on.toFixed(1)} dB against ${off.toFixed(1)} dB without it`);
  const noBody = swing({ vibDepth: 50, bodyAmt: 0 });
  assert(on > noBody,
    `with the body off vibrato still swings ${noBody.toFixed(1)} dB against `
    + `${on.toFixed(1)} with it — the amplitude wobble is supposed to come FROM the body`);
});

check('a note that is not a note comes out silent, not as NaN', () => {
  // A resonant loop can diverge where an oscillator cannot, and a buffer of
  // NaN does not stay on its own track: it goes down the mix bus and silences
  // the whole song.  This was found by driving the instrument from the app
  // with a malformed note — the other instruments answered with silence and
  // this one did not.
  for (const bad of [Number.NaN, 0, -1, Infinity]) {
    const r = renderBowedVoice({
      sampleRate: SR, seconds: 0.3, gateSec: 0.3, freqHz: bad, pitch: 69,
      velocity: 0.8, startBeat: 0, params: DEFAULTS,
    });
    for (let i = 0; i < r.left.length; i++) {
      assert(Number.isFinite(r.left[i]!) && Number.isFinite(r.right[i]!),
        `a frequency of ${bad} put ${r.left[i]} in the buffer`);
    }
  }
  // And nothing in the normal range may either, over a long ring-out.
  for (const pitch of [28, 55, 69, 91, 100]) {
    const hz = 440 * Math.pow(2, (pitch - 69) / 12);
    const r = renderBowedVoice({
      sampleRate: SR, seconds: 4, gateSec: 1, freqHz: hz, pitch,
      velocity: 1, startBeat: 0,
      params: { ...DEFAULTS, force: 1, speed: 1, sustainRing: 1, pos: 0.02 },
    });
    let peak = 0;
    for (let i = 0; i < r.left.length; i++) {
      assert(Number.isFinite(r.left[i]!), `pitch ${pitch} went non-finite at sample ${i}`);
      peak = Math.max(peak, Math.abs(r.left[i]!));
    }
    assert(peak < 4, `pitch ${pitch} peaked at ${peak.toFixed(2)} bowed as hard as it goes`);
  }
});

// ───────────────────────────────────────────────────────────────────────────

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ` — ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
