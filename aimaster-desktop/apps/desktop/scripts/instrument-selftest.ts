/**
 * instrument-selftest.ts — the built-in instruments.
 *
 * The interesting thing about the two guitars is WHERE they are computed.
 * A Karplus-Strong string is a delay line fed back through a filter, and the
 * delay length is the pitch — so it was built from native WebAudio nodes
 * first, like every other device here.  That cannot work, and the reason is
 * worth a test rather than a comment:
 *
 *   Chromium clamps a DelayNode inside a FEEDBACK loop to one render quantum
 *   (128 samples).  Every guitar note needs a shorter delay than that, so the
 *   pitch became whatever the clamp said — 440 Hz came out at 200 Hz — and
 *   the loop exploded to 9.5e17 rather than ringing.
 *
 * So the string is computed sample by sample into a buffer.  That has a
 * property the node version could never have had, and it is the one this
 * repo keeps needing: the result is IDENTICAL in the polyfill these tests run
 * on and in the Chromium the app runs on, because it is arithmetic rather
 * than a host's interpretation of a graph.  The reverb suite has to carry a
 * warning that a green run there is not evidence about Chromium; this one
 * does not.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:instruments
 */

import { INSTRUMENTS, findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { pluckedString, stringDelay } from '../src/renderer/daw/engine/string-model.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const SR = 48000;
const cents = (got: number, want: number): number => 1200 * Math.log2(got / want);

/** The period the loop actually runs at, from its parts. */
function loopPeriod(freq: number, sr: number): number {
  const { length, frac } = stringDelay(freq, sr);
  return length - frac + 0.5;      // delay line − fractional read + filter
}

// ── Tuning ──────────────────────────────────────────────────────────────────

check('the delay line adds up to the period it is asked for', () => {
  // The whole tuning argument in one assertion.  Interpolating toward the
  // NEXT sample subtracts the fraction; the two-point loop filter adds half a
  // sample.  Getting either sign wrong puts the instrument out of tune by
  // more at higher pitches, which is exactly how it read when it was wrong.
  for (const f of [82.41, 110, 164.81, 220, 329.63, 440, 659.26, 880]) {
    const err = Math.abs(loopPeriod(f, SR) - SR / f);
    assert(err < 1e-9, `${f} Hz: loop is ${loopPeriod(f, SR)} samples, wants ${SR / f}`);
  }
});

check('a guitar plays in tune across its whole range', () => {
  // E2 to E5 is where a guitar actually lives.  Anything past a few cents
  // there is audible against another instrument.
  for (const f of [82.41, 110, 146.83, 196, 246.94, 329.63, 440, 659.26]) {
    const played = SR / loopPeriod(f, SR);
    assert(Math.abs(cents(played, f)) < 1,
      `${f} Hz plays ${cents(played, f).toFixed(1)} cents off`);
  }
});

check('the top of the range is honest about its limit', () => {
  // At E6 a period is 36 samples and there is nowhere left to put the
  // fraction.  The error is the sample rate's, not the model's — but it is
  // real, so it is stated rather than hidden behind a looser tolerance.
  const played = SR / loopPeriod(1318.51, SR);
  assert(Math.abs(cents(played, 1318.51)) < 1,
    `E6 is ${cents(played, 1318.51).toFixed(1)} cents off in the arithmetic`);
});

// ── The string itself ───────────────────────────────────────────────────────

const pluck = (over: Partial<Parameters<typeof pluckedString>[0]> = {}) => pluckedString({
  freqHz: 220, sampleRate: SR, seconds: 2,
  damping: 0.997, brightness: 0.8, pickPosition: 0.15, seed: 12345, ...over,
});

check('the same note renders the same samples every time', () => {
  // The engine's contract: a bounce sounds like the preview.  A string
  // excited by Math.random() would break that on every render, and nothing
  // else in the app would notice.
  const a = pluck(), b = pluck();
  assert(a.length === b.length, 'lengths differ');
  for (let i = 0; i < a.length; i += 97) {
    assert(a[i] === b[i], `sample ${i} differs: ${a[i]} vs ${b[i]}`);
  }
});

check('different notes are different strings', () => {
  const a = pluck({ seed: 1 }), b = pluck({ seed: 2 });
  let differing = 0;
  for (let i = 0; i < a.length; i += 13) if (a[i] !== b[i]) differing++;
  assert(differing > a.length / 13 * 0.5, 'two seeds produced the same string');
});

check('the string decays and never runs away', () => {
  // The failure mode of every feedback loop in this codebase, and the one
  // that took the spring reverb to 3.6e12 before it was caught.
  for (const f of [82.41, 220, 440, 880, 1318.51]) {
    for (const damping of [0.99, 0.997, 0.9995]) {
      const y = pluckedString({
        freqHz: f, sampleRate: SR, seconds: 3, damping,
        brightness: 0.8, pickPosition: 0.15, seed: 7,
      });
      let peak = 0, head = 0, tail = 0;
      for (let i = 0; i < y.length; i++) {
        const a = Math.abs(y[i]!);
        assert(Number.isFinite(y[i]!), `${f} Hz damping ${damping}: not finite at ${i}`);
        if (a > peak) peak = a;
        if (i < SR * 0.1 && a > head) head = a;
        if (i > SR * 2.5 && a > tail) tail = a;
      }
      assert(peak <= 1.5, `${f} Hz damping ${damping}: peak ${peak}`);
      assert(tail < head, `${f} Hz damping ${damping}: louder at the end (${tail}) than the start (${head})`);
    }
  }
});

check('damping is what sustain means — more of it rings longer', () => {
  const late = (damping: number): number => {
    const y = pluckedString({
      freqHz: 220, sampleRate: SR, seconds: 3, damping,
      brightness: 0.8, pickPosition: 0.15, seed: 7,
    });
    let s = 0;
    for (let i = Math.round(SR * 2); i < y.length; i++) s += y[i]! * y[i]!;
    return Math.sqrt(s / (y.length - Math.round(SR * 2)));
  };
  const acoustic = late(0.9955), electric = late(0.9987);
  assert(electric > acoustic * 3,
    `the electric's string (${electric.toExponential(2)}) does not outlast the acoustic's (${acoustic.toExponential(2)})`);
});

check('pick position is a comb, so it changes the tone and not the level', () => {
  // Plucking near the bridge cancels a different set of harmonics from
  // plucking over the middle.  If this only changed the level it would be a
  // volume knob with a physical-sounding name.
  const bright = (pos: number): number => {
    const y = pluck({ pickPosition: pos });
    let zc = 0;
    for (let i = 1; i < SR; i++) if ((y[i - 1]! < 0) !== (y[i]! < 0)) zc++;
    return zc;
  };
  const bridge = bright(0.03), middle = bright(0.45);
  assert(bridge !== middle, 'pick position changed nothing');
  assert(bridge > middle,
    `plucking at the bridge (${bridge} crossings) should be brighter than over the middle (${middle})`);
});

// ── The instruments ─────────────────────────────────────────────────────────

check('the guitars and the Rhodes are registered', () => {
  for (const id of ['epiano', 'agtr', 'egtr', 'polysynth']) {
    assert(findInstrument(id), `${id} is not in INSTRUMENTS`);
  }
  assert(findInstrument('epiano')!.name.includes('Rhodes'),
    'the e-piano no longer says what it is');
});

check('every instrument parameter has a default inside its own range', () => {
  for (const inst of INSTRUMENTS) {
    const defaults = defaultInstrumentParams(inst.id);
    for (const p of inst.params) {
      assert(p.min < p.max, `${inst.id}.${p.id}: empty range`);
      assert(p.default >= p.min && p.default <= p.max,
        `${inst.id}.${p.id}: default ${p.default} outside [${p.min}, ${p.max}]`);
      assert(defaults[p.id] === p.default, `${inst.id}.${p.id}: default not reported`);
    }
  }
});

check('the Rhodes keeps the parameters sessions were saved with', () => {
  // Its ids and defaults are a compatibility surface: a part saved before the
  // rebuild has to open sounding like the same instrument.
  const rhodes = findInstrument('epiano')!;
  for (const [id, def] of [['ratio', 3], ['index', 3.2], ['decay', 1.6], ['release', 0.35], ['level', 0.25]] as const) {
    const p = rhodes.params.find((x) => x.id === id);
    assert(p, `the Rhodes dropped ${id}, which old sessions store`);
    assert(p!.default === def, `${id}'s default moved from ${def} to ${p!.default}`);
  }
});

console.log('\n=== Instruments — a Rhodes and two guitars ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
