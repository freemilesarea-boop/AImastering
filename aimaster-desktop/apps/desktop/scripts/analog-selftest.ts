/**
 * analog-selftest.ts — whether the analogue synth is analogue.
 *
 * "Add noise and detune it" is the usual answer to this and it is wrong, so
 * every check below is against one of the six things in `analog-model.ts`'s
 * header that a mathematically perfect oscillator does not do.  Three of them
 * are also checked AGAINST the wavetable synth in the same repository, which
 * is the honest form of the claim: the point is not that this instrument has
 * drift, it is that it behaves differently from the digital one beside it.
 *
 *   1. the pitch wanders, slowly, and two oscillators wander apart
 *   2. the oscillators are free-running, so a note's phase depends on where
 *      in the bar it is
 *   3. every voice is different hardware
 *   4. the ladder saturates, self-oscillates, and loses bass with resonance
 *   5. the envelopes are capacitors
 *   6. the oscillators are band-limited by PolyBLEP
 *
 * Run via:  pnpm --filter @aimaster/desktop test:analog
 */

import { readFileSync } from 'node:fs';
import {
  ANALOG_SHAPES, Ladder, analogEnv, analogHash, analogSample, driftCents,
  polyBlep, voiceTolerance,
} from '../src/renderer/daw/engine/analog-model.js';
import { renderAnalogVoice, voiceSlot, analogTail } from '../src/renderer/daw/engine/analog-synth.js';
import { renderVoice } from '../src/renderer/daw/engine/wave-synth.js';
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

function tone(b: Float32Array, hz: number, from = 0, len = b.length): number {
  const n = Math.min(len, b.length - from);
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (b[from + i] ?? 0) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n;
}
function junkDb(b: Float32Array, f0: number): number {
  let worst = -200;
  for (let hz = 40; hz < SR * 0.45; hz += 23.7) {
    const k = hz / f0;
    if (Math.abs(k - Math.round(k)) < 0.08) continue;
    const db = 20 * Math.log10(Math.max(1e-12, tone(b, hz)));
    if (db > worst) worst = db;
  }
  return worst - 20 * Math.log10(Math.max(1e-12, tone(b, f0)));
}

const base = (): Record<string, number> => ({ ...defaultInstrumentParams('analog') });

function voice(
  over: Record<string, number>, seconds = 1.2, gate = 1, pitch = 45, slot = 0, startBeat = 0,
): { left: Float32Array; right: Float32Array; mono: Float32Array } {
  const r = renderAnalogVoice({
    sampleRate: SR, seconds, gateSec: gate,
    freqHz: 440 * Math.pow(2, (pitch - 69) / 12), pitch, velocity: 0.8,
    slot, startBeat, params: { ...base(), ...over }, beatsPerSec: 2,
  });
  const mono = new Float32Array(r.left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
  return { ...r, mono };
}

/** The instantaneous frequency of the strongest partial, over a window. */
function pitchAt(b: Float32Array, nominal: number, at: number, len: number): number {
  let best = nominal; let bestMag = 0;
  for (let hz = nominal * 0.97; hz <= nominal * 1.03; hz += nominal * 0.0006) {
    const m = tone(b, hz, at, len);
    if (m > bestMag) { bestMag = m; best = hz; }
  }
  return best;
}

// ── 1. The pitch wanders ────────────────────────────────────────────────────

check('a VCO wanders, and it wanders slowly', () => {
  const seen: number[] = [];
  for (let t = 0; t < 10; t += 0.02) seen.push(driftCents(t, 4, 7));
  const range = Math.max(...seen) - Math.min(...seen);
  assert(range > 3 && range < 9, `a depth of 4 cents produced a ${range.toFixed(2)} cent range`);
  let fastest = 0;
  for (let i = 1; i < seen.length; i++) fastest = Math.max(fastest, Math.abs(seen[i]! - seen[i - 1]!));
  // Slow enough to be wandering rather than vibrato: under a tenth of a cent
  // per twenty milliseconds is five cents a second at the very most.
  assert(fastest < 0.12, `the drift moves ${fastest.toFixed(3)} cents per 20 ms, which is vibrato`);
  assert(driftCents(3, 4, 1) !== driftCents(3, 4, 2), 'two oscillators drift together');
  assert(driftCents(5, 0, 1) === 0, 'a depth of zero still drifts');
});

check('the drift reaches the audio, and the digital synth has none', () => {
  const held = 6;
  const analogue = voice({ drift: 14, o2level: 0, unison: 1, e1s: 1, e1a: 0.002, res: 0, cutoff: 130 },
    held + 0.3, held).mono;
  const early = pitchAt(analogue, 110, Math.round(SR * 0.3), Math.round(SR * 0.6));
  const late = pitchAt(analogue, 110, Math.round(SR * 4.5), Math.round(SR * 0.6));
  const cents = Math.abs(1200 * Math.log2(late / early));
  assert(cents > 3, `over five seconds the pitch moved ${cents.toFixed(2)} cents`);

  // The wavetable synth, same note, same length: its pitch is a number.
  const digital = renderVoice({
    sampleRate: SR, seconds: held + 0.3, gateSec: held, freqHz: 110, pitch: 45, velocity: 0.8,
    random: 0, beatsPerSec: 2,
    params: { ...defaultInstrumentParams('wavesynth'), aPos: 3, aUnison: 1, aWidth: 0, e1s: 1, e1a: 0.002, fltMix: 0 },
  });
  const dm = new Float32Array(digital.left.length);
  for (let i = 0; i < dm.length; i++) dm[i] = ((digital.left[i] ?? 0) + (digital.right[i] ?? 0)) / 2;
  const dEarly = pitchAt(dm, 110, Math.round(SR * 0.3), Math.round(SR * 0.6));
  const dLate = pitchAt(dm, 110, Math.round(SR * 4.5), Math.round(SR * 0.6));
  const dCents = Math.abs(1200 * Math.log2(dLate / dEarly));
  assert(dCents < 1, `the wavetable synth moved ${dCents.toFixed(2)} cents, so this measurement is not about drift`);
});

// ── 2. Free-running oscillators ─────────────────────────────────────────────

check('the same note at a different place in the bar is a different sound', () => {
  const a = voice({ e1a: 0.001, e1s: 1 }, 0.4, 0.35, 45, 0, 0).mono;
  const b = voice({ e1a: 0.001, e1s: 1 }, 0.4, 0.35, 45, 0, 7).mono;
  let diff = 0;
  for (let i = 0; i < 400; i++) diff = Math.max(diff, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  assert(diff > 0.01, `two notes seven beats apart start identically (max difference ${diff.toExponential(2)})`);

  // And the SAME note is the same note, because a bounce has to match the
  // preview.  This is the part a real synth does not do, and it is a
  // deliberate trade rather than an oversight — see the module header.
  const c = voice({ e1a: 0.001, e1s: 1 }, 0.4, 0.35, 45, 0, 7).mono;
  for (let i = 0; i < b.length; i += 13) {
    assert(b[i] === c[i], `sample ${i} differs between two renders of one note`);
  }
});

// ── 3. Every voice is different hardware ────────────────────────────────────

check('two voices are two instruments', () => {
  const spread = 0.08;
  const a = voice({ tolerance: spread, e1s: 1, e1a: 0.002 }, 0.8, 0.7, 45, 0).mono;
  const b = voice({ tolerance: spread, e1s: 1, e1a: 0.002 }, 0.8, 0.7, 45, 3).mono;
  // RELATIVE to the signal, not an absolute number.  The first version asked
  // for a difference of 0.01 without knowing what this instrument's output
  // peaks at — which is about 0.14 after its trim, so 0.01 was asking for
  // seven per cent and the measured four per cent failed a threshold that
  // was never about anything.
  let diff = 0; let peak = 0;
  for (let i = 0; i < a.length; i += 3) {
    diff = Math.max(diff, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    peak = Math.max(peak, Math.abs(a[i] ?? 0));
  }
  const relative = diff / Math.max(1e-9, peak);
  assert(relative > 0.02,
    `voice 0 and voice 3 differ by ${(relative * 100).toFixed(1)}% of the signal — that is the same hardware`);

  // With the tolerance at zero they are the same hardware, which is what says
  // the measurement above is about the tolerance and not about the slot.
  const c = voice({ tolerance: 0, e1s: 1, e1a: 0.002, spread: 0 }, 0.8, 0.7, 45, 0).mono;
  const d = voice({ tolerance: 0, e1s: 1, e1a: 0.002, spread: 0 }, 0.8, 0.7, 45, 3).mono;
  for (let i = 0; i < c.length; i += 17) {
    assert(c[i] === d[i], `at zero tolerance voice 0 and voice 3 still differ at sample ${i}`);
  }
  for (const s of [0, 0.03, 0.1]) {
    const v = [0, 1, 2, 3, 4].map((slot) => voiceTolerance(slot, s, 0));
    const range = Math.max(...v) - Math.min(...v);
    assert(s === 0 ? range === 0 : range > s * 0.5,
      `a spread of ${s} gives a range of ${range.toFixed(4)} across five voices`);
  }
});

check('a chord spreads across the stereo field, and the spread is balanced', () => {
  // How far left or right one voice sits: negative is left, positive right.
  //
  // The first version of this check looked for a CENTRE voice and there is
  // not one — with six voices, slots 2 and 3 straddle the middle and neither
  // is on it.  What the spread actually has to be is SYMMETRICAL, so the
  // measurement is the balance of the outer pair and of the whole set.
  const balance = (slot: number, width: number): number => {
    const r = voice({ spread: width, e1s: 1, e1a: 0.002 }, 0.8, 0.7, 45, slot);
    let l = 0; let rr = 0;
    for (let i = 0; i < r.left.length; i += 3) { l += (r.left[i] ?? 0) ** 2; rr += (r.right[i] ?? 0) ** 2; }
    return (Math.sqrt(rr) - Math.sqrt(l)) / (Math.sqrt(rr) + Math.sqrt(l) + 1e-12);
  };
  const first = balance(0, 1);
  const last = balance(5, 1);
  assert(first < -0.5, `voice 0 at full spread sits at ${first.toFixed(2)}, which is not hard left`);
  assert(last > 0.5, `voice 5 at full spread sits at ${last.toFixed(2)}, which is not hard right`);
  assert(Math.abs(first + last) < 0.1, `the outer voices are not symmetrical (${first.toFixed(2)}, ${last.toFixed(2)})`);
  let sum = 0;
  for (let s = 0; s < 6; s++) sum += balance(s, 1);
  assert(Math.abs(sum) < 0.15, `the six voices sum to ${sum.toFixed(2)} of balance, so a chord leans`);
  // And with the spread at zero every voice is in the middle — which is what
  // says the measurement above is about the spread and not about the slot.
  for (const s of [0, 3, 5]) {
    assert(Math.abs(balance(s, 0)) < 0.02, `at zero spread voice ${s} sits at ${balance(s, 0).toFixed(3)}`);
  }
  const slots = new Set([0, 1, 2, 3, 4, 5].map((s) => voiceSlot(45 + s, s * 2, 6)));
  assert(slots.size >= 3, `six notes landed on only ${slots.size} voices`);
});

// ── 4. The ladder ───────────────────────────────────────────────────────────

function ladderRun(
  k: number, comp: number, fcHz: number, f0: number, amp = 0.5, drive = 1, poles = 4,
): Float32Array {
  const L = new Ladder();
  const g = Math.tan((Math.PI * fcHz) / SR);
  const n = 24000;
  const out = new Float32Array(n);
  let ph = 0;
  const dt = f0 / SR;
  const tri = { value: 0 };
  for (let i = 0; i < n; i++) {
    out[i] = L.step(analogSample(0, ph, dt, 0.5, tri) * amp, g, k, comp, poles, drive);
    ph += dt; if (ph >= 1) ph -= 1;
  }
  return out;
}

check('the ladder loses bass as the resonance comes up, and the knob puts it back', () => {
  const at = (res: number, comp: number): number =>
    20 * Math.log10(Math.max(1e-12, tone(ladderRun(res * 4, comp, 900, 110), 110, 4000, 16384)));
  const open = at(0, 0);
  const loud = at(0.95, 0);
  assert(open - loud > 8,
    `the fundamental only fell ${(open - loud).toFixed(1)} dB between no resonance and full`);
  const compensated = at(0.95, 1);
  assert(Math.abs(compensated - at(0, 1)) < 3,
    `with the compensation up the bass still moved ${(at(0, 1) - compensated).toFixed(1)} dB`);
});

check('it self-oscillates, and below the threshold it does not', () => {
  const ring = (k: number): number => {
    const L = new Ladder();
    const g = Math.tan((Math.PI * 440) / SR);
    const n = 48000;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = L.step(i < 64 ? 0.4 : 0, g, k, 0, 4, 1);
    let peak = 0;
    for (let i = 24000; i < n; i++) peak = Math.max(peak, Math.abs(out[i] ?? 0));
    return peak;
  };
  assert(ring(3.2) < 1e-4, `at k = 3.2 the filter rings on at ${ring(3.2).toExponential(2)}`);
  assert(ring(4.2) > 0.05, `at k = 4.2 the filter does not self-oscillate (${ring(4.2).toExponential(2)})`);
  // And what it rings at is the cutoff, not something else.
  const L = new Ladder();
  const g = Math.tan((Math.PI * 440) / SR);
  const buf = new Float32Array(48000);
  for (let i = 0; i < buf.length; i++) buf[i] = L.step(i < 64 ? 0.4 : 0, g, 4.3, 0, 4, 1);
  assert(tone(buf, 440, 24000, 16384) > tone(buf, 880, 24000, 16384) * 4,
    'the self-oscillation is not at the cutoff');
});

check('it saturates, and the drive is what reaches the saturation', () => {
  const compression = (drive: number): number => {
    const quiet = ladderRun(1.2, 0, 1200, 220, 0.25, drive);
    const loud = ladderRun(1.2, 0, 1200, 220, 0.5, drive);
    return 20 * Math.log10(tone(loud, 220, 4000, 16384) / Math.max(1e-12, tone(quiet, 220, 4000, 16384)));
  };
  // A linear filter answers 6.00 dB for six decibels more in.  Measured: 5.95
  // undriven — a nonlinearity inside a negative feedback loop is linearised
  // by the loop — and 4.12 at a drive of 8, which is why the drive exists.
  assert(compression(1) > 5.5, `even undriven the filter compresses ${compression(1).toFixed(2)} dB`);
  assert(compression(8) < 5, `at a drive of 8, six decibels in gives ${compression(8).toFixed(2)} dB out`);
});

check('the slope switch changes the slope', () => {
  const fall = (poles: number): number => {
    const a = ladderRun(0.4, 0, 500, 500, 0.5, 1, poles);
    const b = ladderRun(0.4, 0, 500, 2000, 0.5, 1, poles);
    return 20 * Math.log10(tone(a, 500, 4000, 16384) / Math.max(1e-12, tone(b, 2000, 4000, 16384)));
  };
  // Two octaves above the cutoff: 24, 36 and 48 dB for 2, 3 and 4 poles, and
  // the check is that they are ORDERED and far apart rather than exact — the
  // saturation moves every one of them a little.
  assert(fall(4) > fall(3) + 6, `four poles fall ${fall(4).toFixed(1)} dB, three ${fall(3).toFixed(1)}`);
  assert(fall(3) > fall(2) + 6, `three poles fall ${fall(3).toFixed(1)} dB, two ${fall(2).toFixed(1)}`);
});

// ── 5. The envelopes are capacitors ─────────────────────────────────────────

check('the envelope is a capacitor, and the curve knob is what makes it one', () => {
  const half = (curve: number): number => analogEnv(0.5, 10, 1, 1, 0.5, 1, curve);
  assert(Math.abs(half(0) - 0.5) < 0.01, `at curve 0 the attack's midpoint is ${half(0).toFixed(3)}, not linear`);
  assert(half(1) > 0.75, `at curve 1 the attack's midpoint is only ${half(1).toFixed(3)}`);
  const decayMid = (curve: number): number => analogEnv(1.5, 10, 1, 1, 0, 1, curve);
  assert(Math.abs(decayMid(0) - 0.5) < 0.01, 'the linear decay is not linear');
  assert(decayMid(1) < 0.25, `the curved decay sits at ${decayMid(1).toFixed(3)} halfway, which is not a capacitor`);
  // Ends where an envelope has to end, at both settings.
  for (const c of [0, 0.5, 1]) {
    assert(Math.abs(analogEnv(0, 1, 0.1, 0.2, 0.5, 0.3, c)) < 1e-9, `curve ${c} does not start at zero`);
    assert(analogEnv(5, 1, 0.1, 0.2, 0.5, 0.3, c) < 1e-6, `curve ${c} never reaches silence`);
    assert(Math.abs(analogEnv(0.6, 1, 0.1, 0.2, 0.5, 0.3, c) - 0.5) < 1e-6, `curve ${c} does not hold at sustain`);
  }
});

// ── 6. Band-limited oscillators ─────────────────────────────────────────────

check('PolyBLEP is what stops the saw aliasing', () => {
  const run = (f0: number, blep: boolean): Float32Array => {
    const out = new Float32Array(16384);
    let ph = 0;
    const dt = f0 / SR;
    const tri = { value: 0 };
    for (let i = 0; i < out.length; i++) {
      out[i] = blep ? analogSample(0, ph, dt, 0.5, tri) : 2 * (ph - Math.floor(ph)) - 1;
      ph += dt; if (ph >= 1) ph -= 1;
    }
    return out;
  };
  // Differential, because at low pitches this measurement is dominated by its
  // own leakage — see `wavetable.ts`'s note, which found the same thing.
  for (const [name, midi, want] of [['C6', 84, 10], ['C7', 96, 20]] as const) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const off = junkDb(run(f0, false), f0);
    const on = junkDb(run(f0, true), f0);
    assert(off - on >= want,
      `${name}: PolyBLEP bought ${(off - on).toFixed(1)} dB (${off.toFixed(1)} → ${on.toFixed(1)}), wanted ${want}`);
  }
  assert(polyBlep(0.5, 0.01) === 0, 'the correction is applied away from the discontinuity');
  assert(polyBlep(0.001, 0.01) !== 0, 'the correction is not applied at the discontinuity');
});

check('every wave is a different wave, and the pulse width does something', () => {
  const cycle = (shape: number, width: number): Float32Array => {
    const out = new Float32Array(600);
    const tri = { value: 0 };
    let ph = 0;
    for (let i = 0; i < out.length; i++) { out[i] = analogSample(shape, ph, 1 / 300, width, tri); ph += 1 / 300; if (ph >= 1) ph -= 1; }
    return out;
  };
  for (let a = 0; a < ANALOG_SHAPES.length; a++) {
    for (let b = a + 1; b < ANALOG_SHAPES.length; b++) {
      const x = cycle(a, 0.5); const y = cycle(b, 0.5);
      let diff = 0;
      for (let i = 300; i < 600; i++) diff = Math.max(diff, Math.abs((x[i] ?? 0) - (y[i] ?? 0)));
      assert(diff > 0.15, `${ANALOG_SHAPES[a]} and ${ANALOG_SHAPES[b]} are the same wave`);
    }
  }
  const wide = cycle(1, 0.5); const narrow = cycle(1, 0.12);
  let pw = 0;
  for (let i = 300; i < 600; i++) pw = Math.max(pw, Math.abs((wide[i] ?? 0) - (narrow[i] ?? 0)));
  assert(pw > 0.5, `the pulse width moved the wave by only ${pw.toFixed(3)}`);
});

// ── The instrument ──────────────────────────────────────────────────────────

check('hard sync tears, and only when it is switched on', () => {
  const spectrum = (sync: number): number => {
    const b = voice({
      sync, o2semi: 7, o2level: 0.9, o1level: 0.9, fltMix: 0,
      cutoff: 134, res: 0, e1s: 1, e1a: 0.002, drift: 0, tolerance: 0,
    }, 1, 0.9, 45).mono;
    // Sync pins every partial to oscillator 1's pitch and piles energy up
    // around oscillator 2's, so the count of strong partials goes up.
    let strong = 0;
    const f0 = 110;
    const ref = tone(b, f0, 4000, 16384);
    for (let n = 2; n <= 24; n++) if (tone(b, n * f0, 4000, 16384) > ref * 0.1) strong += 1;
    return strong;
  };
  const off = spectrum(0);
  const on = spectrum(1);
  assert(on > off, `sync gave ${on} strong partials against ${off} without it`);
});

check('ring modulation makes something neither oscillator has', () => {
  const at = (ring: number): number => {
    const b = voice({
      ring, o1shape: 3, o2shape: 3, o2semi: 6, o1level: 0.4, o2level: 0.4,
      fltMix: 0, cutoff: 134, res: 0, e1s: 1, e1a: 0.002, drift: 0, tolerance: 0,
    }, 1, 0.9, 45).mono;
    // The sum frequency of two sines a tritone apart is at neither of them.
    const f1 = 110; const f2 = 110 * Math.pow(2, 6 / 12);
    return tone(b, f1 + f2, 4000, 16384) / Math.max(1e-12, tone(b, f1, 4000, 16384));
  };
  assert(at(0) < 0.05, `with the ring off there is already a sum tone at ${at(0).toFixed(3)}`);
  assert(at(0.9) > 0.3, `with the ring up the sum tone is only ${at(0.9).toFixed(3)} of the fundamental`);
});

check('nothing clips, nothing is silent, and the release ends', () => {
  for (const patch of patchesFor('analog')) {
    for (const pitch of [33, 45, 69]) {
      const b = voice(patch.params as Record<string, number>, 1.6, 0.9, pitch).mono;
      let peak = 0;
      for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs(b[i] ?? 0));
      assert(peak < 1.5, `${patch.id} at MIDI ${pitch} peaks at ${peak.toFixed(2)}`);
      let energy = 0;
      for (let i = Math.round(SR * 0.05); i < Math.round(SR * 0.45); i++) energy += (b[i] ?? 0) ** 2;
      assert(Math.sqrt(energy / (SR * 0.4)) > 0.0015, `${patch.id} at MIDI ${pitch} is silent`);
    }
  }
  const held = voice({ e1r: 0.4, e1s: 0.8 }, 1.8, 0.6).mono;
  const rms = (from: number, len: number): number => {
    let s = 0;
    for (let i = from; i < from + len && i < held.length; i++) s += (held[i] ?? 0) ** 2;
    return Math.sqrt(s / len);
  };
  const during = rms(Math.round(SR * 0.3), Math.round(SR * 0.2));
  const after = rms(Math.round(SR * 1.3), Math.round(SR * 0.3));
  assert(after < during * 0.01, `a second after the key lifts the note is at ${(after / during).toFixed(4)} of its level`);
  assert(analogTail({ e1r: 3, e2r: 0.1 }) > 3, 'the tail is shorter than the longest release');
});

check('a note costs less than the budget it is allowed', () => {
  // A limit, not a benchmark.  The drift and the cents-to-hertz conversion
  // were per sample at first — six `Math.sin` and two `Math.pow` per unison
  // voice per sample — and the amp envelope called `Math.exp` four times a
  // sample.  A note cost 125 ms; all three belong at the control rate.
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) voice({}, 1.4, 1.2);
  const ms = (performance.now() - t0) / 4;
  assert(ms < 70, `an ordinary 1.4-second note takes ${ms.toFixed(1)} ms`);
});

check('the instrument is registered, and its bank is balanced and distinct', () => {
  const inst = findInstrument('analog');
  assert(inst !== undefined, 'the analogue synth is not in INSTRUMENTS');
  assert(inst!.params.length > 50, `only ${inst!.params.length} parameters`);
  for (const def of inst!.params) {
    assert(def.default >= def.min && def.default <= def.max,
      `${def.id} rests at ${def.default}, outside ${def.min}…${def.max}`);
  }
  const patches = patchesFor('analog');
  assert(patches.length >= 8, `only ${patches.length} patches`);
  const seen = new Set<string>();
  for (const patch of patches) {
    const key = JSON.stringify(patch.params);
    assert(!seen.has(key), `${patch.id} is a copy of another patch`);
    seen.add(key);
    if (patch.id !== 'init') {
      assert(Object.keys(patch.params).length >= 4, `${patch.id} changes almost nothing`);
      assert(patch.note.length >= 12, `${patch.id} does not say what it is for`);
    }
  }
  // Three of them have to reach for the analogue-character knobs, or those
  // knobs are decoration.
  const character = patches.filter((p) =>
    (p.params as Record<string, number>)['drift'] !== undefined
    || (p.params as Record<string, number>)['tolerance'] !== undefined);
  assert(character.length >= 3, `only ${character.length} patches touch drift or tolerance`);

  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
  const engine = strip(readFileSync('src/renderer/daw/engine/instruments.ts', 'utf8'));
  assert(/id:\s*'analog'/.test(engine), 'INSTRUMENTS has no analog entry');
  assert(/renderAnalogVoice\s*\(/.test(engine), 'instruments.ts never calls renderAnalogVoice');
  assert(/voiceSlot\s*\(/.test(engine), 'the instrument never assigns a voice slot');
  // The hash is the only randomness in the instrument, so everything above
  // rests on it being a FUNCTION: same inputs, same answer, whatever order it
  // is asked in and whatever has been asked before.
  const table = new Map<string, number>();
  for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) table.set(`${a},${b}`, analogHash(a, b, 5));
  for (const [key, want] of [...table].reverse()) {
    const [a, b] = key.split(',').map(Number);
    assert(analogHash(a!, b!, 5) === want, `the hash gave a different answer for ${key} when asked again`);
    assert(want >= 0 && want < 1, `the hash returned ${want}, which is not in 0…1`);
  }
  assert(new Set(table.values()).size > 130, 'the hash collides far more than a hash should');
  assert(analogHash(1, 2, 3) !== analogHash(1, 2, 4), 'the third input does nothing');
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
