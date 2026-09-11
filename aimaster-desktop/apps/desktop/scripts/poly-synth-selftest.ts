/**
 * poly-synth-selftest.ts — whether the synth's knobs are connected to anything.
 *
 * The synth used to be two detuned saws through a fixed lowpass.  Everything
 * below the original eight parameters was added so that PATCHES could differ
 * by something, and a parameter added for that reason has a specific failure
 * mode: it appears in the rack, it saves, it automates, it reads as a feature,
 * and it does nothing to the sound.  Nothing else in the app would notice.
 *
 * So every check here RENDERS and MEASURES.  None of them assert that a value
 * was stored; they assert that moving it changed the audio in the direction
 * its name claims.
 *
 * Two are about specific mistakes rather than about features:
 *
 *   · the filter envelope is written to the filter's `detune`, because its
 *     `frequency` already carries the MPE timbre curve.  Two writers on one
 *     AudioParam is one of them losing — so the envelope is checked WITH an
 *     expression curve present, which is the case that would have broken.
 *
 *   · unison voices are given a starting phase, which Web Audio does not
 *     otherwise offer.  Without it every voice begins at phase zero and the
 *     stack sums coherently at the onset: the peak grows with the voice
 *     count, which clicks and clips.  That is measured directly.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:poly-synth
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { createNote, DEFAULT_MIDI_CONFIG, type MidiNote } from '../src/renderer/daw/model/midi.js';

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
const C3 = 48, C5 = 72;

/** One held note, mono, with the params merged over the defaults. */
async function play(
  over: Record<string, number>, seconds = 2, pitch = C3,
  shape: (note: MidiNote) => MidiNote = (n) => n,
): Promise<Float32Array> {
  const inst = findInstrument('polysynth')!;
  const params = { ...defaultInstrumentParams('polysynth'), ...over };
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  inst.playNote({
    ctx: ctx as unknown as BaseAudioContext,
    destination: ctx.destination as unknown as AudioNode,
    note: shape(createNote({ pitch, velocity: 0.8, startBeat: 0, durationBeat: 4 })),
    config: DEFAULT_MIDI_CONFIG, when: 0, durationSec: seconds * 0.8, params,
  });
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  const out = new Float32Array(l.length);
  for (let i = 0; i < out.length; i++) out[i] = (l[i]! + r[i]!) / 2;
  return out;
}

// ── Measurement ─────────────────────────────────────────────────────────────

/**
 * Amplitude at one frequency, by Goertzel over a Hann window.
 *
 * The window is not decoration.  Without it a rectangular Goertzel leaks
 * about −13 dB into its neighbours, and every measurement here that looks
 * BETWEEN harmonics — the noise floor, most of all — reads its loud
 * neighbours instead of what it was pointed at.  That is how the first
 * version of the noise check failed on working code.
 */
function tone(x: Float32Array, freq: number, from = 0, to = x.length): number {
  const n = to - from;
  if (n <= 1) return 0;
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * (i - from)) / (n - 1)));
    const s = x[i]! * win + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  // Hann halves the coherent gain, so the 2/n of a rectangular window is 4/n.
  return (4 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

function peak(x: Float32Array, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

/** The first `count` harmonics of `f0`, as amplitudes. */
function harmonics(x: Float32Array, f0: number, count: number, from = 0, to = x.length): number[] {
  const out: number[] = [];
  for (let n = 1; n <= count; n++) {
    out.push(n * f0 < SR / 2 ? tone(x, n * f0, from, to) : 0);
  }
  return out;
}

/**
 * Where the energy sits, in Hz — measured ON THE HARMONICS.
 *
 * A centroid rather than a cutoff, because the filter's corner is not
 * observable from outside while "brighter" and "duller" are, and that is what
 * these checks actually claim.
 *
 * Over the harmonics and not over a log-spaced grid, which is what this was
 * first written as: an oscillator's spectrum is a line spectrum, a log grid
 * lands between the lines far more often than on them, and the result is
 * dominated by whichever grid points happen to sit near a strong low
 * harmonic.  It read a four-octave filter sweep as a 1.6× change.
 *
 * ONE VOICE ONLY.  A detuned unison has no energy at the nominal harmonics at
 * all — the voices sit either side of them — so pointing this at a stack
 * reads the analysis window's sidelobes and reports a spectrum that falls off
 * a cliff.  Every caller below that measures brightness therefore renders
 * with `voices: 1`, which is also the honest way to test a FILTER: with
 * nothing else in the signal path to explain the result.
 */
function brightness(x: Float32Array, f0: number, from = 0, to = x.length): number {
  let num = 0, den = 0;
  for (let n = 1; n * f0 < SR / 2 && n <= 64; n++) {
    const a = tone(x, n * f0, from, to);
    num += n * f0 * a; den += a;
  }
  return den > 0 ? num / den : 0;
}

const freqOf = (pitch: number): number => 440 * Math.pow(2, (pitch - 69) / 12);

async function main(): Promise<void> {
  const f3 = freqOf(C3);

  // ── The oscillator ────────────────────────────────────────────────────────

  await check('the five wave shapes are five different spectra', async () => {
    const profiles: number[][] = [];
    for (let w = 0; w < 5; w++) {
      // Filter wide open, so what is compared is the oscillator and not the
      // filter's opinion of it.
      const x = await play({ wave: w, cutoffHz: 12000, voices: 1, attack: 0.001, sustain: 1 });
      const h = harmonics(x, f3, 8, SR / 4, SR / 2);
      const total = h.reduce((a, b) => a + b, 0);
      assert(total > 0, `wave ${w} is silent`);
      profiles.push(h.map((v) => v / total));
    }
    for (let a = 0; a < profiles.length; a++) {
      for (let b = a + 1; b < profiles.length; b++) {
        let diff = 0;
        for (let i = 0; i < 8; i++) diff += Math.abs(profiles[a]![i]! - profiles[b]![i]!);
        assert(diff > 0.15, `wave ${a} and wave ${b} differ by only ${diff.toFixed(3)}`);
      }
    }
  });

  await check('a pulse at half width is a square, and narrowing it is not', async () => {
    // The claim in the code: duty 0.5 silences every even harmonic.  If the
    // coefficients were wrong this is the check that says so.
    const half = await play({ wave: 2, pulseWidth: 0.5, cutoffHz: 12000, voices: 1, sustain: 1 });
    const thin = await play({ wave: 2, pulseWidth: 0.12, cutoffHz: 12000, voices: 1, sustain: 1 });
    const evenOf = (x: Float32Array): number => {
      const h = harmonics(x, f3, 8, SR / 4, SR / 2);
      const even = h[1]! + h[3]! + h[5]! + h[7]!;
      const odd = h[0]! + h[2]! + h[4]! + h[6]!;
      return even / Math.max(1e-9, odd);
    };
    assert(evenOf(half) < 0.05, `a half-width pulse keeps ${(evenOf(half) * 100).toFixed(1)}% even harmonics`);
    assert(evenOf(thin) > 0.3, `narrowing the pulse only brought back ${(evenOf(thin) * 100).toFixed(1)}%`);
  });

  await check('unison widens without getting louder', async () => {
    const one = await play({ voices: 1, sustain: 1 });
    const seven = await play({ voices: 7, sustain: 1 });
    const delta = db(rms(seven, SR / 4, SR)) - db(rms(one, SR / 4, SR));
    assert(Math.abs(delta) < 1.5,
      `seven voices are ${delta.toFixed(2)} dB louder than one — Unison is a volume knob`);
  });

  await check('unison voices do not start in step', async () => {
    // The mistake this is here for: every Web Audio oscillator starts at
    // phase zero, so voices built without a phase offset sum coherently for
    // the first milliseconds.  The onset peak would then grow with the voice
    // count — a click, and a patch that clips for reasons no meter explains.
    const onset = async (voices: number): Promise<number> => {
      const x = await play({ voices, attack: 0.001, sustain: 1, detune: 12 });
      return peak(x, 0, Math.round(SR * 0.005));
    };
    const one = await onset(1), seven = await onset(7);
    const growth = db(seven) - db(one);
    // Coherent would be +16.9 dB (7×), and the 1/√7 mix gain takes 8.5 back,
    // leaving +8.5.  Incoherent leaves it near 0.
    assert(growth < 4,
      `seven voices peak ${growth.toFixed(1)} dB above one at the onset — they are starting in step`);
  });

  await check('the sub oscillator is an octave below', async () => {
    const off = await play({ sub: 0, sustain: 1, cutoffHz: 6000 });
    const on = await play({ sub: 1, sustain: 1, cutoffHz: 6000 });
    const below = (x: Float32Array): number => db(tone(x, f3 / 2, SR / 4, SR / 2));
    assert(below(on) - below(off) > 18,
      `the sub added ${(below(on) - below(off)).toFixed(1)} dB an octave down`);
  });

  await check('noise fills in where the oscillator has nothing', async () => {
    // Against a SINE, so the oscillator contributes at exactly one frequency
    // and everything else in the spectrum is the thing being measured.  A
    // check that simply made the patch louder would raise the fundamental
    // too, so the fundamental is asserted NOT to move.
    const away = f3 * 2.5;
    const opts = { wave: 4, voices: 1, sustain: 1, cutoffHz: 8000, attack: 0.001 };
    const off = await play({ ...opts, noise: 0 });
    const on = await play({ ...opts, noise: 1 });
    const floor = db(tone(on, away, SR / 4, SR / 2)) - db(tone(off, away, SR / 4, SR / 2));
    assert(floor > 12, `Noise only raised the floor by ${floor.toFixed(1)} dB`);
    const fundamental = db(tone(on, f3, SR / 4, SR / 2)) - db(tone(off, f3, SR / 4, SR / 2));
    assert(Math.abs(fundamental) < 2,
      `Noise moved the fundamental by ${fundamental.toFixed(1)} dB — it is a level control`);
  });

  // ── The filter ────────────────────────────────────────────────────────────

  await check('the filter envelope opens the filter and closes it again', async () => {
    const flat = await play({ fegAmount: 0, cutoffHz: 600, sustain: 1, attack: 0.001, voices: 1 });
    const swept = await play({ fegAmount: 4, fegAttack: 0.005, fegDecay: 0.5, cutoffHz: 600, sustain: 1, attack: 0.001, voices: 1 });
    const early = (x: Float32Array): number => brightness(x, f3, Math.round(SR * 0.01), Math.round(SR * 0.08));
    const late = (x: Float32Array): number => brightness(x, f3, Math.round(SR * 1.2), Math.round(SR * 1.6));
    // The baseline is not zero and should not be asserted as zero: a 1 ms
    // attack is a step, a step is broadband, and the first 80 ms of any note
    // is brighter than its sustain for that reason alone.
    assert(early(flat) < late(flat) * 1.25,
      `the filter moves ${(early(flat) / late(flat)).toFixed(2)}× with the envelope at zero`);
    assert(early(swept) > late(swept) * 1.6,
      `the envelope only moved the brightness from ${late(swept).toFixed(0)} Hz to ${early(swept).toFixed(0)} Hz`);
  });

  await check('the filter envelope still works under an expression curve', async () => {
    // The bug avoided by writing the envelope to `detune` rather than to
    // `frequency`: the timbre curve owns `frequency`, and scheduling both on
    // it would leave the envelope working everywhere except under the MPE
    // controller this app was built for.
    const withTimbre = (note: MidiNote): MidiNote => ({
      ...note,
      expression: [{
        target: { kind: 'timbre' },
        points: [{ timeBeat: 0, value: 0.5 }, { timeBeat: 4, value: 0.5 }],
      }],
    });
    const patch = {
      fegAmount: 4, fegAttack: 0.005, fegDecay: 0.9, cutoffHz: 600,
      sustain: 1, attack: 0.001, voices: 1,
    };
    const at = (x: Float32Array, a: number, b: number): number =>
      brightness(x, f3, Math.round(SR * a), Math.round(SR * b));

    // The SHAPE, not just the ends.  Writing the envelope to `frequency`
    // instead still moves the filter at the onset — the timbre curve's own
    // ramps only start one twenty-fourth of a note in — so an early-vs-late
    // check passes on the broken version.  What the conflict destroys is the
    // middle: the curve drags the filter back to its base long before the
    // envelope was due to finish.
    const plain = await play(patch, 2, C3);
    const expressive = await play(patch, 2, C3, withTimbre);
    for (const [label, x] of [['plain', plain], ['under a timbre curve', expressive]] as const) {
      const early = at(x, 0.01, 0.08), mid = at(x, 0.35, 0.45), late = at(x, 1.2, 1.6);
      assert(early > late * 1.6,
        `${label}: the envelope moved brightness only ${late.toFixed(0)} → ${early.toFixed(0)} Hz`);
      assert(mid > late * 1.25,
        `${label}: half way through a 0.9 s decay the filter was already back at ${mid.toFixed(0)} Hz (rest ${late.toFixed(0)})`);
    }
  });

  await check('key tracking stops high notes going dull', async () => {
    const bright = async (keyTrack: number, pitch: number): Promise<number> => {
      const x = await play({ keyTrack, cutoffHz: 1200, sustain: 1, voices: 1 }, 2, pitch);
      return brightness(x, freqOf(pitch), SR / 4, SR / 2) / freqOf(pitch);
    };
    // Without tracking, the same cutoff takes more off the higher note, so
    // its brightness RELATIVE to its own pitch falls.  With tracking it holds.
    const offLow = await bright(0, C3), offHigh = await bright(0, C5);
    const onLow = await bright(1, C3), onHigh = await bright(1, C5);
    assert(offHigh < offLow * 0.7,
      `without key tracking the high note kept ${(offHigh / offLow).toFixed(2)} of its relative brightness`);
    assert(onHigh > onLow * 0.7,
      `with key tracking the high note still lost it (${(onHigh / onLow).toFixed(2)})`);
  });

  // ── The LFO ───────────────────────────────────────────────────────────────

  await check('vibrato moves the pitch, and only when it is switched on', async () => {
    // Measured as spectral SPREAD rather than by counting zero crossings: a
    // crossing count over a window short enough to follow a 5 Hz wobble
    // resolves to about 10 Hz, which is wider than the wobble being looked
    // for.  How far the energy sits off the nominal pitch has no such floor.
    //
    // A sine, so the only thing that can put energy 60 cents up is the pitch
    // itself moving.
    const off = await play({ wave: 4, cutoffHz: 12000, voices: 1, sustain: 1, lfoRate: 0, lfoPitch: 0 });
    const on = await play({ wave: 4, cutoffHz: 12000, voices: 1, sustain: 1, lfoRate: 5, lfoPitch: 80 });
    const sideband = (x: Float32Array): number => {
      const a = SR / 4, b = Math.round(SR * 1.5);
      const up = tone(x, f3 * Math.pow(2, 60 / 1200), a, b);
      const down = tone(x, f3 * Math.pow(2, -60 / 1200), a, b);
      return db((up + down) / 2) - db(tone(x, f3, a, b));
    };
    assert(sideband(off) < -40, `the pitch already wanders ${sideband(off).toFixed(0)} dB off with the LFO off`);
    assert(sideband(on) > -20, `vibrato only put ${sideband(on).toFixed(0)} dB 60 cents off the pitch`);
  });

  await check('wobble moves the brightness', async () => {
    // One voice, because two detuned ones beat against each other slowly
    // enough to move the centroid on their own; and a window long enough to
    // resolve the bottom of the grid, which 50 ms is not.
    const vary = async (over: Record<string, number>): Promise<number> => {
      const x = await play({ cutoffHz: 900, sustain: 1, voices: 1, ...over });
      const win = Math.round(SR * 0.1);
      const c: number[] = [];
      for (let s = Math.round(SR * 0.3); s + win < SR * 1.5; s += win) c.push(brightness(x, f3, s, s + win));
      return Math.max(...c) / Math.max(1, Math.min(...c));
    };
    const off = await vary({ lfoRate: 0, lfoFilter: 0 });
    const on = await vary({ lfoRate: 3, lfoFilter: 2 });
    assert(off < 1.25, `the brightness swings ${off.toFixed(2)}× with the LFO off`);
    assert(on > 1.8, `wobble only swung the brightness ${on.toFixed(2)}×`);
  });

  // ── Drive ─────────────────────────────────────────────────────────────────

  await check('drive adds harmonics without adding level', async () => {
    // The same rule the Rhodes' Level had to be taught: a control that shapes
    // the sound must not also move the loudness, or the user cannot tell
    // which of the two they are hearing.
    const at = (drive: number): Promise<Float32Array> =>
      play({ drive, wave: 4, cutoffHz: 12000, voices: 1, sustain: 1 });
    const clean = await at(0), dirty = await at(1);
    const upper = (x: Float32Array): number => {
      const h = harmonics(x, f3, 7, SR / 4, SR / 2);
      return (h[2]! + h[4]! + h[6]!) / Math.max(1e-9, h[0]!);
    };
    assert(upper(dirty) > upper(clean) * 8,
      `drive raised the upper harmonics only ${(upper(dirty) / Math.max(1e-9, upper(clean))).toFixed(1)}×`);
    // Across the knob, not only at its end.  Squaring off a sine is worth
    // 3 dB, which is exactly the size of the mistake a 3 dB tolerance would
    // wave through — so 1 dB, checked at four settings.
    const base = db(rms(clean, SR / 4, SR));
    for (const d of [0.25, 0.5, 0.75, 1]) {
      const delta = db(rms(await at(d), SR / 4, SR)) - base;
      assert(Math.abs(delta) < 1,
        `drive ${d} also moved the level by ${delta.toFixed(2)} dB`);
    }
  });

  await check('every parameter the synth advertises is one it reads', async () => {
    // A parameter in the list that the voice never looks at is a knob that
    // does nothing, and the rack draws it exactly like the ones that work.
    const inst = findInstrument('polysynth')!;
    const source = (await import('node:fs')).readFileSync(
      new URL('../src/renderer/daw/engine/instruments.ts', import.meta.url), 'utf8');
    const voice = source.slice(source.indexOf("id: 'polysynth'"), source.indexOf("id: 'epiano'"));
    for (const p of inst.params) {
      assert(voice.includes(`params['${p.id}']`), `${p.id} is advertised but never read`);
    }
  });

  console.log('\n=== Poly Synth — knobs that are connected to something ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
