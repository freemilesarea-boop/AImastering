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

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;
import { INSTRUMENTS, findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { pluckedString, stringDelay } from '../src/renderer/daw/engine/string-model.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';

const STEREO_SR = 48_000;

/** One held note as two channels, through the real voice. */
async function renderStereo(
  id: string, pitch: number, over: Record<string, number>,
): Promise<Float32Array[]> {
  const inst = findInstrument(id)!;
  const ctx = new OfflineAudioContext(2, STEREO_SR * 2, STEREO_SR);
  inst.playNote({
    ctx: ctx as unknown as BaseAudioContext,
    destination: ctx.destination as unknown as AudioNode,
    note: createNote({ pitch, velocity: 0.85, startBeat: 0, durationBeat: 4 }),
    config: DEFAULT_MIDI_CONFIG, when: 0, durationSec: 1.6,
    params: { ...defaultInstrumentParams(id), ...over },
  });
  const buf = await ctx.startRendering();
  return [Float32Array.from(buf.getChannelData(0)), Float32Array.from(buf.getChannelData(1))];
}

/** Side energy against total, in dB.  −inf is a signal with no width at all. */
async function sideDb(id: string, pitch: number, over: Record<string, number>): Promise<number> {
  const [l, r] = await renderStereo(id, pitch, over) as [Float32Array, Float32Array];
  let side = 0, total = 0;
  for (let i = 0; i < l.length; i++) {
    side += (l[i]! - r[i]!) ** 2;
    total += l[i]! ** 2 + r[i]! ** 2;
  }
  return total > 0 ? 10 * Math.log10(Math.max(1e-30, side / total)) : -Infinity;
}

/** Total power across BOTH channels — what a placement must not change. */
async function totalDb(id: string, pitch: number, over: Record<string, number>): Promise<number> {
  const ch = await renderStereo(id, pitch, over);
  let sum = 0, n = 0;
  for (const c of ch) { for (const v of c) sum += v * v; n += c.length; }
  return 10 * Math.log10(Math.max(1e-30, sum / Math.max(1, n)));
}
import { LEGACY_LEVEL_DEFAULTS } from '../src/renderer/daw/engine/instrument-level.js';
import { migrateSession } from '../src/renderer/daw/model/session-migrate.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
/**
 * Run a check now if it is synchronous, or queue it if it is not.
 *
 * The stereo checks have to RENDER, and the rest of this file was written
 * before anything here did.  Queueing rather than converting every check
 * keeps the sync ones reading as they did.
 */
const pending: Array<Promise<void>> = [];
function check(name: string, fn: () => void | Promise<void>): void {
  try {
    const out = fn();
    if (out instanceof Promise) {
      pending.push(out
        .then(() => { results.push({ name, pass: true, detail: '' }); })
        .catch((e: unknown) => {
          results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
        }));
      return;
    }
    results.push({ name, pass: true, detail: '' });
  } catch (e) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
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
  for (const [id, def] of [['ratio', 3], ['index', 3.2], ['decay', 1.6], ['release', 0.35]] as const) {
    const p = rhodes.params.find((x) => x.id === id);
    assert(p, `the Rhodes dropped ${id}, which old sessions store`);
    assert(p!.default === def, `${id}'s default moved from ${def} to ${p!.default}`);
  }
});

check('Level is the one default allowed to move, and only behind a migration', () => {
  // `level` was pinned alongside the four above until calibration moved it —
  // the instruments were 16 LU apart and the knob was carrying the
  // difference.  What the pin was FOR still holds, so it is asserted here
  // rather than deleted: an old session must still open sounding like the
  // instrument it was saved with.  That is now the migration's job, so the
  // check follows it there.
  //
  // 0.25 stays written down because a migration that has forgotten what it is
  // converting FROM converts nothing.
  const rhodes = findInstrument('epiano')!;
  const level = rhodes.params.find((x) => x.id === 'level');
  assert(level, 'the Rhodes dropped level, which old sessions store');
  assert(LEGACY_LEVEL_DEFAULTS['epiano'] === 0.25,
    `the migration thinks the old Rhodes rested at ${String(LEGACY_LEVEL_DEFAULTS['epiano'])}, not 0.25`);
  const opened = migrateSession({
    version: 2,
    tracks: [{ id: 't', instrumentId: 'epiano', instrumentParams: { level: 0.25, index: 3.2 } }],
  }).session as unknown as { tracks: Array<{ instrumentParams: Record<string, number> }> };
  assert(opened.tracks[0]!.instrumentParams['level'] === level!.default,
    'a Rhodes saved at the old default does not open at the new one');
  assert(opened.tracks[0]!.instrumentParams['index'] === 3.2,
    'the migration lost the parameters it was not asked to touch');
});

// ── Where the sound sits ────────────────────────────────────────────────────

check('width is given only where there are two sources', async () => {
  // Measured before any of this: every melodic instrument's side channel sat
  // at negative infinity.  Dead mono is a real quality gap against any
  // commercial library — and the fix is NOT to widen everything.  One
  // plucked string is one source, and spreading it would be inventing a room
  // rather than modelling an instrument.  So:
  //
  //   one guitar          mono           two strings (12-string, double)  wide
  //   a Rhodes on its DI  mono           a suitcase's tremolo             wide
  //
  // A suitcase's tremolo IS a pan — the cabinet has two speakers and the
  // oscillator moves the signal between them — which is why one sounds
  // enormous next to a stage piano through the same amp.  Modelling it as
  // amplitude alone got the wobble and threw away the reason for it.
  const cases: Array<[string, number, Record<string, number>, boolean, string]> = [
    ['agtr', 52, {}, false, 'one string'],
    ['agtr', 52, { double: 0.9 }, true, 'twelve-string'],
    ['egtr', 52, {}, false, 'one string'],
    ['egtr', 52, { double: 0.85 }, true, 'double-tracked'],
    ['epiano', 48, {}, false, 'straight out of the DI'],
    ['epiano', 48, { tremRate: 5.2, tremDepth: 0.5 }, true, 'suitcase'],
  ];
  for (const [id, pitch, over, wide, label] of cases) {
    const side = await sideDb(id, pitch, over);
    if (wide) {
      assert(side > -25, `${id} (${label}) came out at ${side.toFixed(1)} dB of side — it is mono`);
    } else {
      assert(side < -60, `${id} (${label}) came out at ${side.toFixed(1)} dB of side — it is one source`);
    }
  }
});

check('placing the two strings does not change the level', async () => {
  // A StereoPanner does not up-mix, so putting one in a path that had none
  // costs exactly 3 dB of total power.  Without a makeup gain Width would be
  // a level control — which is what it was, measured, on the synth.
  for (const id of ['agtr', 'egtr']) {
    const centred = await totalDb(id, 52, { double: 0.9, width: 0 });
    for (const width of [0.4, 1]) {
      const placed = await totalDb(id, 52, { double: 0.9, width });
      assert(Math.abs(placed - centred) < 0.7,
        `${id}: width ${width} moved the level by ${(placed - centred).toFixed(2)} dB`);
    }
  }
});

check('the suitcase tremolo still swings, and swings less as it spreads', async () => {
  // Width trades the amplitude swing for a pan, so at full width the level
  // should barely move while the image does.  A tremolo that kept BOTH would
  // be twice the effect it was asked for.
  const swing = async (width: number): Promise<number> => {
    const ch = await renderStereo('epiano', 48, { tremRate: 5.2, tremDepth: 0.8, width });
    const mono = ch[0]!.map((v, i) => (v + ch[1]![i]!) / 2);
    const win = Math.round(48_000 * 0.02);
    const levels: number[] = [];
    for (let at = Math.round(48_000 * 0.2); at + win < 48_000 * 1.2; at += win) {
      let sum = 0;
      for (let i = at; i < at + win; i++) sum += mono[i]! * mono[i]!;
      levels.push(Math.sqrt(sum / win));
    }
    return 20 * Math.log10(Math.max(1e-9, Math.max(...levels) / Math.max(1e-9, Math.min(...levels))));
  };
  const amplitude = await swing(0), spread = await swing(1);
  assert(amplitude > 6, `with width 0 the tremolo only swings ${amplitude.toFixed(1)} dB`);
  assert(spread < amplitude - 3,
    `at full width the level still swings ${spread.toFixed(1)} dB — the pan was added, not traded`);
});

async function main(): Promise<void> {
  await Promise.all(pending);
  console.log('\n=== Instruments — a Rhodes and two guitars ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
