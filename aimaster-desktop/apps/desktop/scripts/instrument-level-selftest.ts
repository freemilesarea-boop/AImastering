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

import {
  INSTRUMENTS, findInstrument, defaultInstrumentParams, pickupCurve,
} from '../src/renderer/daw/engine/instruments.js';
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
  polysynth: -26.01, epiano: -26.06, agtr: -26.00, egtr: -26.00,
  piano: -26.00, upright: -26.00, bass: -26.00, mallet: -26.00, organ: -25.99,
  wavesynth: -26.00, analog: -26.00, fm: -26.00, bowed: -26.00, reed: -26.00, plucked: -26.00,
  clavinet: -26.00,
};

/** What the analogue drum machine's reference beat measures under node. */
const NODE_REFERENCE_MACHINE_LUFS = -26.00;

/**
 * A note on the ones that read exactly −26.00 and the ones that do not.
 *
 * The older trims were derived at 48 kHz while this suite renders at 44.1 (see
 * `SR`), so for those, every number here is a re-measurement at a DIFFERENT
 * rate — and the pianos, the mallets and the organ come back at the target to
 * the last digit, while the bass moves 0.13 LU.
 *
 * That split is not luck.  The modal instruments place every partial at an
 * exact frequency and run an exact recursion, so changing the sample rate
 * changes nothing but how finely the same waveform is sampled.  The bass is a
 * Karplus-Strong delay line, and a delay line is an INTEGER number of
 * samples: at a different rate the same pitch rounds to a different loop
 * length, with a different fractional correction and a different excitation,
 * so the note is genuinely a slightly different note.  Measured in the app
 * since: the bass moves 0.345 LU between the two rates and the plucked family
 * 0.412, against 0.012 for the bowed strings and 0.004 for the organ.
 *
 * Which means 0.13 LU is the cost of the delay line being what it is, and
 * not a calibration that needs tightening.
 *
 * ── But the table is MIXED, and that is worth knowing ──────────────────────
 *
 * `measure-levels-in-app.mjs` renders at 44.1 now, so anything derived after
 * that change is a 44.1 entry rather than a 48 one — `plucked` reads exactly
 * −26.000 here, which is what a delay line calibrated AT the rate it is
 * measured at looks like, and it could not read that if it had come from a 48
 * kHz derivation.  So which rate an entry is calibrated at depends on when it
 * was added.  It is invisible for everything rate-insensitive and worth 0.13 to
 * 0.41 dB for the two delay-line families, and closing it means re-deriving the
 * whole table at one rate rather than patching entries.
 *
 * ── And one thing TOLERANCE_LU was quietly absorbing ───────────────────────
 *
 * `bowed` and `reed` are not part of any of that.  Both are rate-insensitive
 * (0.012 and 0.013 LU between 44.1 and 48 kHz) and neither was touched by the
 * filter correction, and both were simply miscalibrated: the app read them 0.40
 * dB loud and 0.31 dB quiet, and so did node.  Their references here said
 * −26.00 and the check passed anyway, because `TOLERANCE_LU` is 0.4 and 0.40 is
 * not more than 0.4 — the bowed strings sat exactly on the boundary.
 *
 * The tolerance is there to absorb the two renderers DISAGREEING, and for these
 * two there was no disagreement to absorb; it was covering an error instead.
 * The trims are corrected, both renderers now read the target, and the reason
 * this went unnoticed for so long is the stale list in
 * `measure-levels-in-app.mjs`: the tool that derives trims had stopped covering
 * either instrument, so nothing was re-deriving them at all.
 */
const NODE_REFERENCE_KIT_MEDIAN_LUFS = -28.29;

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

/**
 * The same bound for the kit, which is far from the target for a DIFFERENT
 * reason — and that is why it is not the same number.
 *
 * Everything in the melodic table above sits near −26 because loudness decided
 * its trim, so a gap there really is the two renderers disagreeing and 2.0 is
 * the right thing to bound it with.  The kit's trim is not set by loudness at
 * all: the ceiling binds first, so one trim standing for eleven kits has to be
 * quiet enough that the LOUDEST of them survives a bar hit as hard as MIDI goes.
 * Honouring that in the app costs another 0.44 LU, which the old shared bound
 * would have refused.
 *
 * Raising `RENDERER_GAP_LU` to fit it would have bought that room for every
 * melodic instrument too, which is exactly the licence that constant exists to
 * withhold.  So the kit gets its own allowance, with its own reason written
 * next to it, and the melodic bound stays where it was.
 */
const CEILING_LIMITED_GAP_LU = 2.5;

/**
 * What changing the sample rate does to each string instrument's loudness.
 *
 * ── Why this table exists ──────────────────────────────────────────────────
 *
 * A trim is one number and the app runs at whatever rate the audio device runs
 * at, so an instrument whose loudness depends on the rate cannot be calibrated
 * — one of the two rates will be wrong, and no entry in `INSTRUMENT_TRIM` can
 * fix it.  Only the Karplus-Strong instruments have this problem: everything
 * modal, additive or rendered into a buffer by our own code reads within 0.01
 * LU at both rates.
 *
 * Most of it is gone.  The loop's fractional delay used to be an interpolation
 * towards the next sample, which is a lowpass whose loss depends on where the
 * rounding landed — and the fraction for a given pitch is a different number at
 * a different rate.  Measured with one ruler across six pitches, the high band's
 * T60 ratio between 44.1 and 48 kHz was a lottery: 1.27, 1.72, 1.66, 1.02, 1.02,
 * 0.97 — the same instrument ringing 72 per cent longer up top at one note and 3
 * per cent shorter at another.  With a first-order allpass, which has unity
 * magnitude at every frequency, it is 1.10 to 1.33 and always in the same
 * direction, which is the loop's two-point averager and nothing else: its
 * response is `cos(πf/sr)`, and that predicts 1.19 against 1.18 measured.
 *
 * The excitation was the other half.  It was `L` samples of a seeded noise
 * sequence, low-passed by a fixed coefficient and combed at a rounded number of
 * samples — and `L` is proportional to the rate, so the same note was a
 * different draw, filtered at a different corner in hertz, notched at a
 * different harmonic.  Built harmonic by harmonic instead, every harmonic that
 * exists at two rates is identical at both, and the pick position stops being
 * quantised.
 *
 * ── Why three of these four got BIGGER, and why that is the fix working ────
 *
 * Before the excitation was rebuilt the four read −0.027, −0.534, +0.145 and
 * −0.318 LU: scattered, and in both directions.  They now read +0.17 to +0.44,
 * all the same sign, ordered by how much high-frequency energy each instrument
 * carries — the bass lowest, the electric guitar highest.  That is one cause
 * showing through instead of two, and the one left is the loop's averager.
 *
 * So `plucked`'s old 0.027 was not invariance.  It was the excitation's random
 * error happening to cancel the loop's systematic one, which is a worse thing
 * to have than the honest 0.305 that replaced it: a number small by
 * cancellation moves the moment anything else changes.
 *
 * Each number is pinned rather than bounded, because a change in either
 * direction is news: smaller means somebody improved it and this table should
 * say so, larger means a regression.
 */
const RATE_GAP_LU: Readonly<Record<string, number>> = {
  plucked: 0.305, bass: 0.169, agtr: 0.399, egtr: 0.435,
};

/** How far a rate gap may drift from the table above before it is news. */
const RATE_GAP_TOLERANCE_LU = 0.12;

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
  'wavesynth', 'analog', 'fm', 'bowed', 'reed', 'plucked', 'clavinet',
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

  await check('a shaper fed silence gives silence back', async () => {
    // What a WaveShaper does with an input of exactly zero is decided by its
    // point COUNT, not by the shape: the spec maps x in [-1, 1] onto index
    // (x + 1) / 2 * (n - 1) and interpolates, so an even count has no sample
    // at zero and answers with the midpoint of the two nearest.  For a curve
    // that is asymmetric on purpose that midpoint is not zero — 4.5e-4 for
    // the Rhodes pickup, which rode on the bus for as long as the voice was
    // connected.  Checked across the whole knob, because the error grows
    // with the asymmetry.
    const atZero = (curve: Float32Array): number => {
      const idx = (curve.length - 1) / 2;
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return curve[lo]! * (1 - (idx - lo)) + curve[hi]! * (idx - lo);
    };
    for (const amount of [0.001, 0.1, 0.35, 0.7, 1]) {
      const curve = pickupCurve(amount);
      assert(curve.length % 2 === 1,
        `the pickup curve has ${curve.length} points — an even count has no sample at zero`);
      const dc = atZero(curve);
      assert(dc === 0, `pickup ${amount} maps silence to ${dc.toExponential(2)}`);
    }
    await Promise.resolve();
  });

  await check('no instrument leaves DC on the bus', async () => {
    // A waveshaper that is asymmetric on purpose puts out DC, and so does a
    // pulse wave whose duty is not a half.  Both are correct modelling and
    // both need what the real electronics have: an output coupling.  Measured
    // in the app before there was one, DC against the same passage's RMS —
    // the Rhodes pickup at −14.0 dB (a fifth of its level was a constant) and
    // the analog synth's pulse at −38.3 dB.  It eats headroom where no meter
    // shows it, biases the peak a limiter sees, and SUMS across voices.
    //
    // −60 dB is the bar because every instrument here is now below −70, and
    // both of the ones that failed were tens of dB above it.
    const worst: Array<{ id: string; db: number }> = [];
    for (const inst of INSTRUMENTS) {
      if (inst.id === 'sampler') continue;              // silent with no library loaded
      const root = REFERENCE_ROOT[inst.id] ?? 48;
      const buf = await render(inst.id, referencePhrase(root), REFERENCE_PHRASE_SECONDS);
      const ch = buf.getChannelData(0);
      let sum = 0, sq = 0;
      for (let i = 0; i < ch.length; i += 1) { sum += ch[i]!; sq += ch[i]! * ch[i]!; }
      const dc = sum / ch.length;
      const rms = Math.sqrt(sq / ch.length);
      assert(rms > 1e-4, `${inst.id} rendered silence (${rms.toExponential(2)})`);
      worst.push({ id: inst.id, db: 20 * Math.log10(Math.abs(dc) / rms) });
    }
    worst.sort((a, b) => b.db - a.db);
    const over = worst.filter((w) => w.db > -60);
    assert(over.length === 0,
      `DC on the bus: ${over.map((w) => `${w.id} ${w.db.toFixed(1)} dB`).join(', ')}`);
    console.log(`      (worst DC: ${worst.slice(0, 3).map((w) => `${w.id} ${w.db.toFixed(1)}`).join(', ')} dB of their own RMS)`);
  });

  await check('a string instrument sounds as loud at 48 kHz as at 44.1', async () => {
    // Rendered here rather than reusing `measured`, because `render` uses the
    // suite's own SR and the whole point is to change it.
    const at = async (id: string, sr: number): Promise<number> => {
      const inst = findInstrument(id);
      assert(inst !== undefined, `no instrument ${id}`);
      const root = REFERENCE_ROOT[id] ?? 48;
      const ctx = new OfflineAudioContext(
        2, Math.round(sr * REFERENCE_PHRASE_SECONDS), sr);
      for (const e of referencePhrase(root)) {
        inst!.playNote({
          ctx: ctx as unknown as BaseAudioContext,
          destination: ctx.destination as unknown as AudioNode,
          note: createNote({ pitch: e.pitch, velocity: e.vel, startBeat: 0, durationBeat: 1 }),
          config: DEFAULT_MIDI_CONFIG, when: e.at, durationSec: e.dur,
          params: defaultInstrumentParams(id),
        });
      }
      const buf = await ctx.startRendering();
      const l = buf.getChannelData(0); const r = buf.getChannelData(1);
      return getLoudnessMetrics({
        sampleRate: sr, length: l.length, numberOfChannels: 2,
        getChannelData: (c: number) => (c === 0 ? l : r),
      } as unknown as AudioBufferLike).integratedLufs;
    };
    for (const [id, want] of Object.entries(RATE_GAP_LU)) {
      const got = (await at(id, 48_000)) - (await at(id, 44_100));
      assert(Math.abs(got - want) <= RATE_GAP_TOLERANCE_LU,
        `${id} moves ${got.toFixed(3)} LU between 44.1 and 48 kHz, was ${want}`);
    }
  });

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
    assert(Math.abs(NODE_REFERENCE_KIT_MEDIAN_LUFS - LEVEL_TARGET_LUFS) <= CEILING_LIMITED_GAP_LU,
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
