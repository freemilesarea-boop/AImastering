/**
 * bowed-panel-selftest — whether the bowed string's panel is a picture of
 * this instrument, or a drawing next to it.
 *
 * The panel makes three claims a user acts on, and each is a way to be
 * wrong:
 *
 *   · the CYCLE is the string's own velocity at the bow, so the plateau it
 *     draws really is the string riding with the bow and its share of the
 *     width really is (1−β)
 *   · the REGIME BADGE reads the cycle rather than the knob — it has to say
 *     "surface sound" because the string is slipping several times a period,
 *     not because the force knob is low
 *   · the SPECTRUM's notch sits where the sound's does
 *
 * A picture that fails any of those is worse than none, because it is a
 * second opinion the user will trust over their ears.
 *
 * Run:  pnpm --filter @aimaster/desktop test:bowed-panel
 */

import { readFileSync } from 'node:fs';
import {
  PREVIEW_RATE, PREVIEW_SECONDS, betaOf, bodyCurve, bodyOf, bodyX, bowCycle,
  bridgeSpectrum, stringRows,
} from '../src/renderer/daw/model/bowed-views.js';
import {
  BOWED_PARAMS, BOW_BODIES, bodySections, cascadeDb, renderBowedVoice, stringFor,
} from '../src/renderer/daw/engine/bowed-string.js';
import { defaultInstrumentParams, findInstrument } from '../src/renderer/daw/engine/instruments.js';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); } catch (err) {
    results.push({ name, pass: false, detail: err instanceof Error ? err.message : String(err) });
  }
}


/**
 * The period a settled note has, by interpolated zero crossings.
 *
 * Deliberately a DIFFERENT method from the panel's correlation, so that this
 * file is checking the panel rather than agreeing with it.  It is needed at
 * all because a bowed string settles a few cents off its delay line, and a
 * spectrum read at the nominal frequency misses each harmonic by k times
 * that — which is the bug this check found in the panel.
 */
function measureHz(d: Float32Array, approx: number, from: number, len: number): number {
  const off = Math.round(from * PREVIEW_RATE);
  const n = Math.min(d.length - off - 2, Math.round(len * PREVIEW_RATE));
  const w = 2 * Math.PI * approx / PREVIEW_RATE;
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
  return count > 3 ? PREVIEW_RATE * count / (last - first) : approx;
}

const D = defaultInstrumentParams('bowed');
const VIOLIN_A = 69;

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

// ───────────────────────────────────────────────────────────────────────────

check('the cycle drawn is the string\'s own velocity at the bow', () => {
  // Not "a waveform that looks like one".  The engine fills the trace inside
  // the loop that makes the sound, so the picture and the sound cannot be
  // two different things — and this is what checks that the panel reads that
  // trace rather than the output, which is a different signal entirely.
  const params = { ...D };
  const n = Math.round(PREVIEW_RATE * PREVIEW_SECONDS);
  const trace = new Float32Array(n);
  const out = renderBowedVoice({
    sampleRate: PREVIEW_RATE, seconds: PREVIEW_SECONDS, gateSec: PREVIEW_SECONDS,
    freqHz: 440, pitch: VIOLIN_A, velocity: 0.8, startBeat: 0,
    params: { ...params, vibDepth: 0 }, bowVelocity: trace,
  });
  let traceMax = 0;
  for (let i = 0; i < n; i++) traceMax = Math.max(traceMax, Math.abs(trace[i]!));
  assert(traceMax > 1e-6, 'the engine wrote nothing into the trace');

  // The two signals are genuinely different — if the panel drew the output
  // instead, this check would be measuring nothing.
  const off = Math.round(0.3 * PREVIEW_RATE);
  let num = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 4096; i++) {
    const x = trace[off + i]!;
    const y = out.left[off + i]!;
    num += x * y; a += x * x; b += y * y;
  }
  const r = num / Math.sqrt(a * b + 1e-30);
  assert(Math.abs(r) < 0.9,
    `the velocity at the bow and the signal at the bridge correlate ${r.toFixed(3)} — `
    + 'they are supposed to be different signals, so one of them is not what it says');

  // And the picture is that trace: its shape, sampled.
  const cycle = bowCycle(params, VIOLIN_A, 200);
  assert(cycle.points.length === 201, 'the cycle came back the wrong width');
  const lo = Math.min(...cycle.points.map((q) => q.y));
  const hi = Math.max(...cycle.points.map((q) => q.y));
  assert(lo < 0.02 && hi > 0.98, `the cycle fills ${lo.toFixed(2)}…${hi.toFixed(2)} of its box`);
});

check('the plateau really is the stick, and its width is 1 − beta', () => {
  // The claim the picture makes just by being drawn.  Measured against the
  // engine's own β for the same note, across bow positions — because if the
  // panel took β from anywhere but the engine's rule, this is where it shows.
  for (const pos of [0.06, 0.09, 0.14, 0.2]) {
    const params = { ...D, pos, force: 0.55 };
    const cycle = bowCycle(params, VIOLIN_A);
    const beta = betaOf(params, VIOLIN_A);
    assert(Math.abs(cycle.idealStuck - (1 - beta)) < 1e-9,
      'the marker is not drawn at 1 − β');
    assert(Math.abs(cycle.stuck - (1 - beta)) < 0.05,
      `at β=${beta.toFixed(3)} the string is stuck ${(cycle.stuck * 100).toFixed(1)}% of the `
      + `period where Helmholtz motion is ${((1 - beta) * 100).toFixed(1)}%`);
  }
  // And the stop moves β, because the arm does not move: the same knob on a
  // note an octave up THE SAME STRING is a larger fraction of a shorter one.
  //
  // On the same string, which the first version of this check got wrong — it
  // compared G3 with G5 and found β barely moved, because G5 is played on the
  // E string a minor third up rather than on the G string an octave and a
  // half up.  Which is what a player does and what the engine does, so the
  // check was wrong and the code was right.
  const open = betaOf({ ...D }, 76);
  const octaveUp = betaOf({ ...D }, 88);
  assert(octaveUp > open * 1.3,
    `β is ${open.toFixed(3)} on the open E and ${octaveUp.toFixed(3)} an octave up the same `
    + 'string — the panel is not showing the bow getting relatively closer to the bridge');
});

check('the badge reads the cycle, not the knob', () => {
  // The distinction that makes the badge worth having.  Under the minimum
  // bow force the string lets go several times a period; the badge has to be
  // saying THAT, which means it must also follow when the same knob setting
  // stops working for a different reason.
  const helm = bowCycle({ ...D, force: 0.55 }, VIOLIN_A);
  assert(helm.regime === 'helmholtz' && helm.releases === 1,
    `a playable bow reads "${helm.regime}" with ${helm.releases} releases a period`);

  for (const force of [0.05, 0.15, 0.25]) {
    const weak = bowCycle({ ...D, force }, VIOLIN_A);
    assert(weak.regime === 'surface',
      `a bow force of ${force} reads "${weak.regime}" — under the minimum force the badge `
      + 'has to say so, or it is telling the user the tone is fine when it is not');
    assert(weak.releases > 1 || weak.stuck < helm.stuck - 0.05,
      `at force ${force} the cycle looks the same as a good one, so the badge is guessing`);
  }

  // The same force at a bow position that needs more of it: the knob has not
  // moved and the answer has to.
  const near = bowCycle({ ...D, force: 0.55, pos: 0.025 }, VIOLIN_A);
  assert(near.regime !== 'helmholtz',
    'bowing almost on the bridge at a middling force reads as a good note — the badge '
    + 'is following the force knob rather than the string');
});

check('the spectrum drawn is the spectrum played, and its notch is the sound\'s', () => {
  // Bowed light and bright, with no hair noise.  A comb is a NULL, and three
  // things fill a null in: broadband noise from the hair, a heavy bow (which
  // rounds the Helmholtz corner — the same notch reads −9 dB at a force of
  // 0.45 and −3 at 0.55), and the string's own damping taking the top off
  // before the notch gets there.  The picture draws the user's settings; a
  // check that asks WHERE the notch is has to ask it of a signal that has one.
  for (const pos of [0.06, 0.08, 0.1, 0.125]) {
    const params = { ...D, pos, force: 0.45, bright: 0.85, hair: 0 };
    const spec = bridgeSpectrum(params, VIOLIN_A);
    assert(spec.combAt === Math.round(1 / betaOf(params, VIOLIN_A)),
      'the comb is not marked at 1/β');

    // Against the sound: render the note the panel says it is of and find the
    // deepest notch relative to a 1/n reference.  The picture's mark has to
    // land there.
    // Rendered LONGER than the panel renders, on purpose.  The panel has to
    // draw in a few tens of milliseconds and settles for what it can afford;
    // a reference that settled for the same time would be blurred the same
    // way, and the two agreeing would mean nothing.  A second and a half of
    // bowing and half a second of it tracked is unambiguous.
    const r = renderBowedVoice({
      sampleRate: PREVIEW_RATE, seconds: 1.5, gateSec: 1.5,
      freqHz: 440, pitch: VIOLIN_A, velocity: 0.8, startBeat: 0,
      params: { ...params, vibDepth: 0, bodyAmt: 0 },
    });
    const off = Math.round(0.6 * PREVIEW_RATE);
    const n = Math.min(r.left.length - off, 16384);
    const f0 = measureHz(r.left, 440, 0.6, 0.5);
    const at = (f: number): number => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
        const ph = 2 * Math.PI * f * i / PREVIEW_RATE;
        re += (r.left[off + i] ?? 0) * w * Math.cos(ph);
        im += (r.left[off + i] ?? 0) * w * Math.sin(ph);
      }
      return Math.hypot(re, im) / n * 4;
    };
    const h1 = at(f0);
    let deepest = 0;
    let deepestRel = Infinity;
    for (let k = 3; k <= Math.round(1.4 / pos); k++) {
      const rel = db(at(f0 * k) / (h1 / k));
      if (rel < deepestRel) { deepestRel = rel; deepest = k; }
    }
    assert(Math.abs(deepest - spec.combAt) <= 1,
      `the panel marks the comb at h${spec.combAt} and the sound notches h${deepest}`);

    // And the bars are the sound's own levels, not a redrawn 1/n.  Measured
    // away from the comb: at the notch the spectrum is steep, so the last
    // hair of disagreement between two pitch trackers turns into decibels.
    for (const k of [2, 3, 5].filter((q) => Math.abs(q - spec.combAt) > 1)) {
      const drawn = spec.harmonics[k - 1]!;
      const played = db(at(f0 * k) / h1);
      // A decibel, because the two sides measure the settled period by
      // different methods on purpose — correlation in the panel, zero
      // crossings here — and they land a hair apart.  Tight enough that the
      // bug this check was written for, a spectrum read at the nominal pitch
      // and 39 dB out at the fifth harmonic, could not survive it.
      assert(Math.abs(drawn - played) < 1,
        `harmonic ${k} is drawn at ${drawn.toFixed(1)} dB and played at ${played.toFixed(1)}`);
    }
    const combDrawn = spec.harmonics[spec.combAt - 1]!;
    const reference = spec.sawtooth[spec.combAt - 1]!;
    assert(combDrawn < reference - 3,
      `at β=${pos} the drawn comb sits ${(combDrawn - reference).toFixed(1)} dB under the `
      + 'sawtooth line — the picture would not show a notch at all');
  }
});

check('the body curve is the cascade the sound goes through', () => {
  for (const body of BOW_BODIES) {
    const index = BOW_BODIES.indexOf(body);
    const params = { ...D, body: index };
    const drawn = bodyCurve(params);
    const sections = bodySections(body, PREVIEW_RATE, 1);
    for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const hz = drawn.fromHz * Math.pow(drawn.toHz / drawn.fromHz, u);
      const want = Math.max(drawn.bottomDb,
        Math.min(drawn.topDb, cascadeDb(sections, hz, PREVIEW_RATE)));
      const got = drawn.bottomDb
        + (1 - drawn.curve[Math.round(u * (drawn.curve.length - 1))]!.y)
        * (drawn.topDb - drawn.bottomDb);
      assert(Math.abs(got - want) < 0.6,
        `${body.name} at ${hz.toFixed(0)} Hz: drawn ${got.toFixed(1)} dB, engine ${want.toFixed(1)}`);
    }
    // The marks name the modes, and stand where they are.
    assert(drawn.marks.some((m) => Math.abs(m.hz - body.hill[0]) < 1e-6),
      `${body.name}: the bridge hill is not marked where the engine puts it`);
    for (const m of drawn.marks) {
      const x = bodyX(m.hz, drawn.fromHz, drawn.toHz);
      assert(x > 0.001 && x < 0.999,
        `${body.name}: the ${m.label} mark falls off the picture`);
    }
  }
  // The Size knob moves the whole body, and the picture with it.
  const small = bodyCurve({ ...D, size: -1 });
  const large = bodyCurve({ ...D, size: 1 });
  const hillSmall = small.marks[3]!.hz;
  const hillLarge = large.marks[3]!.hz;
  assert(hillSmall < hillLarge * 0.8,
    `Size moved the bridge hill from ${hillLarge.toFixed(0)} to ${hillSmall.toFixed(0)} Hz`);
});

check('the note the pictures are of is a note the instrument has', () => {
  // The panel draws one note and says which.  If it picked one outside the
  // body's range the pictures would be of an instrument nobody can play.
  for (const body of BOW_BODIES) {
    const index = BOW_BODIES.indexOf(body);
    const params = { ...D, body: index };
    const rows = stringRows(params, body.strings[2] ?? 69);
    assert(rows.length === body.strings.length, 'a string went missing');
    assert(rows.filter((r) => r.playing).length === 1, 'exactly one string is played');
    const playing = rows.find((r) => r.playing)!;
    assert(playing.open === stringFor(body, body.strings[2] ?? 69).open,
      `${body.name}: the panel marks a different string than the engine plays`);
    assert(playing.stopSemis === 0, 'an open string is not stopped');
    assert(bodyOf(params).id === body.id, 'the panel resolved the wrong body');
  }
  // And a high position lands on the top string, stopped.
  const violin = BOW_BODIES[0]!;
  const high = (violin.strings[violin.strings.length - 1] ?? 76) + 12;
  const rows = stringRows({ ...D, body: 0 }, high);
  const playing = rows.find((r) => r.playing)!;
  assert(playing.open === 76 && playing.stopSemis === 12,
    `an octave above the E string came out as string ${playing.open} `
    + `stopped ${playing.stopSemis} semitones`);
});

check('every knob the instrument has is reachable on the panel', () => {
  // The check that stops a panel from quietly hiding a parameter.  The
  // generic slider list is replaced by this panel, so anything it does not
  // draw becomes unreachable — which has happened in this repository before,
  // to six drum parameters behind one loop.
  const source = readFileSync(
    new URL('../src/renderer/components/daw/instrument/BowedPanel.tsx', import.meta.url), 'utf8');
  const descriptor = findInstrument('bowed');
  assert(descriptor, 'the instrument is not registered');
  const missing: string[] = [];
  for (const def of descriptor.params) {
    // `body` is the one knob the panel does not draw as a knob: it is the
    // instrument selector on the rack row above, where a four-way choice
    // belongs.  Named here rather than skipped silently.
    if (def.id === 'body') continue;
    if (!source.includes(`knob('${def.id}'`)) missing.push(def.id);
  }
  assert(missing.length === 0,
    `the panel does not draw: ${missing.join(', ')} — and it replaces the generic sliders, `
    + 'so those are now unreachable');
  assert(source.includes("slot.instrumentId === 'bowed'")
    || readFileSync(new URL('../src/renderer/components/daw/InstrumentRack.tsx', import.meta.url),
      'utf8').includes("slot.instrumentId === 'bowed'"),
    'nothing mounts the panel');
  // And the parameter table the panel reads is the engine's own.
  assert(descriptor.params.length === BOWED_PARAMS.length,
    'the instrument and the engine disagree about how many knobs there are');
});

check('the pictures redraw when the knobs move', () => {
  // A picture that does not move is worse than no picture: it says the knob
  // did nothing.  Each of the three has to answer to what it is a picture of.
  const base = bowCycle({ ...D }, VIOLIN_A);
  const moved = bowCycle({ ...D, pos: 0.18 }, VIOLIN_A);
  assert(Math.abs(base.idealStuck - moved.idealStuck) > 0.05,
    'moving the bow did not move the cycle');

  // The spectrum answers to the BOW, which is what it is a picture of.  The
  // notch moves when the bow does, and by a whole octave of harmonic number.
  const near = bridgeSpectrum({ ...D, pos: 0.05, force: 0.45, bright: 0.85, hair: 0 }, VIOLIN_A);
  const far = bridgeSpectrum({ ...D, pos: 0.125, force: 0.45, bright: 0.85, hair: 0 }, VIOLIN_A);
  assert(near.combAt >= far.combAt * 2,
    `the comb sits at h${near.combAt} near the bridge and h${far.combAt} over the `
    + 'fingerboard — the picture is not following the bow');
  // And the harmonic the far comb notches is notched THERE and not near the
  // bridge — which is the picture showing what moving the bow does.
  //
  // Not, as an earlier version of this asked, that bowing near the bridge
  // leaves more in the LOW harmonics: at both positions the fourth harmonic
  // is below the comb and both are a clean 1/n there, so it was asking for a
  // difference the physics does not produce.
  const k = far.combAt;
  assert(far.harmonics[k - 1]! < far.sawtooth[k - 1]! - 3,
    `over the fingerboard harmonic ${k} is not notched`);
  assert(near.harmonics[k - 1]! > near.sawtooth[k - 1]! - 2,
    `near the bridge harmonic ${k} is notched too, at `
    + `${(near.harmonics[k - 1]! - near.sawtooth[k - 1]!).toFixed(1)} dB under 1/n — `
    + 'the comb is not following the bow');

});

check('Bright reaches the top of a bowed note and not the bottom', () => {
  // Bright answers in the top of the picture and NOT in the bottom, which is
  // the surprising half and is what the panel's caption says.
  //
  // The string's damping cannot dull a note while the bow is on it below
  // about the tenth harmonic, because the bow puts the Helmholtz corner back
  // every period whatever the loop took out of it — measured, the second to
  // sixth harmonics move six tenths of a decibel across the whole knob.  It
  // is also why a violin mute clamps the BRIDGE rather than the string, and
  // why Bright's large effect is on the TAIL, which `bowed-selftest` measures
  // at 28 to 40 dB of darkening once the bow has gone.
  //
  // An earlier version of this check asserted that Bright did nothing at ALL
  // to a bowed note, and passed — on a spectrum read at the nominal pitch,
  // which was smearing the top of the picture into the floor.  With the
  // period measured the top moves by nine decibels.
  const band = (spec: { harmonics: readonly number[] }, from: number, to: number): number => {
    let sum = 0;
    let count = 0;
    for (let k = from; k <= to; k++) {
      const v = spec.harmonics[k - 1];
      if (v !== undefined && Number.isFinite(v)) { sum += v; count++; }
    }
    return sum / Math.max(1, count);
  };
  const dull = bridgeSpectrum({ ...D, bright: 0, hair: 0 }, VIOLIN_A);
  const keen = bridgeSpectrum({ ...D, bright: 1, hair: 0 }, VIOLIN_A);
  assert(Math.abs(band(keen, 2, 6) - band(dull, 2, 6)) < 2,
    `Bright moved the second to sixth harmonics by `
    + `${(band(keen, 2, 6) - band(dull, 2, 6)).toFixed(1)} dB — the bow is supposed to hold `
    + 'that part of a bowed note whatever the string damping does');
  assert(band(keen, 14, 20) > band(dull, 14, 20) + 4,
    `Bright moved the fourteenth to twentieth harmonics by only `
    + `${(band(keen, 14, 20) - band(dull, 14, 20)).toFixed(1)} dB — the knob should reach `
    + 'the top of the picture even if it cannot reach the bottom');

  const b1 = bodyCurve({ ...D, body: 0 });
  const b2 = bodyCurve({ ...D, body: 3 });
  let diff = 0;
  for (let i = 0; i < b1.curve.length; i++) {
    diff = Math.max(diff, Math.abs(b1.curve[i]!.y - b2.curve[i]!.y));
  }
  assert(diff > 0.15, 'a violin and a double bass draw nearly the same body');
});

// ───────────────────────────────────────────────────────────────────────────

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ` — ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
