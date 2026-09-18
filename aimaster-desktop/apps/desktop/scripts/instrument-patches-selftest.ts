/**
 * instrument-patches-selftest.ts — a preset bank, checked the way one rots.
 *
 * A bank of forty patches is the easiest thing in a program to ship broken and
 * have nobody notice, because nobody reads forty parameter maps.  What happens
 * instead is that one gets pasted from its neighbour and half-edited, and the
 * menu goes on claiming forty answers while holding thirty.
 *
 * So none of these checks are "does it load":
 *
 *   · no patch names a parameter its instrument does not have   (the typo)
 *   · no patch sets one outside the instrument's own range      (the guess)
 *   · no two patches of an instrument hold the same numbers     (the paste)
 *   · and they are not merely a rounding apart                  (the near-paste)
 *   · no patch sets `level`                                     (the regression)
 *   · every patch renders, and lands on the calibrated target   (the surprise)
 *
 * The duplicate check is load-bearing beyond tidiness.  Which patch a track is
 * on is DERIVED by comparing its parameters against the bank — two patches
 * with the same numbers would make that answer arbitrary, so `activePatch`
 * only means anything because this passes.
 *
 * The last one is the reason this suite renders at all.  A patch stacking
 * seven voices with drive on is a different LOUDNESS as well as a different
 * sound, and picking a sound must not be a level change — that was the whole
 * point of the calibration.  No amount of reading the table would show it.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:instrument-patches
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { INSTRUMENTS, findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import {
  CATEGORY_LABEL, INSTRUMENT_PATCHES, PATCH_CATEGORIES, activePatch,
  categoriesFor, findPatch, patchParams, patchesFor,
} from '../src/renderer/daw/engine/instrument-patches.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { getLoudnessMetrics, type AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import {
  CALIBRATED_LEVEL, LEVEL_PEAK_CEILING_DBTP, REFERENCE_PHRASE_SECONDS,
  REFERENCE_BEAT_SECONDS, REFERENCE_ROOT, hardChord, referenceBeat, referencePhrase,
  type LevelEvent,
} from '../src/renderer/daw/engine/instrument-level.js';

/** Instruments whose notes are drums, so a chord is the wrong stimulus. */
const DRUM_INSTRUMENTS = new Set(['drumkit', 'drummachine']);

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
const INSTRUMENT_IDS = Object.keys(INSTRUMENT_PATCHES);

/**
 * Instruments that legitimately ship without a patch bank, and why.
 *
 * Everything else in this file iterates the instruments that HAVE patches,
 * which is the shape of check that stops covering the thing it is named
 * after: seven instruments with parameters and no patches drifted out of it
 * without anything failing.  This is the list that makes that impossible.
 */
const NO_PATCHES: Readonly<Record<string, string>> = {
  drumkit: 'eleven genre kits of its own — a patch per DRUM rather than per instrument',
  sampler: 'its sound is the file the user dropped in, and no patch can know that',
};

async function render(
  instrumentId: string, params: Record<string, number>,
  events: readonly LevelEvent[], seconds: number,
): Promise<AudioBufferLike> {
  const inst = findInstrument(instrumentId)!;
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  for (const e of events) {
    inst.playNote({
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

/**
 * How hard a patch HITS — the loudest 100 ms of the phrase, as plain RMS.
 *
 * Not integrated loudness over the phrase, which measures something else: a
 * stab with no sustain is silent for most of it and reads 20 LU below an
 * organ that holds, even when the two hit exactly as hard.  That is a
 * difference in LENGTH, and flattening it would flatten what makes them
 * different patches.  Not BS.1770's 400 ms momentary either, for the same
 * reason at a smaller scale: a 160 ms stab spends more than half of that
 * window decayed to nothing.
 *
 * Plain RMS rather than K-weighted, because every patch is compared by the
 * same method and the weighting would only add an opinion about which
 * frequencies count — and this is not a loudness spec, it is the question of
 * whether picking a patch makes the user reach for the fader.
 */
function hitLevelDb(buffer: AudioBufferLike): number {
  const window = Math.round(buffer.sampleRate * 0.1);
  const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
  const step = Math.round(window / 4);
  let best = 0;
  for (let at = 0; at + window <= (buffer.length ?? 0); at += step) {
    let sum = 0;
    for (let i = at; i < at + window; i++) sum += l[i]! * l[i]! + r[i]! * r[i]!;
    best = Math.max(best, Math.sqrt(sum / (2 * window)));
  }
  return 20 * Math.log10(Math.max(1e-9, best));
}

/**
 * Energy in 24 third-octave bands over one window, normalised.
 *
 * Filtered, not probed, and that distinction is the whole of this function's
 * history.  It used to run a Goertzel resonator at each band's centre and
 * take the magnitude, which measures the signal at ONE frequency rather than
 * across a band — and a note's partials essentially never sit on 60·2^(i/3).
 * Measured, with a pure tone and a 2.6 s window:
 *
 *     tone at 480 Hz (a centre)   the 480 probe read 2.9e+4, the rest ~1e-5
 *     tone at 500 Hz (20 Hz off)  EVERY probe read between 1e-4 and 1e-7
 *
 * Nine orders of magnitude, and then the result was divided by its own sum —
 * so twenty Hz off a centre the "spectrum" was float rounding noise scaled up
 * to look like a spectrum.  Every instrument here renders at a root that
 * misses all 24 centres, so the timbre half of the fingerprint was noise for
 * all of them, and the thresholds below were calibrated against it.
 *
 * What it does now is what the name always claimed: a fourth-order bandpass
 * (an RBJ constant-peak-gain biquad run twice) at each centre with a 1/3
 * octave bandwidth, and the RMS of what comes through.  A 480 Hz tone now
 * reads 0.62 in its own band and falls away symmetrically either side; a
 * 500 Hz tone reads 0.58 at 480 and 0.18 at 605, which is where it belongs.
 *
 * Normalised because this asks whether two patches SOUND different, and a
 * patch that is merely 3 dB louder does not.  Level is the other checks' job.
 * The Hann window is applied before filtering rather than after, so the slice
 * does not hand the filters a step edge to ring on.
 */
function bands(x: Float32Array, fromSec: number, toSec: number): number[] {
  const a = Math.round(SR * fromSec), b = Math.min(x.length, Math.round(SR * toSec));
  const len = b - a;
  // Clamped to the buffer, and loud about it when the clamp leaves nothing.
  // Reading past the end gave `undefined`, which multiplied out to NaN, which
  // ran the whole way through the filters and the distance into `d > width` —
  // where NaN compares false and a width check quietly reported 0.000 for
  // every instrument and passed.  A measure that cannot measure has to say so.
  if (len < SR * 0.05) {
    throw new Error(`asked for ${fromSec}..${toSec}s of a buffer that is `
      + `${(x.length / SR).toFixed(2)}s long`);
  }
  const win = new Float64Array(len);
  for (let k = 0; k < len; k++) {
    win[k] = x[a + k]! * 0.5 * (1 - Math.cos((2 * Math.PI * k) / (len - 1)));
  }
  const out: number[] = [];
  for (let i = 0; i < 24; i++) {
    const f = 60 * Math.pow(2, i / 3);
    if (f >= SR * 0.45) { out.push(0); continue; }
    const w0 = (2 * Math.PI * f) / SR;
    const alpha = Math.sin(w0) * Math.sinh(((Math.LN2 / 2) * (1 / 3) * w0) / Math.sin(w0));
    const a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0;
    const a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
    let sum = 0;
    let z1 = 0, z2 = 0, y1 = 0, y2 = 0, q1 = 0, q2 = 0, p1 = 0, p2 = 0;
    for (let k = 0; k < len; k++) {
      const s = win[k]!;
      const y = b0 * s + b2 * z2 - a1 * y1 - a2 * y2;
      z2 = z1; z1 = s; y2 = y1; y1 = y;
      const p = b0 * y + b2 * q2 - a1 * p1 - a2 * p2;
      q2 = q1; q1 = y; p2 = p1; p1 = p;
      sum += p * p;
    }
    out.push(Math.sqrt(sum / len));
  }
  const total = out.reduce((p, q) => p + q, 0) || 1;
  return out.map((v) => v / total);
}

/**
 * How much the sound MOVES, as a depth per modulation rate.
 *
 * The third-octave bands above and the coarse envelope beside them share a
 * blind spot, and it is not a small one: neither can see tremolo.  The bands
 * average a whole window, so an amplitude that swings between 0.5 and 1 at
 * 5 Hz reads exactly like one that sits still; the envelope has 100 ms slots,
 * which is two samples per cycle at 5 Hz and gone by 8.  Measured, before
 * this: the Rhodes' `init` and `suitcase` — the same patch with a 5.2 Hz
 * tremolo at half depth across it — came out 0.196 apart, which the suite
 * reported as the same sound under two names.  Anyone who has heard a
 * suitcase Rhodes knows that is not the finding, it is the measure.
 *
 * So: the signal's own amplitude envelope, taken at 441 Hz, its mean removed,
 * and the DFT of THAT summed into eight bands between 0.5 and 18 Hz — the
 * rates a tremolo, a vibraphone motor or a slow pad sweep actually run at.
 * Each band comes back as a depth relative to the mean envelope, so a sound
 * that does not move reads zero rather than reading noise.
 *
 * The DFT is taken bin by bin and summed, not sampled at a centre frequency.
 * That is deliberate and it is the same mistake the band analyser above was
 * making: a single probe at 5 Hz says nothing about a tremolo at 5.2.
 */
const MOD_EDGES = [0.5, 0.9, 1.5, 2.3, 3.5, 5.3, 8, 12, 18];
function modulation(x: Float32Array, fromSec: number, toSec: number): number[] {
  const a = Math.round(SR * fromSec), b = Math.min(x.length, Math.round(SR * toSec));
  const hop = 100;
  const n = Math.floor((b - a) / hop);
  const zero = MOD_EDGES.slice(1).map(() => 0);
  if (n < 32) return zero;
  const env = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = 0; k < hop; k++) { const v = x[a + j * hop + k]!; sum += v * v; }
    env[j] = Math.sqrt(sum / hop);
  }
  let mean = 0;
  for (let j = 0; j < n; j++) mean += env[j]!;
  mean /= n;
  if (mean <= 1e-7) return zero;
  const span = (n * hop) / SR;
  const out: number[] = [];
  for (let e = 0; e < MOD_EDGES.length - 1; e++) {
    let power = 0;
    const from = Math.max(1, Math.ceil(MOD_EDGES[e]! * span));
    const to = Math.min(Math.floor(n / 2), Math.floor(MOD_EDGES[e + 1]! * span));
    for (let bin = from; bin <= to; bin++) {
      let re = 0, im = 0;
      for (let j = 0; j < n; j++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (n - 1)));
        const th = (2 * Math.PI * bin * j) / n;
        re += (env[j]! - mean) * w * Math.cos(th);
        im += (env[j]! - mean) * w * Math.sin(th);
      }
      power += (re * re + im * im) / (n * n);
    }
    // ×2 for the negative frequency, ×2 again for the Hann window's loss, and
    // over the mean so the answer is a depth rather than a level.
    out.push(Math.min(1, (4 * Math.sqrt(power)) / mean));
  }
  return out;
}

/**
 * What a patch SOUNDS like, as a number per band and per slice.
 *
 * Timbre in TWO windows, not one.  A single window starting after the attack
 * misses most of what a struck instrument is: the Rhodes' FM index has its
 * own fast decay and is down to a few percent within 400 ms, so two patches
 * with completely different attacks measured 0.25 apart while sounding
 * nothing alike.  The attack gets a window of its own.
 *
 * Plus the ENVELOPE, normalised to its own peak, because a stab and a pad can
 * hold the same spectrum and still be two patches.
 */
function fingerprint(x: Float32Array): { spectrum: number[]; envelope: number[]; moves: number[] } {
  const spectrum = [...bands(x, 0, 0.35), ...bands(x, 0.35, 3)];
  const span = Math.min(x.length, Math.round(SR * 1.6)), n = 16, step = Math.floor(span / n);
  const envelope: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = i * step; k < (i + 1) * step; k++) sum += x[k]! * x[k]!;
    envelope.push(Math.sqrt(sum / step));
  }
  const peak = Math.max(...envelope) || 1;
  return { spectrum, envelope: envelope.map((v) => v / peak), moves: modulation(x, 0.35, 3) };
}

function distance(a: ReturnType<typeof fingerprint>, b: ReturnType<typeof fingerprint>): number {
  let d = 0;
  for (let i = 0; i < a.spectrum.length; i++) d += Math.abs(a.spectrum[i]! - b.spectrum[i]!);
  for (let i = 0; i < a.envelope.length; i++) {
    d += Math.abs(a.envelope[i]! - b.envelope[i]!) / a.envelope.length;
  }
  // Unweighted, because the depths are already fractions of the sound's own
  // level: a half-depth tremolo against none contributes about 0.4, which is
  // the same order as the envelope term and well under what the spectrum can
  // contribute.  Loud enough to be heard by the checks, not loud enough to
  // let a patch differ by nothing else.
  for (let i = 0; i < a.moves.length; i++) d += Math.abs(a.moves[i]! - b.moves[i]!);
  return d;
}

/**
 * How far apart two patches have to sound.
 *
 * Measured, and measured again from scratch twice over: once after the band
 * analyser above was fixed, and once more after the modulation term was added
 * to the fingerprint, because both changed what a distance IS.  The 0.30 that
 * stood here before was calibrated against the noise the old analyser
 * returned and is not evidence for anything.
 *
 * The scale is ONE KNOB, moved a quarter of its travel from each instrument's
 * init patch — 437 of them, every parameter of all fourteen instruments.
 * That distribution is what a near-copy looks like: two patches closer than a
 * single knob's quarter turn are not two patches.
 *
 *     median 0.065    p75 0.369    p90 0.866    p95 1.226
 *
 * 0.40 is just above the 75th percentile: a quarter turn of one knob beats it
 * one time in four.  Across all 1002 pairs in the bank the closest is
 * 0.426 (the bowed init against its solo violin), so the floor sits just
 * under the tightest pair that is genuinely two patches — which is where a
 * floor earns its place rather than waving everything through.
 */
const MIN_DISTINCTNESS = 0.40;

/**
 * A short stimulus, used only to ask how wide an ENGINE is.
 *
 * The width check below renders every parameter of every instrument at both
 * of its extremes — 900-odd renders — and the reference phrase at 281 ms a
 * render would put four minutes on the suite for one check.  Two notes at
 * 32 ms do the job, because that check compares the engine's corners with the
 * bank's patches and both sides are measured on this same stimulus.  Nothing
 * else in this file uses it: the distinctness check and the level checks stay
 * on the reference phrase, where the numbers mean what they mean elsewhere.
 */
const REACH_SECONDS = 2.2;
function reachPhrase(root: number): LevelEvent[] {
  return [
    { pitch: root, at: 0, dur: 0.85, vel: 0.68 },
    { pitch: root + 7, at: 0.92, dur: 0.35, vel: 0.74 },
  ];
}

/**
 * The same, for a drum machine: one hit of each voice, close together.
 *
 * The GM numbers are the ones `referenceBeat` uses.  All six are here on
 * purpose — a drum patch edits its voices one at a time, and a stimulus that
 * left the cymbal out would report an engine with no cymbal in it.
 */
function reachBeat(): LevelEvent[] {
  return [
    { pitch: 36, at: 0, dur: 0.3, vel: 0.95 },
    { pitch: 38, at: 0.22, dur: 0.3, vel: 0.85 },
    { pitch: 42, at: 0.44, dur: 0.3, vel: 0.55 },
    { pitch: 46, at: 0.62, dur: 0.3, vel: 0.6 },
    { pitch: 49, at: 0.84, dur: 0.3, vel: 0.8 },
    { pitch: 51, at: 1.06, dur: 0.3, vel: 0.5 },
  ];
}

async function main(): Promise<void> {
  await check('the thing that measures timbre can find a tone', () => {
    // A test for the test, and it exists because its absence cost this suite
    // its point.  The old band measure answered with noise for any tone that
    // was not sitting on a band centre, which is nearly every tone, and no
    // check noticed because every check only compared one noisy answer with
    // another.  So before any patch is measured, the measure is:
    //
    //   · a tone lands in its OWN band and nowhere else
    //   · one 20 Hz off a centre lands in the same place, not somewhere random
    //   · two different tones do not read alike
    const tone = (hz: number): Float32Array => {
      const n = Math.round(SR * 2.6);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / SR);
      return x;
    };
    const centre = (i: number): number => 60 * Math.pow(2, i / 3);
    const nearest = (hz: number): number => Math.round((3 * Math.log2(hz / 60)));
    for (const hz of [120, 480, 500, 1000, 3000]) {
      const b = bands(tone(hz), 0, 2.6);
      let top = 0;
      for (let i = 1; i < b.length; i++) if (b[i]! > b[top]!) top = i;
      assert(top === nearest(hz),
        `a ${hz} Hz tone reads loudest in the ${centre(top).toFixed(0)} Hz band, `
        + `but it belongs in ${centre(nearest(hz)).toFixed(0)} Hz`);
      assert(b[top]! > 0.4,
        `a ${hz} Hz tone puts only ${(b[top]! * 100).toFixed(0)}% of its energy in its own `
        + 'band — the bands are not bands');
    }
    // And it says so when it cannot measure, rather than answering NaN.  This
    // is not hypothetical: the width check below ran on a 1.6 s stimulus and
    // asked for the 0.35–3 s window, got NaN all the way through, and passed
    // reporting every bank as 0.000 wide.
    let threw = false;
    try { bands(tone(500).subarray(0, 1000), 0, 3); } catch { threw = true; }
    assert(threw, 'a window past the end of the buffer answered instead of failing');

    const low = bands(tone(120), 0, 2.6), high = bands(tone(3000), 0, 2.6);
    let apart = 0;
    for (let i = 0; i < low.length; i++) apart += Math.abs(low[i]! - high[i]!);
    assert(apart > 1.5,
      `120 Hz and 3 kHz measure only ${apart.toFixed(2)} apart — the measure cannot tell `
      + 'two ends of the spectrum apart, so it cannot tell two patches apart');
  });

  await check('and it can hear a sound moving', () => {
    // The other half of the measure, checked the same way and for the same
    // reason: nothing was watching it, and it was blind.
    const trem = (hz: number, depth: number): Float32Array => {
      const n = Math.round(SR * 3);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const m = hz > 0 ? 1 - depth * 0.5 * (1 - Math.cos(2 * Math.PI * hz * t)) : 1;
        x[i] = Math.sin(2 * Math.PI * 440 * t) * m;
      }
      return x;
    };
    const still = modulation(trem(0, 0), 0.35, 3);
    assert(Math.max(...still) < 0.02,
      `a tone that does not move reads ${Math.max(...still).toFixed(3)} of modulation`);
    for (const [hz, depth] of [[2.2, 0.95], [5.2, 0.5], [6.5, 0.6]] as const) {
      const m = modulation(trem(hz, depth), 0.35, 3);
      let top = 0;
      for (let i = 1; i < m.length; i++) if (m[i]! > m[top]!) top = i;
      assert(hz >= MOD_EDGES[top]! && hz < MOD_EDGES[top + 1]!,
        `a ${hz} Hz tremolo reads loudest in the ${MOD_EDGES[top]}–${MOD_EDGES[top + 1]} Hz band`);
      assert(m[top]! > depth * 0.6,
        `a ${hz} Hz tremolo at depth ${depth} reads only ${m[top]!.toFixed(2)} deep`);
    }
    // And the pair that started this: a tremolo has to move the fingerprint.
    const a = fingerprint(trem(0, 0)), b = fingerprint(trem(5.2, 0.5));
    assert(distance(a, b) > MIN_DISTINCTNESS,
      `a tone and the same tone under a half-depth tremolo measure `
      + `${distance(a, b).toFixed(3)} apart — the measure still cannot hear it`);
  });

  await check('every instrument has a bank, or says why it does not', () => {
    for (const inst of INSTRUMENTS) {
      const has = patchesFor(inst.id).length > 0;
      const excused = NO_PATCHES[inst.id];
      assert(has || excused !== undefined,
        `${inst.id} has ${inst.params.length} parameters and no patches — add a bank or say `
        + 'why it does not have one');
      assert(!(has && excused !== undefined),
        `${inst.id} is both banked and excused — one of the two is wrong`);
      if (excused !== undefined) {
        assert(excused.length >= 20, `${inst.id} is excused without a reason worth reading`);
      }
    }
    for (const id of Object.keys(NO_PATCHES)) {
      assert(findInstrument(id) !== undefined, `${id} is excused but is not an instrument`);
    }
  });

  await check('every patch names parameters its instrument actually has', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id);
      assert(inst !== undefined, `patches exist for ${id}, which is not an instrument`);
      const known = new Set(inst!.params.map((p) => p.id));
      for (const patch of patchesFor(id)) {
        for (const key of Object.keys(patch.params)) {
          assert(known.has(key), `${id}/${patch.id} sets ${key}, which ${id} does not have`);
        }
      }
    }
  });

  await check('every value is inside its own parameter range', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id)!;
      for (const patch of patchesFor(id)) {
        for (const [key, value] of Object.entries(patch.params)) {
          const def = inst.params.find((p) => p.id === key)!;
          assert(Number.isFinite(value), `${id}/${patch.id}.${key} is ${String(value)}`);
          assert(value >= def.min && value <= def.max,
            `${id}/${patch.id}.${key} is ${value}, outside [${def.min}, ${def.max}]`);
        }
      }
    }
  });

  await check('a patch may trim Level down, never up', () => {
    // Calibration puts every instrument on target at 0.7 with headroom above
    // it.  A patch pushing past that spends the headroom; a patch pulling
    // below it is how a brighter or denser sound stays inside it.
    for (const id of INSTRUMENT_IDS) {
      for (const patch of patchesFor(id)) {
        const level = patch.params['level'];
        if (level === undefined) continue;
        assert(level < CALIBRATED_LEVEL,
          `${id}/${patch.id} sets level to ${level}, at or above the calibrated ${CALIBRATED_LEVEL}`);
        assert(level > 0.1, `${id}/${patch.id} trims level to ${level}, which is inaudible`);
      }
    }
  });

  await check('no two patches of an instrument are the same patch', () => {
    for (const id of INSTRUMENT_IDS) {
      const list = patchesFor(id);
      const seenIds = new Set<string>();
      for (const patch of list) {
        assert(!seenIds.has(patch.id), `${id} has two patches called ${patch.id}`);
        seenIds.add(patch.id);
      }
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const pa = patchParams(id, list[a]!.id), pb = patchParams(id, list[b]!.id);
          const same = Object.keys(pa).every((k) => pa[k] === pb[k]);
          assert(!same, `${id}: ${list[a]!.id} and ${list[b]!.id} are the same numbers`);
        }
      }
    }
  });

  await check('and no two are a rounding apart', () => {
    // The near-paste: a patch edited by nudging one number is not a second
    // patch, and it is the form the menu can look full while being empty.
    // Distance is measured in each parameter's OWN range, so a 40 ct detune
    // and a 12000 Hz cutoff count the same.
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id)!;
      const list = patchesFor(id);
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const pa = patchParams(id, list[a]!.id), pb = patchParams(id, list[b]!.id);
          let distance = 0, moved = 0;
          for (const def of inst.params) {
            const span = def.max - def.min;
            if (span <= 0) continue;
            const d = Math.abs((pa[def.id] ?? 0) - (pb[def.id] ?? 0)) / span;
            distance += d;
            if (d > 0.02) moved += 1;
          }
          assert(distance > 0.25 && moved >= 2,
            `${id}: ${list[a]!.id} and ${list[b]!.id} differ by ${distance.toFixed(3)} `
            + `across ${moved} parameter(s) — that is an edit, not a patch`);
        }
      }
    }
  });

  await check('every patch says what it is, in a line', () => {
    for (const id of INSTRUMENT_IDS) {
      for (const patch of patchesFor(id)) {
        assert(patch.name.trim().length > 0, `${id}/${patch.id} has no name`);
        assert(patch.note.trim().length >= 8, `${id}/${patch.id} has no usable note`);
        assert(PATCH_CATEGORIES.includes(patch.category),
          `${id}/${patch.id} is in category ${patch.category}`);
        assert(CATEGORY_LABEL[patch.category].length > 0,
          `${patch.category} has no Korean label`);
      }
    }
  });

  await check('every instrument opens on a patch, not on "편집됨"', () => {
    // A track that has never been touched carries no parameters at all, and
    // the picker reads the defaults.  If no patch matched them the menu would
    // open blank on a brand new track.
    for (const id of INSTRUMENT_IDS) {
      const found = activePatch(id, {});
      assert(found !== null, `${id} at its defaults matches no patch`);
      assert(found!.category === 'init', `${id} opens on ${found!.id}, which is not an init patch`);
    }
  });

  await check('a loaded patch reads back as itself, and an edit does not', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id)!;
      for (const patch of patchesFor(id)) {
        const loaded = patchParams(id, patch.id);
        const back = activePatch(id, loaded);
        assert(back?.id === patch.id,
          `${id}/${patch.id} reads back as ${back?.id ?? '편집됨'}`);
        // Move one parameter a long way and it must stop claiming the patch.
        const target = inst.params.find((p) => p.id !== 'level' && p.max > p.min)!;
        const nudged = { ...loaded, [target.id]: loaded[target.id] === target.max ? target.min : target.max };
        assert(activePatch(id, nudged)?.id !== patch.id
          || target.max === target.min,
          `${id}/${patch.id} still reads as itself after ${target.id} was moved to an end`);
      }
    }
  });

  await check('every override actually overrides something', () => {
    // A patch stores only what DIFFERS, so that the day a parameter is added
    // every existing patch picks up its default rather than a value frozen in
    // before that parameter existed.
    //
    // The rule is per-value, not per-count.  An earlier version of this also
    // required a patch to name fewer parameters than the instrument has,
    // which sounds like the same thing and is not: the acoustic guitar has
    // six, and a patch that genuinely moves all six is a patch, not a dump.
    // What makes a dump a dump is entries that say nothing.
    for (const id of INSTRUMENT_IDS) {
      const defaults = defaultInstrumentParams(id);
      for (const patch of patchesFor(id)) {
        for (const [key, value] of Object.entries(patch.params)) {
          assert(defaults[key] !== value,
            `${id}/${patch.id} sets ${key} to its default (${value}) — that is not an override`);
        }
      }
    }
  });

  await check('categories are reported in order, and only the ones used', () => {
    for (const id of INSTRUMENT_IDS) {
      const used = categoriesFor(id);
      const fromPatches = new Set(patchesFor(id).map((p) => p.category));
      assert(used.length === fromPatches.size, `${id} reports ${used.length} categories, uses ${fromPatches.size}`);
      const order = used.map((c) => PATCH_CATEGORIES.indexOf(c));
      assert(order.every((v, i) => i === 0 || v > order[i - 1]!), `${id} reports categories out of order`);
    }
  });

  await check('the picker cannot be asked for a patch that is not there', () => {
    assert(findPatch('polysynth', 'nope') === undefined, 'an unknown patch resolved');
    assert(patchesFor('drumkit').length === 0, 'the kit has patches as well as kits');
    assert(patchesFor('nope').length === 0, 'an unknown instrument has patches');
    // An unknown patch falls back to the defaults rather than to nothing —
    // a session naming a patch this build dropped still makes a sound.
    const fallback = patchParams('polysynth', 'nope');
    assert(fallback['cutoffHz'] === defaultInstrumentParams('polysynth')['cutoffHz'],
      'an unknown patch did not fall back to the defaults');
  });

  // ── The rendered checks ───────────────────────────────────────────────────

  const loud: Array<{ id: string; patch: string; lufs: number; hard: number }> = [];
  const prints = new Map<string, ReturnType<typeof fingerprint>>();
  for (const id of INSTRUMENT_IDS) {
    const root = REFERENCE_ROOT[id] ?? 48;
    for (const patch of patchesFor(id)) {
      const params = patchParams(id, patch.id);
      // A drum machine is not a chordal instrument, and a maj7 rooted at C3
      // is not a stimulus it has an answer to: the pitches in the reference
      // phrase reach whichever pads happen to be mapped there, and none of
      // the pads a drum patch actually EDITS.  Measured, before this: the
      // machine's `init` and `trap` patches fingerprinted 0.000 apart — the
      // same rendered audio, because neither patch had been asked to make a
      // sound it differs in.  The level suite settled the same question the
      // same way, and this is the stimulus it settled on: a BEAT.
      const drums = DRUM_INSTRUMENTS.has(id);
      const phrase = drums
        ? await render(id, params, referenceBeat(), REFERENCE_BEAT_SECONDS)
        : await render(id, params, referencePhrase(root), REFERENCE_PHRASE_SECONDS);
      const hard = getLoudnessMetrics(drums
        ? await render(id, params, referenceBeat(1.35), REFERENCE_BEAT_SECONDS)
        : await render(id, params, hardChord(root), 3));
      loud.push({ id, patch: patch.id, lufs: hitLevelDb(phrase), hard: hard.truePeakDbtp });

      const l = phrase.getChannelData(0), r = phrase.getChannelData(1);
      const mono = new Float32Array(phrase.length ?? 0);
      for (let i = 0; i < mono.length; i++) mono[i] = (l[i]! + r[i]!) / 2;
      prints.set(`${id}/${patch.id}`, fingerprint(mono));
    }
  }

  await check('every patch makes a sound', () => {
    for (const row of loud) {
      assert(Number.isFinite(row.lufs) && row.lufs > -50,
        `${row.id}/${row.patch} rendered at ${row.lufs.toFixed(1)} dB — it is silent`);
    }
  });

  await check('the bank is centred on the level the instrument was calibrated at', () => {
    // Measured and then written down rather than assumed: the bank spans
    // 15.4 dB, and almost all of that is ENVELOPE.  A chord stab with no
    // sustain is 8 dB below the init patch because it is 160 ms long, and an
    // organ that holds is 8 dB above it for the same reason.  Both are
    // correct, and a check that forced every patch onto one number would be
    // deleting the difference between a stab and an organ.
    //
    // What can be asserted is where the bank SITS.  The instrument is
    // calibrated at its defaults (instrument-level.ts), the init patch IS
    // those defaults, so a median that has walked away from it means the
    // bank as a whole has drifted off the calibration — which is the failure
    // this is for, and the one no individual patch would show.
    for (const id of INSTRUMENT_IDS) {
      const rows = loud.filter((r) => r.id === id);
      const init = rows.find((r) => r.patch === 'init');
      assert(init !== undefined, `${id} has no init patch to measure against`);
      const sorted = rows.map((r) => r.lufs).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      assert(Math.abs(median - init!.lufs) <= 3,
        `${id}: the median patch is ${(median - init!.lufs).toFixed(1)} dB from its init patch`);
    }
  });

  await check('no patch is loud by accident either', () => {
    // The asymmetric one, and the asymmetry is the point.  A patch being
    // quiet costs the user a fader move; a patch being much LOUDER than the
    // instrument was calibrated at spends the headroom the calibration
    // exists to guarantee, and it does it without clipping — density, not
    // peak, so the ceiling check never sees it.
    //
    // Measured against the init patch because that IS the calibrated sound.
    // Written after an FM bass came out 10.2 dB above it — a 1:1 ratio with
    // the pickup driven hard is simply dense — which nothing in the suite
    // noticed, because the bank's total spread was still inside every bound
    // there was.
    //
    // 9 dB, and the first attempt at 7 is why it is written down: that
    // flagged the poly synth's organ at +7.7, which is not an accident but
    // an ENVELOPE — a patch that holds at full level against an init patch
    // that decays, the same difference this suite already refuses to flatten
    // elsewhere.  So the bound sits between the loudest legitimate patch
    // (7.7) and the accident (10.2), with room on both sides.
    for (const id of INSTRUMENT_IDS) {
      const rows = loud.filter((r) => r.id === id);
      const init = rows.find((r) => r.patch === 'init')!;
      for (const row of rows) {
        assert(row.lufs - init.lufs <= 9,
          `${id}/${row.patch} is ${(row.lufs - init.lufs).toFixed(1)} dB above its init patch`);
      }
    }
  });

  await check('no patch is quiet by accident', () => {
    // The loose one, and deliberately loose: it exists to catch a patch that
    // is 30 dB down because a decay was typed with an extra zero, not to
    // have an opinion about how short a stab may be.
    for (const id of INSTRUMENT_IDS) {
      const rows = loud.filter((r) => r.id === id);
      const hi = rows.reduce((a, b) => (a.lufs > b.lufs ? a : b));
      for (const row of rows) {
        assert(hi.lufs - row.lufs <= 18,
          `${id}/${row.patch} is ${(hi.lufs - row.lufs).toFixed(1)} dB below ${hi.patch}`);
      }
    }
  });

  await check('no two patches of an instrument SOUND the same', () => {
    // The parameter-distance checks above catch a patch pasted from its
    // neighbour.  They cannot catch the other half of the problem: two
    // patches whose numbers differ everywhere and whose sound differs
    // nowhere, which is what a bank looks like when the engine has run out of
    // axes to differ ON.
    //
    // What this does NOT catch is stated below, in the check that does: a
    // floor on the closest pair says nothing about whether the bank is wide.
    // This one is for the near-copy — two patches nudged apart by a value or
    // two, which measured 0.223 when it was real (a clav and a marimba
    // separated by little more than their tine level).
    // Every offender, not the first one: a bank is authored instrument by
    // instrument, and a check that names one pair per run turns a morning's
    // work into a week of rediscovering the same thing.
    const same: string[] = [];
    for (const id of INSTRUMENT_IDS) {
      const list = patchesFor(id);
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const d = distance(prints.get(`${id}/${list[a]!.id}`)!, prints.get(`${id}/${list[b]!.id}`)!);
          if (d < MIN_DISTINCTNESS) {
            same.push(`${id}: ${list[a]!.id} and ${list[b]!.id} are ${d.toFixed(3)} apart`);
          }
        }
      }
    }
    assert(same.length === 0,
      `${same.length} pair(s) are the same sound under two names — ${same.join('; ')}`);
  });

  // ── How wide the engine is, so the bank can be asked to use it ───────────
  //
  // Both sides of the width question, measured on the short stimulus: every
  // parameter of every instrument at both of its extremes (the engine's
  // corners), and every patch in the bank.
  const reachWidth = new Map<string, { width: number; pair: string }>();
  const bankWidth = new Map<string, { width: number; pair: string }>();
  for (const id of INSTRUMENT_IDS) {
    const inst = findInstrument(id)!;
    const drums = DRUM_INSTRUMENTS.has(id);
    const root = REFERENCE_ROOT[id] ?? 48;
    const events = drums ? reachBeat() : reachPhrase(root);
    const shot = async (params: Record<string, number>) => {
      const buf = await render(id, params, events, REACH_SECONDS);
      const l = buf.getChannelData(0), r = buf.getChannelData(1);
      const mono = new Float32Array(buf.length ?? 0);
      for (let i = 0; i < mono.length; i++) mono[i] = (l[i]! + r[i]!) / 2;
      // A corner that makes no sound is not a corner of the engine, it is the
      // off switch — and its fingerprint is a normalised nothing, which sits
      // further from every real sound than any two real sounds sit from each
      // other.  `cutoff=min` on the wavetable synth is exactly that.  The
      // floor is the same one the patches are held to.
      return { print: fingerprint(mono), audible: hitLevelDb(buf) > -50 };
    };
    const base = patchParams(id, 'init');
    const init = await shot(base);
    const corners: Array<[string, ReturnType<typeof fingerprint>]> = [['init', init.print]];
    for (const def of inst.params) {
      // `level` is excluded on purpose: it is the one parameter a patch may
      // not use to differ, and the fingerprint is level-normalised anyway, so
      // sweeping it would add two renders and no information.
      if (def.id === 'level') continue;
      for (const [tag, at] of [['min', def.min], ['max', def.max]] as const) {
        const one = await shot({ ...base, [def.id]: at });
        if (one.audible) corners.push([`${def.id}=${tag}`, one.print]);
      }
    }
    const bank: Array<[string, ReturnType<typeof fingerprint>]> = [];
    for (const patch of patchesFor(id)) {
      bank.push([patch.id, (await shot(patchParams(id, patch.id))).print]);
    }
    const widest = (rows: typeof corners): { width: number; pair: string } => {
      let width = 0, pair = '';
      for (let a = 0; a < rows.length; a++) {
        for (let b = a + 1; b < rows.length; b++) {
          const d = distance(rows[a]![1], rows[b]![1]);
          if (d > width) { width = d; pair = `${rows[a]![0]} ↔ ${rows[b]![0]}`; }
        }
      }
      return { width, pair };
    };
    reachWidth.set(id, widest(corners));
    bankWidth.set(id, widest(bank));
  }

  await check('the bank uses the width the engine has', () => {
    // The other half of the question, and the half a floor on the closest
    // pair cannot answer: a bank can have no two patches alike and still be
    // one sound with the knobs nudged.  That is a property of the FURTHEST
    // pair.
    //
    // It used to be one number for all fourteen instruments, and that was
    // never defensible — a six-operator FM synth and an upright piano do not
    // have the same amount of timbre in them, and measured they are not
    // close: the FM bank spans 9.18 and the upright's 2.94, with more patches
    // in the FM.  A single floor either lets the FM off or asks the upright
    // for a sound it cannot make.
    //
    // So the floor is the instrument's OWN reach: move one knob to one end,
    // and how far does that get?  If a single knob beats every pair of
    // patches in the bank, the bank is not using the engine — which is
    // exactly the condition this check was written for, and now it is asked
    // per instrument and never needs a number chosen for it again.
    //
    // 0.8 rather than 1.0 because a corner is allowed to be a sound nobody
    // would ship — a filter shut to its stop is a click and then nothing —
    // and it is fair for a bank of musical patches to stop short of the most
    // extreme thing the engine can be made to do.  It is not a way of
    // passing: the fourteen banks land between 0.87× and 1.94×, five of them
    // under 1.0, so the margin is being used and is not slack.  The analog
    // synth sat at 0.78× when this was written — its pad released in 1.8 s on
    // an envelope that goes to eight — and it is at 1.00× now because the pad
    // was lengthened, not because the number was.
    const narrow: string[] = [];
    for (const id of INSTRUMENT_IDS) {
      const bank = bankWidth.get(id)!, reach = reachWidth.get(id)!;
      if (bank.width < reach.width * 0.8) {
        narrow.push(`${id}: bank ${bank.width.toFixed(2)} (${bank.pair}) vs one knob `
          + `${reach.width.toFixed(2)} (${reach.pair})`);
      }
    }
    assert(narrow.length === 0,
      `${narrow.length} bank(s) are not using their engine — ${narrow.join('; ')}`);
  });

  await check('no patch clips played as hard as MIDI goes', () => {
    for (const row of loud) {
      assert(row.hard <= LEVEL_PEAK_CEILING_DBTP + 0.01,
        `${row.id}/${row.patch} peaks at ${row.hard.toFixed(2)} dBTP`);
    }
  });

  console.log('\n=== Factory patches ===');
  for (const id of INSTRUMENT_IDS) {
    const rows = loud.filter((r) => r.id === id);
    const values = rows.map((r) => r.lufs);
    console.log(`  ${id.padEnd(10)} ${String(rows.length).padStart(2)} patches  `
      + `${Math.min(...values).toFixed(1)} … ${Math.max(...values).toFixed(1)} LUFS  `
      + `worst peak ${Math.max(...rows.map((r) => r.hard)).toFixed(1)} dBTP  `
      + `width ${bankWidth.get(id)!.width.toFixed(2)}/${reachWidth.get(id)!.width.toFixed(2)} `
      + `(${(bankWidth.get(id)!.width / reachWidth.get(id)!.width).toFixed(2)}×)  `
      + `[${categoriesFor(id).map((c) => CATEGORY_LABEL[c]).join(' ')}]`);
  }
  console.log(`  ${'합계'.padEnd(10)} ${loud.length} patches across ${INSTRUMENT_IDS.length} instruments`);

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
