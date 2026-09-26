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
 * api` and Chromium agree exactly wherever the audio is arithmetic this repo
 * wrote — the guitars (buffers through biquads) and the synth (waves built
 * from explicit harmonic coefficients) — and DISAGREE wherever the
 * implementation chooses, which is its own band-limited oscillators.  The
 * drum kit is still built from those and sits 0.85 LU apart; the poly synth
 * was 1.40 dB apart until it stopped using the built-in `sawtooth`, and now
 * lands within 0.01.
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

import { INSTRUMENTS, findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { getLoudnessMetrics, type AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import { GENRE_ORDER } from '../src/renderer/daw/engine/plugin-presets-genre.js';
import { kitParamOf } from '../src/renderer/daw/engine/drum-presets.js';
import { migrateSession } from '../src/renderer/daw/model/session-migrate.js';
import {
  CALIBRATED_LEVEL, INSTRUMENT_TRIM, LEGACY_LEVEL_DEFAULTS,
  LEVEL_PEAK_CEILING_DBTP, LEVEL_TARGET_LUFS, PRE_CALIBRATION_INSTRUMENTS, REFERENCE_BEAT_SECONDS,
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
 * Re-measured whenever the trims change, by running this file.  Everything
 * but the kit lands on the target, because those are the instruments the two
 * renderers agree about; the kit sits 1.85 LU low because it does not.
 */
const NODE_REFERENCE_LUFS: Readonly<Record<string, number>> = {
  polysynth: -26.01, epiano: -26.06, agtr: -26.07, egtr: -26.00,
  piano: -26.00, upright: -26.00, bass: -25.86, mallet: -26.00, organ: -25.99,
  wavesynth: -26.00, analog: -26.00, fm: -26.00, bowed: -26.00, reed: -26.00,
};

/** What the analogue drum machine's reference beat measures under node. */
const NODE_REFERENCE_MACHINE_LUFS = -26.00;

/**
 * A note on the four that read exactly −26.00, and the one that does not.
 *
 * The trims were derived at 48 kHz and this suite renders at 44.1 (see `SR`),
 * so every number here is a re-measurement at a DIFFERENT rate — and the
 * pianos, the mallets and the organ come back at the target to the last
 * digit, while the bass moves 0.13 LU.
 *
 * That split is not luck.  The modal instruments place every partial at an
 * exact frequency and run an exact recursion, so changing the sample rate
 * changes nothing but how finely the same waveform is sampled.  The bass is a
 * Karplus-Strong delay line, and a delay line is an INTEGER number of
 * samples: at a different rate the same pitch rounds to a different loop
 * length, with a different fractional correction and a different excitation,
 * so the note is genuinely a slightly different note.
 *
 * Which means 0.13 LU is the cost of the delay line being what it is, and
 * not a calibration that needs tightening.
 */
const NODE_REFERENCE_KIT_MEDIAN_LUFS = -27.85;

/**
 * How far the two renderers are allowed to disagree.
 *
 * This is what stops the reference table above from being a licence to put
 * any number in it: a revoicing that moved an instrument 5 dB could be made
 * to pass by editing its reference, and this check is what would still fail.
 * 2.0 is the measured worst case (1.85 on the kit) with a little room.  It
 * was nearly the poly synth's as well, and that is a reason to keep the room
 * rather than to tighten it: an instrument can move back into the gap.
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

const MELODIC = [
  'polysynth', 'epiano', 'agtr', 'egtr', 'piano', 'upright', 'bass', 'mallet', 'organ',
  'wavesynth', 'analog', 'fm', 'bowed', 'reed',
] as const;

/**
 * Instruments this suite deliberately does not meter, and why.
 *
 * The kit is metered separately, across all eleven of its genres, because one
 * trim standing for eleven kits is the thing that needed checking about it.
 * The sampler's loudness is the loudness of the file somebody dropped in, and
 * no constant here can know that — its trim is 1 for that reason.
 *
 * Nothing else may be absent.  An instrument added later with a Level and no
 * entry in either list would otherwise be calibrated by nobody and pass this
 * suite by not being in it, which is how a suite that enumerates a list
 * quietly stops covering the thing it is named after.
 */
const NOT_METERED_HERE: Readonly<Record<string, string>> = {
  drumkit: 'metered across all eleven kits by its own check below',
  drummachine: 'a drum instrument, metered on a beat by its own check below',
  sampler: 'its loudness is the file the user loaded, so its trim is 1',
};

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

  await check('every instrument with a Level is either metered here or excused', () => {
    for (const inst of INSTRUMENTS) {
      if (!inst.params.some((prm) => prm.id === 'level')) continue;
      const metered = (MELODIC as readonly string[]).includes(inst.id);
      const excused = NOT_METERED_HERE[inst.id];
      assert(metered || excused !== undefined,
        `${inst.id} has a Level but is neither in MELODIC nor excused in NOT_METERED_HERE`);
      assert(!(metered && excused !== undefined),
        `${inst.id} is both metered and excused — one of the two lists is wrong`);
      if (excused !== undefined) {
        assert(excused.length >= 20, `${inst.id} is excused without a reason worth reading`);
      }
    }
  });

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
      // The guitar is the closest of the melodic instruments at −4.97, and
      // it used to be the one this ceiling was solved for: it landed at
      // −3.000 exactly, because its trim was decided by the ceiling rather
      // than by loudness.  It is not any more.  Its tone filter carried
      // 0.7 dB of resonance from a `Q` in the wrong units, which was worth
      // 2.4 dB of peak on a plucked transient and almost nothing in
      // loudness; correcting it handed the guitar its headroom back.  The
      // ceiling is now decided by the kit — see `no kit clips` below, where
      // the J-pop kit sits at −3.60.
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

  const machineBeat = getLoudnessMetrics(
    await render('drummachine', referenceBeat(), REFERENCE_BEAT_SECONDS));
  const machineHard = getLoudnessMetrics(
    await render('drummachine', referenceBeat(1.35), REFERENCE_BEAT_SECONDS));

  await check('the drum machine still measures what it did when calibrated', () => {
    assert(Math.abs(machineBeat.integratedLufs - NODE_REFERENCE_MACHINE_LUFS) <= TOLERANCE_LU,
      `the machine is ${machineBeat.integratedLufs.toFixed(2)} LUFS, was ${NODE_REFERENCE_MACHINE_LUFS}`);
    assert(machineHard.truePeakDbtp <= LEVEL_PEAK_CEILING_DBTP + 0.01,
      `a bar hit as hard as it goes peaks at ${machineHard.truePeakDbtp.toFixed(2)} dBTP`);
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
    for (const id of [...MELODIC, 'drumkit', 'drummachine', 'sampler']) {
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

  await check("the organ's drawbars change its level, in this renderer too", async () => {
    // Written because they did not.  `createPeriodicWave` takes a
    // `disableNormalization` flag; Chromium honours it and node-web-audio-api
    // ignores it and normalises everything to a peak of one — so under node
    // every registration came out at the same level, and the organ measured
    // 1.59 LU louder here than in the app.  A suite that metered the organ
    // without this check was metering a constant and could not have noticed.
    //
    // The engine normalises the coefficients itself now and hands the level
    // back as a gain, which is arithmetic both renderers run the same way.
    // Measured after that change: 11.24 LU here and 11.24 LU in Chromium.
    const root = REFERENCE_ROOT['organ'] ?? 48;
    const bars = (on: number): Record<string, number> => {
      const ids = ['db16', 'db513', 'db8', 'db4', 'db223', 'db2', 'db135', 'db113', 'db1'];
      const out: Record<string, number> = {};
      ids.forEach((id, i) => { out[id] = i < on ? 8 : 0; });
      return out;
    };
    const one = getLoudnessMetrics(await render(
      'organ', referencePhrase(root), REFERENCE_PHRASE_SECONDS, bars(1)));
    const nine = getLoudnessMetrics(await render(
      'organ', referencePhrase(root), REFERENCE_PHRASE_SECONDS, bars(9)));
    const spread = nine.integratedLufs - one.integratedLufs;
    assert(spread > 8,
      `all nine drawbars out is only ${spread.toFixed(2)} LU above one — the registration is not reaching the level`);
  });

  await check('the trim table covers every instrument that has a Level', () => {
    for (const inst of INSTRUMENTS) {
      if (!inst.params.some((prm) => prm.id === 'level')) continue;
      assert(inst.id in INSTRUMENT_TRIM, `${inst.id} has a Level but no trim`);
    }
  });

  // Split off from the trim check above, which used to make both claims at
  // once and asked for a legacy default from EVERY instrument with a Level.
  // That is right for the six that shipped before the calibration and wrong
  // for anything added after: a v2 file cannot contain an instrument that did
  // not exist when v2 did, so there is no old Level to re-read.  Adding the
  // grand piano failed it, and the honest repair is to say which instruments
  // the migration table is a claim ABOUT rather than to add an entry that
  // no session will ever match.
  await check('the migration table says something true about v2 sessions', () => {
    for (const id of PRE_CALIBRATION_INSTRUMENTS) {
      assert(findInstrument(id) !== undefined, `${id} is in the pre-calibration list but not in the app`);
      assert(id in LEGACY_LEVEL_DEFAULTS, `${id} shipped before v3 and has no legacy default, so old sessions skip it`);
    }
    for (const id of Object.keys(LEGACY_LEVEL_DEFAULTS)) {
      assert(PRE_CALIBRATION_INSTRUMENTS.includes(id),
        `${id} has a legacy default but did not exist before the calibration — no v2 session can contain it`);
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
