/**
 * instrument-level-selftest.ts — whether switching instrument is a level change.
 *
 * It used to be.  One phrase through the five instruments put them 16.4 LU
 * apart, and the poly synth, the Rhodes and the kit all went over 0 dBFS on a
 * chord played as hard as MIDI allows — so picking an instrument set the
 * loudness, and the loud ones clipped before the mixer ever saw them.
 *
 * A table of trim constants cannot be checked by reading it.  The numbers are
 * only correct with respect to a MEASUREMENT, so this suite renders every
 * instrument through the shared reference material and meters it with the
 * app's own loudness meter — the same `getLoudnessMetrics` the mastering side
 * uses.  If anyone revoices an instrument, its trim stops being true and this
 * fails, which is the entire point of pinning it here rather than in a
 * comment.
 *
 * ONE THING THIS SUITE CANNOT DO, stated up front because it looks like it
 * can: it is not rendering in the renderer the app runs on.  `node-web-audio-
 * api` and Chromium agree exactly on the two guitars — buffers through
 * biquads, which is arithmetic — and DISAGREE on the two instruments built
 * from oscillators, by 1.40 dB on the poly synth and 1.17 dB on the kit,
 * because a band-limited oscillator is each implementation's own choice.
 *
 * The user hears Chromium, so the trims are derived THERE (see
 * measure-levels-in-app.mjs) and what this file pins is that nothing has
 * drifted since — against NODE_REFERENCE_LUFS, which is what those same
 * trims measure as here.  The gap is data, not slack: it is bounded by
 * RENDERER_GAP_LU below, so the reference table cannot quietly be rewritten
 * to whatever the code happens to produce.
 *
 * What each check is load-bearing against:
 *
 *   · the target      — a trim drifting up or down on ONE instrument
 *   · the spread      — trims drifting TOGETHER, which the target alone
 *                       would still accept if they all moved
 *   · the ceiling     — a revoicing that widens an instrument's crest until
 *                       hard playing clips again
 *   · linearity       — Level ceasing to be a gain.  The Rhodes failed this
 *                       one for real: its knob sat in front of the pickup
 *                       waveshaper, so turning it down cleaned the sound up.
 *   · the kits        — all eleven, because the trim was measured on one
 *
 * Run via:  pnpm --filter @aimaster/desktop test:instrument-level
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { getLoudnessMetrics, type AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import { GENRE_ORDER } from '../src/renderer/daw/engine/plugin-presets-genre.js';
import { kitParamOf } from '../src/renderer/daw/engine/drum-presets.js';
import { migrateSession } from '../src/renderer/daw/model/session-migrate.js';
import {
  CALIBRATED_LEVEL, INSTRUMENT_TRIM, LEGACY_LEVEL_DEFAULTS,
  LEVEL_PEAK_CEILING_DBTP, LEVEL_TARGET_LUFS, REFERENCE_BEAT_SECONDS,
  REFERENCE_PHRASE_SECONDS, REFERENCE_ROOT, hardChord, referenceBeat,
  referencePhrase, type LevelEvent,
} from '../src/renderer/daw/engine/instrument-level.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: Error) => { results.push({ name, pass: false, detail: e.message }); });
}
function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

const SR = 44_100;

/**
 * How far a measurement may sit from the target.
 *
 * Not a slack the numbers need — every instrument lands inside 0.08 LU — but
 * the width of a difference nobody can hear.  Tightening it further would
 * make the suite fail on a WebAudio version bump rather than on a mistake.
 */
const TOLERANCE_LU = 0.4;

/**
 * What the calibrated instruments measure as HERE, under this suite's
 * renderer — not what they measure as in the app.
 *
 * Re-measured whenever the trims change, by running this file.  The two
 * guitars land on the target because the two renderers agree about them; the
 * poly synth sits 1.4 LU high and the kit 1.85 LU low because they do not.
 */
const NODE_REFERENCE_LUFS: Readonly<Record<string, number>> = {
  polysynth: -24.60, epiano: -26.00, agtr: -26.07, egtr: -26.00,
};
const NODE_REFERENCE_KIT_MEDIAN_LUFS = -27.85;

/**
 * How far the two renderers are allowed to disagree.
 *
 * This is what stops the reference table above from being a licence to put
 * any number in it: a revoicing that moved an instrument 5 dB could be made
 * to pass by editing its reference, and this check is what would still fail.
 * 2.0 is the measured worst case (1.85 on the kit) with a little room.
 */
const RENDERER_GAP_LU = 2.0;

async function render(
  id: string, events: readonly LevelEvent[], seconds: number,
  overrides: Record<string, number> = {},
): Promise<AudioBufferLike> {
  const inst = findInstrument(id);
  assert(inst !== undefined, `no instrument ${id}`);
  const params = { ...defaultInstrumentParams(id), ...overrides };
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  for (const e of events) {
    inst!.playNote({
      ctx: ctx as unknown as BaseAudioContext,
      destination: ctx.destination as unknown as AudioNode,
      note: createNote({ pitch: e.pitch, velocity: e.vel, startBeat: 0, durationBeat: 1 }),
      config: DEFAULT_MIDI_CONFIG, when: e.at, durationSec: e.dur, params,
    });
  }
  const buf = await ctx.startRendering();
  const l = Float32Array.from(buf.getChannelData(0));
  const r = Float32Array.from(buf.getChannelData(1));
  return {
    sampleRate: SR, length: l.length, numberOfChannels: 2,
    getChannelData: (c: number) => (c === 0 ? l : r),
  };
}

const MELODIC = ['polysynth', 'epiano', 'agtr', 'egtr'] as const;

async function main(): Promise<void> {
  // Measured once; every melodic check reads from here, so the suite renders
  // each instrument twice rather than twice per check.
  const measured = new Map<string, { lufs: number; hard: number }>();
  for (const id of MELODIC) {
    const root = REFERENCE_ROOT[id] ?? 48;
    const phrase = getLoudnessMetrics(
      await render(id, referencePhrase(root), REFERENCE_PHRASE_SECONDS));
    const hard = getLoudnessMetrics(await render(id, hardChord(root), 3));
    measured.set(id, { lufs: phrase.integratedLufs, hard: hard.truePeakDbtp });
  }

  await check('every melodic instrument still measures what it did when calibrated', () => {
    for (const id of MELODIC) {
      const m = measured.get(id)!;
      const want = NODE_REFERENCE_LUFS[id];
      assert(want !== undefined, `${id} has no recorded reference`);
      assert(Math.abs(m.lufs - want!) <= TOLERANCE_LU,
        `${id} is ${m.lufs.toFixed(2)} LUFS, was ${want!.toFixed(2)} when the trims were set`);
    }
  });

  // Separate from the check above, and the reason it is separate is the whole
  // argument of this file: the one above would accept ANY reference table,
  // including one written to match a broken instrument.  This one says the
  // table has to stay within a renderer's disagreement of the actual goal.
  await check('the reference table has not drifted away from the target', () => {
    for (const id of MELODIC) {
      const want = NODE_REFERENCE_LUFS[id]!;
      assert(Math.abs(want - LEVEL_TARGET_LUFS) <= RENDERER_GAP_LU,
        `${id}'s reference is ${want.toFixed(2)} LUFS, ${Math.abs(want - LEVEL_TARGET_LUFS).toFixed(2)} LU `
        + `from the ${LEVEL_TARGET_LUFS} target — further than the two renderers disagree`);
    }
    assert(Math.abs(NODE_REFERENCE_KIT_MEDIAN_LUFS - LEVEL_TARGET_LUFS) <= RENDERER_GAP_LU,
      `the kit's reference is ${NODE_REFERENCE_KIT_MEDIAN_LUFS} LUFS`);
  });

  await check('hard playing stays under the ceiling', () => {
    for (const id of MELODIC) {
      const m = measured.get(id)!;
      // Rounded before comparing: the acoustic guitar is deliberately ON the
      // ceiling — it has the widest crest of the five, so it is the
      // instrument the ceiling was solved for, and it lands at −3.000.
      assert(m.hard <= LEVEL_PEAK_CEILING_DBTP + 0.01,
        `${id} peaks at ${m.hard.toFixed(2)} dBTP on a four-note chord`);
    }
  });

  await check('Level is a gain, not a drive', async () => {
    // An instrument with something nonlinear downstream of its Level has a
    // knob that changes the SOUND, whatever its label says.  The Rhodes did:
    // its Level sat in front of the pickup waveshaper, so turning it down
    // cleaned the instrument up.
    //
    // Measured on the CREST, not on the loudness, because loudness barely
    // notices.  Under that exact regression, quartering the Level moved the
    // Rhodes by −11.97 dB instead of −12.04 — a 0.07 dB error that any
    // tolerance wide enough to survive a renderer update would wave through.
    // The crest moved 0.229 dB over the same change, and is 0.000 once the
    // knob is behind the pickup, so it separates the two states by 4× the
    // tolerance below instead of by a third of it.
    for (const id of MELODIC) {
      const root = REFERENCE_ROOT[id] ?? 48;
      const full = getLoudnessMetrics(await render(
        id, referencePhrase(root), REFERENCE_PHRASE_SECONDS));
      const quiet = getLoudnessMetrics(await render(
        id, referencePhrase(root), REFERENCE_PHRASE_SECONDS,
        { level: CALIBRATED_LEVEL / 4 }));
      const crest = (quiet.truePeakDbtp - quiet.integratedLufs)
        - (full.truePeakDbtp - full.integratedLufs);
      assert(Math.abs(crest) <= 0.05,
        `${id} changed shape by ${crest.toFixed(3)} dB of crest when only its Level moved`);
      // Still worth asserting the obvious one, to catch a Level that is not
      // a multiply at all.
      const delta = quiet.integratedLufs - full.integratedLufs;
      assert(Math.abs(delta + 12.04) <= 0.2,
        `${id} moved ${delta.toFixed(2)} dB when its Level was quartered, not −12.04`);
    }
  });

  // The kit's trim was measured on ONE kit.  Eleven ship, and a genre preset
  // is free to make its kick longer or its snare harder, so the ceiling has
  // to hold on the loudest of them and not just on the one that was measured.
  const kits: Array<[string, number]> = [
    ['built-in', 0], ...GENRE_ORDER.map((g) => [g, kitParamOf(g)] as [string, number]),
  ];
  const kitLufs = new Map<string, number>();
  let worstKit = { name: '', hard: -999 };
  for (const [name, kit] of kits) {
    const beat = getLoudnessMetrics(
      await render('drumkit', referenceBeat(), REFERENCE_BEAT_SECONDS, { kit }));
    const hard = getLoudnessMetrics(
      await render('drumkit', referenceBeat(1.35), REFERENCE_BEAT_SECONDS, { kit }));
    kitLufs.set(name, beat.integratedLufs);
    if (hard.truePeakDbtp > worstKit.hard) worstKit = { name, hard: hard.truePeakDbtp };
  }

  await check('no kit clips on a bar hit as hard as it goes', () => {
    assert(worstKit.hard <= LEVEL_PEAK_CEILING_DBTP + 0.01,
      `${worstKit.name} peaks at ${worstKit.hard.toFixed(2)} dBTP`);
  });

  await check('the kit still measures what it did when calibrated', () => {
    const values = [...kitLufs.values()].sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)]!;
    assert(Math.abs(median - NODE_REFERENCE_KIT_MEDIAN_LUFS) <= TOLERANCE_LU,
      `the median kit is ${median.toFixed(2)} LUFS, was ${NODE_REFERENCE_KIT_MEDIAN_LUFS}`);
  });

  await check('the kits keep their relative character', () => {
    const values = [...kitLufs.values()];
    const spread = Math.max(...values) - Math.min(...values);
    // Both ends, because this check exists to catch the WRONG fix as well as
    // the broken one: flattening the kits to one level would pass every other
    // check in this file and quietly delete what makes them different kits.
    assert(spread > 3 && spread < 9,
      `${spread.toFixed(1)} LU between the loudest and quietest kit`);
  });

  await check('the Level knob rests in the same place on every instrument', () => {
    for (const id of [...MELODIC, 'drumkit', 'sampler']) {
      const inst = findInstrument(id);
      assert(inst !== undefined, `no instrument ${id}`);
      const level = inst!.params.find((p) => p.id === 'level');
      assert(level !== undefined, `${id} has no Level`);
      assert(level!.default === CALIBRATED_LEVEL,
        `${id} rests at ${level!.default}, not ${CALIBRATED_LEVEL}`);
    }
  });

  await check('an older session\'s Level is re-read, not carried over', () => {
    // Proportional: the knob keeps the fraction of its default it was left at.
    const legacy = LEGACY_LEVEL_DEFAULTS['polysynth']!;
    const raw = {
      version: 2,
      tracks: [
        { id: 't1', instrumentId: 'polysynth', instrumentParams: { level: legacy, cutoffHz: 900 } },
        { id: 't2', instrumentId: 'epiano', instrumentParams: { level: LEGACY_LEVEL_DEFAULTS['epiano']! / 2 } },
        { id: 't3', instrumentId: 'polysynth', instrumentParams: { cutoffHz: 900 } },
        { id: 't4', kind: 'audio' },
      ],
    };
    const out = migrateSession(raw).session as unknown as {
      tracks: Array<{ instrumentParams?: Record<string, number> }>;
    };
    const [a, b, c] = out.tracks;
    assert(a!.instrumentParams!['level'] === CALIBRATED_LEVEL,
      `a track at its old default landed at ${String(a!.instrumentParams!['level'])}`);
    assert(a!.instrumentParams!['cutoffHz'] === 900, 'the other parameters did not survive');
    assert(Math.abs(b!.instrumentParams!['level']! - CALIBRATED_LEVEL / 2) < 1e-9,
      `a track at half its old default landed at ${String(b!.instrumentParams!['level'])}`);
    assert(c!.instrumentParams!['level'] === undefined,
      'a track that never stored a Level had one invented for it');
  });

  await check('the trim table covers every instrument that has a Level', () => {
    for (const id of [...MELODIC, 'drumkit', 'sampler']) {
      assert(id in INSTRUMENT_TRIM, `${id} has a Level but no trim`);
      assert(id in LEGACY_LEVEL_DEFAULTS, `${id} has no legacy default, so old sessions skip it`);
    }
  });

  console.log('\n=== Instrument levels — one target, or five opinions ===');
  for (const id of MELODIC) {
    const m = measured.get(id)!;
    console.log(`  ${id.padEnd(10)} ${m.lufs.toFixed(2).padStart(7)} LUFS   `
      + `hard ${m.hard.toFixed(2).padStart(7)} dBTP`);
  }
  const kv = [...kitLufs.values()];
  console.log(`  ${'drumkit'.padEnd(10)} ${Math.min(...kv).toFixed(2)} … ${Math.max(...kv).toFixed(2)} LUFS `
    + `over ${kv.length} kits, worst hard ${worstKit.hard.toFixed(2)} dBTP (${worstKit.name})`);

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
