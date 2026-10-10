/**
 * wave-synth-selftest.ts — whether the wavetable synth is one.
 *
 * Three claims separate a wavetable synth from a subtractive synth with more
 * knobs, and all three are things the poly synth next to it cannot do:
 *
 *   1. the table MOVES while the note sounds, past frame boundaries
 *   2. the matrix reaches everything, per voice
 *   3. reading a table at any pitch does not alias
 *
 * The third is the only hard engineering, and it is the one that fails
 * silently: a synth that aliases still makes a sound, and the sound is
 * wrong in a way that is easy to mistake for character.
 *
 * ── How aliasing is measured here ───────────────────────────────────────────
 *
 * Energy at frequencies that are NOT harmonics of the note, relative to the
 * fundamental, with a Goertzel at each probe.  Probes within 8% of a harmonic
 * are skipped, and the figure this gives at LOW pitches is dominated by
 * spectral leakage rather than by aliasing — at A1 the harmonics are 55 Hz
 * apart and a probe is never far from one.  So the load-bearing form of the
 * claim is DIFFERENTIAL: the same measurement with the mip chain and without
 * it, at the same pitch.  That cancels the leakage and leaves the thing being
 * asked about.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:wave-synth
 */

import { readFileSync } from 'node:fs';
import {
  CYCLE, TableReader, WAVETABLES, cycleFor, mipFor, readTable, wavetableAt,
} from '../src/renderer/daw/engine/wavetable.js';
import {
  LFO_SHAPES, MATRIX_ROWS, MOD_DESTS, MOD_SOURCES, activeRows, describeRow,
  lfoValue, noteRandom, rowParams,
} from '../src/renderer/daw/engine/mod-matrix.js';
import { renderVoice, tailSeconds } from '../src/renderer/daw/engine/wave-synth.js';
import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { patchesFor } from '../src/renderer/daw/engine/instrument-patches.js';

const SR = 48000;
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

function tone(buf: Float32Array, hz: number, from = 0, len = buf.length): number {
  const n = Math.min(len, buf.length - from);
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (buf[from + i] ?? 0) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n;
}

/** Non-harmonic energy relative to the fundamental, in dB. */
function junkDb(buf: Float32Array, f0: number): number {
  let worst = -200;
  for (let hz = 40; hz < SR * 0.45; hz += 23.7) {
    const k = hz / f0;
    if (Math.abs(k - Math.round(k)) < 0.08) continue;
    const db = 20 * Math.log10(Math.max(1e-12, tone(buf, hz)));
    if (db > worst) worst = db;
  }
  return worst - 20 * Math.log10(Math.max(1e-12, tone(buf, f0)));
}

function sweep(tableId: string, pos: number, f0: number, n: number, mipped: boolean): Float32Array {
  const t = WAVETABLES.find((x) => x.id === tableId)!;
  const r = new TableReader(t);
  const out = new Float32Array(n);
  const mip = mipped ? mipFor(f0, SR) : 0;
  let ph = 0;
  for (let i = 0; i < n; i++) { out[i] = r.read(pos, ph, mip); ph = (ph + f0 / SR) % 1; }
  return out;
}

const baseParams = (): Record<string, number> => ({ ...defaultInstrumentParams('wavesynth') });

function voice(over: Record<string, number>, seconds = 1, gate = 0.8, pitch = 57): Float32Array {
  const freq = 440 * Math.pow(2, (pitch - 69) / 12);
  const r = renderVoice({
    sampleRate: SR, seconds, gateSec: gate, freqHz: freq, pitch, velocity: 0.8,
    random: noteRandom(pitch, 0, 5), params: { ...baseParams(), ...over }, beatsPerSec: 2,
  });
  const mono = new Float32Array(r.left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
  return mono;
}

function rms(buf: Float32Array, from: number, len: number): number {
  let sum = 0; let n = 0;
  const end = Math.min(buf.length, from + len);
  for (let i = Math.max(0, from); i < end; i++) { sum += (buf[i] ?? 0) ** 2; n += 1; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/**
 * How much 8th harmonic there is against the fundamental, in dB.
 *
 * The right measurement for a FILTER, and the centroid below is not: at a
 * note of 220 Hz the fundamental carries most of the energy whatever the
 * filter is doing to the harmonics above it, so a low-pass sweeping two
 * octaves moved the centroid by 1.13× and this by forty decibels.  Used
 * wherever the claim is about the filter; the centroid stays for claims about
 * the whole spectrum, like a table sweep.
 */
function tiltDb(buf: Float32Array, f0: number, from: number, len: number): number {
  const top = tone(buf, f0 * 8, from, len);
  const bottom = tone(buf, f0, from, len);
  return 20 * Math.log10(Math.max(1e-12, top) / Math.max(1e-12, bottom));
}

/** Where the energy sits, in hertz — one number for "how bright". */
function centroid(buf: Float32Array, from: number, len: number): number {
  let num = 0; let den = 0;
  for (let hz = 60; hz < 16000; hz *= 1.06) {
    const a = tone(buf, hz, from, len) ** 2;
    num += hz * a; den += a;
  }
  return den > 0 ? num / den : 0;
}

// ── 1. Aliasing ─────────────────────────────────────────────────────────────

check('the mip chain is what stops a table aliasing', () => {
  // Differential, for the reason in the header.
  for (const [name, midi, want] of [['A4', 69, 30], ['C6', 84, 50], ['C7', 96, 60]] as const) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const off = junkDb(sweep('basic', 3, f0, 16384, false), f0);
    const on = junkDb(sweep('basic', 3, f0, 16384, true), f0);
    assert(off - on >= want,
      `${name}: mips bought ${(off - on).toFixed(1)} dB (${off.toFixed(1)} → ${on.toFixed(1)}), wanted ${want}`);
    assert(on < -70, `${name} still has junk at ${on.toFixed(1)} dB with the mips on`);
  }
});

check('no mip ever carries a harmonic above Nyquist', () => {
  for (const midi of [36, 60, 84, 96, 108, 120]) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const mip = mipFor(f0, SR);
    const top = Math.max(1, (CYCLE / 2) >> mip);
    assert(top * f0 < SR / 2,
      `MIDI ${midi} reads mip ${mip}, whose top harmonic is at ${(top * f0).toFixed(0)} Hz`);
  }
});

check('the whole synth does not alias at the top of the keyboard', () => {
  // The claim above is about the table reader; this is about the instrument,
  // which also has a sub, a filter and a drive that could each put energy
  // where there was none.
  for (const midi of [96, 103]) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const buf = voice({ aPos: 3, aUnison: 1, aWidth: 0, fltMix: 0, e1a: 0.001, e1s: 1 },
      0.5, 0.45, midi);
    const junk = junkDb(buf, f0);
    assert(junk < -45, `MIDI ${midi} renders ${junk.toFixed(1)} dB of non-harmonic energy`);
  }
});

// ── 2. The table moves ──────────────────────────────────────────────────────

check('every table has frames that differ from each other', () => {
  for (const t of WAVETABLES) {
    assert(t.frames.length >= 4, `${t.id} has only ${t.frames.length} frames`);
    for (let f = 1; f < t.frames.length; f++) {
      const a = cycleFor(t, f - 1, 0); const b = cycleFor(t, f, 0);
      let diff = 0;
      for (let i = 0; i < CYCLE; i++) diff = Math.max(diff, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
      assert(diff > 0.02, `${t.id} frames ${f - 1} and ${f} are the same waveform (max diff ${diff.toFixed(4)})`);
    }
    assert(t.note.length >= 10, `${t.id} does not say what its knob does`);
  }
});

check('every frame arrives at the same peak, so WT POS is not a volume knob', () => {
  for (const t of WAVETABLES) {
    for (let f = 0; f < t.frames.length; f++) {
      const c = cycleFor(t, f, 0);
      let peak = 0;
      for (let i = 0; i < CYCLE; i++) peak = Math.max(peak, Math.abs(c[i] ?? 0));
      assert(Math.abs(peak - 1) < 0.001, `${t.id} frame ${f} peaks at ${peak.toFixed(4)}`);
    }
  }
});

check('the position can be swept past a frame boundary without a click', () => {
  // The whole reason this instrument is computed rather than wired.  A
  // crossfade between two fixed oscillators would have to jump here.
  const t = WAVETABLES.find((x) => x.id === 'pwm')!;
  const r = new TableReader(t);
  let worst = 0; let at = 0;
  let previous = r.read(0, 0.25, 0);
  for (let i = 1; i <= 7000; i++) {
    const pos = (i / 7000) * 7;
    const v = r.read(pos, 0.25, 0);
    const jump = Math.abs(v - previous);
    if (jump > worst) { worst = jump; at = pos; }
    previous = v;
  }
  assert(worst < 0.02, `sweeping the table jumped ${worst.toFixed(4)} at frame ${at.toFixed(2)}`);
});

check('the position is clamped at the ends and does not wrap', () => {
  const t = wavetableAt(0);
  const last = t.frames.length - 1;
  for (const ph of [0.1, 0.37, 0.8]) {
    assert(readTable(t, -5, ph, 0) === readTable(t, 0, ph, 0), 'the table wrapped below frame 0');
    assert(readTable(t, last + 5, ph, 0) === readTable(t, last, ph, 0),
      'the table wrapped above the last frame');
  }
});

check('the Analog table changes the wave without changing the spectrum', () => {
  // The one table that proves the ear hears more than an analyser: every
  // frame has a saw's amplitudes and only the phases move.
  const t = WAVETABLES.find((x) => x.id === 'analog')!;
  const a = cycleFor(t, 0, 0); const b = cycleFor(t, 7, 0);
  const mag = (c: Float32Array, n: number): number => {
    let re = 0; let im = 0;
    for (let i = 0; i < CYCLE; i++) {
      const th = (2 * Math.PI * n * i) / CYCLE;
      re += (c[i] ?? 0) * Math.cos(th); im += (c[i] ?? 0) * Math.sin(th);
    }
    return Math.hypot(re, im) / CYCLE;
  };
  let spec = 0;
  for (let n = 1; n <= 16; n++) spec = Math.max(spec, Math.abs(20 * Math.log10(mag(a, n) / mag(b, n))));
  let wave = 0;
  for (let i = 0; i < CYCLE; i++) wave = Math.max(wave, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  assert(spec < 2, `the spectrum moved ${spec.toFixed(2)} dB, so this is not a phase-only table`);
  assert(wave > 0.4, `the waveform only moved ${wave.toFixed(3)} — the phases are not doing anything`);
});

// ── 3. The matrix reaches things ────────────────────────────────────────────

check('a source with no destination, or no depth, costs nothing', () => {
  const params = { ...baseParams(), m1src: 4, m1dst: 0, m1amt: 1, m2src: 0, m2dst: 5, m2amt: 1, m3src: 4, m3dst: 5, m3amt: 0 };
  assert(activeRows(params).length === 0, 'a row missing a source, a destination or a depth was kept');
  const live = { ...params, m4src: 4, m4dst: 5, m4amt: 0.5 };
  assert(activeRows(live).length === 1, 'the one live row was not found');
  assert(describeRow(activeRows(live)[0]!).includes('LFO 1'), 'the row does not read back as itself');
});

check('an LFO on the cutoff actually moves the cutoff', () => {
  // `aPos: 3` on purpose.  The table's frame 0 is a pure SINE, and the first
  // version of this check left it there and then measured the 8th harmonic —
  // which was at −150 dB because a sine has none.  A filter check has to be
  // given something to filter.
  // Unison off as well, and that is the second thing this check had to learn:
  // three voices fourteen cents apart BEAT, so the 8th harmonic's level
  // genuinely wanders by 9 dB with nothing modulating anything.  A filter
  // check has to be given something to filter and nothing else moving.
  const setup = { aPos: 3, aUnison: 1, aWidth: 0, cutoff: 80, res: 0.3, e1s: 1, e1a: 0.002 };
  const still = voice(setup, 2, 1.9);
  const swept = voice({
    ...setup, l1sync: 0, l1rate: 1.5, l1shape: 0, m1src: 4, m1dst: 5, m1amt: 0.6,
  }, 2, 1.9);
  const win = Math.round(SR * 0.12);
  // The swept one has to be BRIGHT somewhere and DARK somewhere; the still
  // one has to be the same all through.  Either half alone would pass on a
  // bug that simply made the sound quieter.
  const moved: number[] = []; const stills: number[] = [];
  for (let t = 0.2; t < 1.8; t += 0.06) {
    moved.push(tiltDb(swept, 220, Math.round(SR * t), win));
    stills.push(tiltDb(still, 220, Math.round(SR * t), win));
  }
  const swing = Math.max(...moved) - Math.min(...moved);
  const drift = Math.max(...stills) - Math.min(...stills);
  assert(swing > 12, `the LFO moved the 8th harmonic by only ${swing.toFixed(1)} dB`);
  assert(drift < 4, `the unmodulated voice drifted ${drift.toFixed(1)} dB on its own`);
});

check('an envelope on the table position sweeps the table', () => {
  const still = voice({ aTable: 1, aPos: 0, fltMix: 0, e1s: 1, e1a: 0.002 }, 1.4, 1.3);
  const swept = voice({
    aTable: 1, aPos: 0, fltMix: 0, e1s: 1, e1a: 0.002,
    e2a: 0.9, e2d: 0.2, e2s: 1, m1src: 2, m1dst: 1, m1amt: 1,
  }, 1.4, 1.3);
  const win = Math.round(SR * 0.12);
  const early = centroid(swept, Math.round(SR * 0.05), win);
  const late = centroid(swept, Math.round(SR * 0.95), win);
  assert(late / Math.max(1, early) > 1.3,
    `the table sweep moved the centroid from ${early.toFixed(0)} to ${late.toFixed(0)} Hz`);
  const a = centroid(still, Math.round(SR * 0.05), win);
  const b = centroid(still, Math.round(SR * 0.95), win);
  assert(Math.abs(b / Math.max(1, a) - 1) < 0.2,
    'the unmodulated voice swept on its own, so the measurement is not about the matrix');
});

check('velocity reaches the matrix as a source', () => {
  const at = (vel: number): number => {
    const r = renderVoice({
      sampleRate: SR, seconds: 0.8, gateSec: 0.7, freqHz: 220, pitch: 57, velocity: vel,
      random: 0, beatsPerSec: 2,
      params: { ...baseParams(), aPos: 3, cutoff: 70, e1s: 1, e1a: 0.002, m1src: 8, m1dst: 5, m1amt: 0.5 },
    });
    const mono = new Float32Array(r.left.length);
    for (let i = 0; i < mono.length; i++) mono[i] = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
    return tiltDb(mono, 220, Math.round(SR * 0.2), Math.round(SR * 0.3));
  };
  const soft = at(0.2); const hard = at(1);
  assert(hard - soft > 10,
    `velocity moved the 8th harmonic from ${soft.toFixed(1)} to ${hard.toFixed(1)} dB`);
});

check('every destination in the list is one the engine actually reads', () => {
  // A destination that draws in the UI and does nothing is the exact defect
  // this repository has caught before.  Every one is driven at full depth
  // from a source that is definitely moving, and has to change the audio.
  const src = 4;                                    // LFO 1, unmissable
  // The setup has to give every destination something to act on, and getting
  // that wrong looks exactly like an engine bug.  B DETUNE failed the first
  // version of this check because `bUnison` rests at 1, and the detune of a
  // single voice is nothing by definition — there is no second string to pull
  // away from.  So both oscillators run a unison here, and the table sits at
  // a frame with harmonics rather than at the sine it rests on.
  const setup = {
    aPos: 3, bPos: 3, e1s: 1, e1a: 0.002,
    bLevel: 0.4, bUnison: 3, subLevel: 0.3, noiseLevel: 0.15,
  };
  const control = voice(setup, 1, 0.9);
  for (let d = 1; d < MOD_DESTS.length; d++) {
    const dest = MOD_DESTS[d]!;
    const moved = voice({
      ...setup,
      l1sync: 0, l1rate: 3, l1shape: 0, m1src: src, m1dst: d, m1amt: 0.8,
    }, 1, 0.9);
    let diff = 0;
    for (let i = 0; i < control.length; i += 5) {
      diff = Math.max(diff, Math.abs((control[i] ?? 0) - (moved[i] ?? 0)));
    }
    assert(diff > 0.002, `${dest.name} (index ${d}) changed nothing when driven at 80%`);
  }
});

check('every source in the list can reach a destination', () => {
  const control = voice({ aPos: 3, e1s: 1, e1a: 0.002, cutoff: 80 }, 1, 0.9);
  for (let sIdx = 1; sIdx < MOD_SOURCES.length; sIdx++) {
    const source = MOD_SOURCES[sIdx]!;
    // Every source is given something to be: the wheel and the pressure are
    // parameters, the macros are knobs, the rest come from the note.
    const moved = voice({
      aPos: 3, e1s: 1, e1a: 0.002, cutoff: 80,
      e2s: 1, e3s: 1, l1sync: 0, l1rate: 3, l2sync: 0, l2rate: 3,
      l3sync: 0, l3rate: 3, l4sync: 0, l4rate: 3,
      macro1: 0.8, macro2: 0.8, macro3: 0.8, macro4: 0.8, wheel: 0.8, pressure: 0.8,
      m1src: sIdx, m1dst: 5, m1amt: 0.9,
    }, 1, 0.9);
    let diff = 0;
    for (let i = 0; i < control.length; i += 5) {
      diff = Math.max(diff, Math.abs((control[i] ?? 0) - (moved[i] ?? 0)));
    }
    assert(diff > 0.002, `${source.name} (index ${sIdx}) moved nothing at 90% onto the cutoff`);
  }
});

check('every LFO shape is a different shape, and S&H repeats', () => {
  for (let a = 0; a < LFO_SHAPES.length; a++) {
    for (let b = a + 1; b < LFO_SHAPES.length; b++) {
      let diff = 0;
      for (let i = 0; i < 64; i++) {
        diff = Math.max(diff, Math.abs(lfoValue(a, i / 64, 0.5, 3) - lfoValue(b, i / 64, 0.5, 3)));
      }
      assert(diff > 0.2, `${LFO_SHAPES[a]} and ${LFO_SHAPES[b]} are the same shape`);
    }
  }
  // Sample-and-hold has to be a FUNCTION of its phase and not a running
  // generator, and the way to say so is to ask for the values out of order.
  // A PRNG stepped once per call passes a forwards read and fails this — and
  // an offline render does exactly this, starting in the middle of a note
  // rather than playing up to it.
  const forwards: number[] = [];
  for (let i = 0; i < 40; i++) forwards.push(lfoValue(5, i / 13, 0.5, 7));
  const shuffled = [7, 31, 2, 19, 0, 38, 11, 25, 5, 14];
  for (const i of shuffled) {
    assert(lfoValue(5, i / 13, 0.5, 7) === forwards[i],
      `sample-and-hold gave a different value for phase ${(i / 13).toFixed(3)} when asked out of order`);
  }
  assert(new Set(forwards).size > 4, 'sample-and-hold is a constant');
  // And a different note gets different steps, or S&H would be a constant.
  let differs = false;
  for (let i = 0; i < 20; i++) if (lfoValue(5, i / 7, 0.5, 7) !== lfoValue(5, i / 7, 0.5, 8)) differs = true;
  assert(differs, 'the sample-and-hold seed does nothing');
});

check('skew bends a shape without turning it into a different one', () => {
  for (const shape of [0, 1, 2]) {
    const mid = Array.from({ length: 32 }, (_, i) => lfoValue(shape, i / 32, 0.5, 1));
    const bent = Array.from({ length: 32 }, (_, i) => lfoValue(shape, i / 32, 0.15, 1));
    let diff = 0;
    for (let i = 0; i < 32; i++) diff = Math.max(diff, Math.abs((mid[i] ?? 0) - (bent[i] ?? 0)));
    assert(diff > 0.2, `skew changed shape ${shape} by only ${diff.toFixed(3)}`);
    for (const v of bent) assert(v >= -1.001 && v <= 1.001, `skew pushed shape ${shape} to ${v}`);
  }
});

// ── The instrument as a whole ───────────────────────────────────────────────

check('the same note renders to the same samples, every time', () => {
  const a = voice({ aTable: 4, aPos: 2.3, l1sync: 0, l1rate: 5, l1shape: 5, m1src: 4, m1dst: 1, m1amt: 0.7 });
  const b = voice({ aTable: 4, aPos: 2.3, l1sync: 0, l1rate: 5, l1shape: 5, m1src: 4, m1dst: 1, m1amt: 0.7 });
  for (let i = 0; i < a.length; i += 17) assert(a[i] === b[i], `sample ${i} differs between two renders`);
  assert(Math.abs(noteRandom(60, 4, 5) - noteRandom(60, 4, 5)) < 1e-12, 'noteRandom is not a function of its note');
  assert(noteRandom(60, 4, 5) !== noteRandom(61, 4, 5), 'every note gets the same random value');
});

check('nothing clips, and nothing is silent', () => {
  for (const patch of patchesFor('wavesynth')) {
    for (const pitch of [36, 60, 84]) {
      const buf = voice(patch.params as Record<string, number>, 1.2, 0.9, pitch);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] ?? 0));
      assert(peak < 4, `${patch.id} at MIDI ${pitch} peaks at ${peak.toFixed(2)} before the trim`);
      assert(rms(buf, Math.round(SR * 0.05), Math.round(SR * 0.4)) > 0.0015,
        `${patch.id} at MIDI ${pitch} is silent`);
    }
  }
});

check('the release is honoured and the note ends in silence', () => {
  const buf = voice({ e1r: 0.4, e1s: 0.8 }, 1.6, 0.6);
  const during = rms(buf, Math.round(SR * 0.3), Math.round(SR * 0.2));
  const justAfter = rms(buf, Math.round(SR * 0.7), Math.round(SR * 0.1));
  const wellAfter = rms(buf, Math.round(SR * 1.2), Math.round(SR * 0.3));
  assert(justAfter < during && justAfter > wellAfter, 'the release does not fall');
  assert(wellAfter < during * 0.01, `the note is still at ${(wellAfter / during).toFixed(4)} of its level a second later`);
  assert(tailSeconds({ e1r: 3, e2r: 0.1, e3r: 0.1 }) > 3, 'the tail is shorter than the longest release');
});

check('the bank uses the matrix, because otherwise the matrix is decoration', () => {
  const patches = patchesFor('wavesynth');
  assert(patches.length >= 8, `only ${patches.length} patches`);
  let withMatrix = 0;
  const seen = new Set<number>();
  for (const patch of patches) {
    const rows = activeRows({ ...defaultInstrumentParams('wavesynth'), ...patch.params });
    if (patch.id === 'init') {
      assert(rows.length === 0, 'the init patch routes something, so it is not an init patch');
      continue;
    }
    assert(rows.length > 0, `${patch.id} uses no modulation at all`);
    withMatrix += 1;
    for (const r of rows) seen.add(r.dst);
    assert(patch.note.length >= 12, `${patch.id} does not say what it is for`);
  }
  assert(withMatrix >= 8, `only ${withMatrix} patches use the matrix`);
  assert(seen.size >= 6, `the whole bank only ever modulates ${seen.size} different destinations`);
});

check('the parameter list covers every matrix row and both oscillators', () => {
  const inst = findInstrument('wavesynth');
  assert(inst !== undefined, 'the wavetable synth is not in INSTRUMENTS');
  const ids = new Set(inst!.params.map((d) => d.id));
  for (let r = 0; r < MATRIX_ROWS; r++) {
    const p = rowParams(r);
    for (const id of [p.src, p.dst, p.amt]) assert(ids.has(id), `${id} has no parameter`);
  }
  for (const o of ['a', 'b']) {
    for (const k of ['Table', 'Pos', 'Oct', 'Semi', 'Fine', 'Unison', 'Detune', 'Blend', 'Phase', 'Rand', 'Width', 'Pan', 'Level']) {
      assert(ids.has(o + k), `${o}${k} has no parameter`);
    }
  }
  for (const def of inst!.params) {
    assert(def.default >= def.min && def.default <= def.max,
      `${def.id} rests at ${def.default}, outside ${def.min}…${def.max}`);
  }
  // Every source and destination the matrix offers has to be selectable.
  const srcDef = inst!.params.find((d) => d.id === 'm1src')!;
  const dstDef = inst!.params.find((d) => d.id === 'm1dst')!;
  assert(srcDef.max === MOD_SOURCES.length - 1, 'the source knob cannot reach every source');
  assert(dstDef.max === MOD_DESTS.length - 1, 'the destination knob cannot reach every destination');
});

check('unison spreads across the stereo field, and Width is what does it', () => {
  const sides = (width: number): number => {
    const freq = 220;
    const r = renderVoice({
      sampleRate: SR, seconds: 1, gateSec: 0.9, freqHz: freq, pitch: 57, velocity: 0.8,
      random: 0, beatsPerSec: 2,
      params: { ...baseParams(), aUnison: 7, aDetune: 20, aWidth: width, e1s: 1, e1a: 0.002 },
    });
    let side = 0; let mid = 0;
    for (let i = 0; i < r.left.length; i += 3) {
      const m = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
      const s = ((r.left[i] ?? 0) - (r.right[i] ?? 0)) / 2;
      mid += m * m; side += s * s;
    }
    return 10 * Math.log10((side + 1e-20) / (mid + 1e-20));
  };
  const narrow = sides(0); const wide = sides(1);
  assert(narrow < -80, `at Width 0 the side channel is ${narrow.toFixed(1)} dB, which is not mono`);
  assert(wide > -12, `at Width 1 the side channel is only ${wide.toFixed(1)} dB`);
});

check('a note costs less than the budget it is allowed', () => {
  // A limit, not a benchmark: every note is computed on the thread that
  // schedules it.  The first version of the render loop read its modulation
  // out of a Record<string, number> — twenty-eight hashed string lookups per
  // sample — and cost 127 ms for a note this size.
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) voice({ aUnison: 3, bLevel: 0.6, bUnison: 3 }, 1.2, 1);
  const ms = (performance.now() - t0) / 4;
  assert(ms < 70, `an ordinary 1.2-second note takes ${ms.toFixed(1)} ms`);

  const t1 = performance.now();
  voice({ aUnison: 7, bUnison: 7, bLevel: 0.8, subLevel: 0.4, noiseLevel: 0.2 }, 6, 5);
  const heavy = performance.now() - t1;
  assert(heavy < 900, `the worst case — a six-second pad at unison 7 on both — takes ${heavy.toFixed(0)} ms`);
});

check('the instrument is reachable, and the rack can edit it', () => {
  // Everything above builds its own params and calls `renderVoice` directly,
  // so all of it would stay green with the instrument unregistered.  That gap
  // has been found by breaking a check twice in this repository, so it is
  // closed by reading the source.
  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
  const engine = strip(readFileSync('src/renderer/daw/engine/instruments.ts', 'utf8'));
  assert(/id:\s*'wavesynth'/.test(engine), 'INSTRUMENTS has no wavesynth entry');
  assert(/renderVoice\s*\(/.test(engine), 'instruments.ts never calls renderVoice');
  assert(/playNote:\s*\(v\)\s*=>\s*waveSynthVoice\(v\)/.test(engine),
    'the wavesynth entry does not play through waveSynthVoice');
  const rack = strip(readFileSync('src/renderer/components/daw/InstrumentRack.tsx', 'utf8'));
  assert(/INSTRUMENTS/.test(rack), 'the rack does not read the instrument list');
  assert(!/'polysynth'\s*,\s*'epiano'/.test(rack), 'the rack hardcodes an instrument list');
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
