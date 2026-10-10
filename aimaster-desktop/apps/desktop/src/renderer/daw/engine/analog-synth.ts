// The analogue synth's voice.
//
// A deliberately DIFFERENT instrument from the wavetable one next to it, and
// not only in sound.  The wavetable synth has a hundred and thirteen
// parameters and an eight-row matrix because that is what a wavetable synth
// is for: anything can drive anything.  An analogue synth is the opposite
// argument — a fixed, opinionated signal path with every useful routing
// already wired, which is why a Minimoog has no matrix and is still the one
// everybody can play.  So the modulation here is a short list of named
// depths (LFO to pitch, LFO to pulse width, envelope to filter, velocity to
// filter) rather than a grid, and that is a design choice rather than a
// smaller version of the other synth.
//
// What makes it sound analogue is in `analog-model.ts`, with the measurement
// behind each claim.  What is here is how those pieces are wired.
//
// ── The determinism problem, and what is honestly lost ──────────────────────
//
// Free-running oscillators and drifting VCOs are RANDOM on real hardware:
// the same note twice is genuinely two different sounds.  This engine's
// standing rule is that an offline bounce is bit-identical to the preview,
// so that randomness has to be a function of the note instead — the phase a
// note starts at and the drift it carries are hashed from its pitch and its
// position in the bar.
//
// The consequence, stated rather than hidden: two notes of the same pitch at
// DIFFERENT places in a part are different, which is most of the effect, and
// the same note rendered twice is identical, which a real synth's would not
// be.  A performance still never repeats itself; a loop does.

import { CALIBRATED_LEVEL, INSTRUMENT_TRIM } from './instrument-level.js';
import {
  Ladder, analogEnv, analogHash, analogSample, driftCents, voiceTolerance,
} from './analog-model.js';
import { lfoValue } from './mod-matrix.js';

/** Control rate, as in the wavetable synth and for the same reason. */
const CONTROL_STRIDE = 16;

export interface AnalogRenderSpec {
  sampleRate: number;
  seconds: number;
  gateSec: number;
  freqHz: number;
  pitch: number;
  velocity: number;
  /** Which of the synth's voices this note landed on — see `voiceSlot`. */
  slot: number;
  /** Where the note sits in the part, for the free-running phase. */
  startBeat: number;
  params: Readonly<Record<string, number>>;
  beatsPerSec: number;
}

function p(params: Readonly<Record<string, number>>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Which voice a note is played by.
 *
 * A real allocator is round-robin, and round-robin needs state that survives
 * between notes — which this engine does not have, because each note is
 * scheduled on its own.  Hashing the note distributes them across the voices
 * the same way without carrying anything.
 *
 * What it does NOT reproduce, said plainly: a real synth's next note steals a
 * SPECIFIC voice, usually the oldest, so a fast line walks the voices in
 * order.  Here it walks them in a fixed but arbitrary order.  The audible
 * effect — consecutive notes going through different hardware — is the same;
 * which hardware is not.
 */
export function voiceSlot(pitch: number, startBeat: number, voices: number): number {
  const n = Math.max(1, Math.round(voices));
  return Math.floor(analogHash(pitch, Math.round(startBeat * 96), 1234) * n) % n;
}

export interface AnalogRender { left: Float32Array; right: Float32Array }

export function renderAnalogVoice(spec: AnalogRenderSpec): AnalogRender {
  const sr = spec.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.01, spec.seconds)));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const prm = spec.params;
  const vel = Math.min(1, Math.max(0, spec.velocity));

  // ── Component tolerance: this voice's own hardware ──────────────────────
  const spread = Math.max(0, Math.min(0.2, p(prm, 'tolerance', 0.03)));
  const tolCut = voiceTolerance(spec.slot, spread, 0);
  const tolAmp = voiceTolerance(spec.slot, spread * 0.5, 1);
  const tolEnv = voiceTolerance(spec.slot, spread * 0.6, 2);
  const tolRes = voiceTolerance(spec.slot, spread * 0.4, 3);

  const curve = Math.max(0, Math.min(1, p(prm, 'envCurve', 0.85)));
  const env1 = {
    a: Math.max(0.0005, p(prm, 'e1a', 0.004)) * tolEnv,
    d: Math.max(0.002, p(prm, 'e1d', 0.4)) * tolEnv,
    s: Math.max(0, Math.min(1, p(prm, 'e1s', 0.7))),
    r: Math.max(0.002, p(prm, 'e1r', 0.25)) * tolEnv,
  };
  const env2 = {
    a: Math.max(0.0005, p(prm, 'e2a', 0.01)),
    d: Math.max(0.002, p(prm, 'e2d', 0.5)),
    s: Math.max(0, Math.min(1, p(prm, 'e2s', 0.2))),
    r: Math.max(0.002, p(prm, 'e2r', 0.3)),
  };

  const lfos = [1, 2].map((i) => {
    const synced = p(prm, `l${i}sync`, 0) > 0.5;
    const beats = Math.max(0.0625, p(prm, `l${i}beats`, 1));
    return {
      rate: synced ? spec.beatsPerSec / beats : Math.max(0.01, p(prm, `l${i}rate`, i === 1 ? 5 : 0.6)),
      shape: p(prm, `l${i}shape`, 0),
      delay: Math.max(0, p(prm, `l${i}delay`, 0)),
      phase: analogHash(spec.pitch, i, 9),   // free-running, like the oscillators
    };
  });

  const voices = Math.max(1, Math.min(8, Math.round(p(prm, 'voices', 6))));
  const unison = Math.max(1, Math.min(5, Math.round(p(prm, 'unison', 1))));
  const detune = Math.max(0, p(prm, 'detune', 8));
  const width = Math.max(0, Math.min(1, p(prm, 'spread', 0.5)));
  const driftDepth = Math.max(0, p(prm, 'drift', 3.5));

  interface Osc {
    shape: number; width: number; cents: number; level: number;
    phases: Float64Array; tri: Array<{ value: number }>; driftSeed: number[];
  }
  const makeOsc = (tag: 'o1' | 'o2'): Osc => {
    const phases = new Float64Array(unison);
    const tri: Array<{ value: number }> = [];
    const driftSeed: number[] = [];
    for (let v = 0; v < unison; v++) {
      // FREE-RUNNING: the phase comes from where the note is, not from zero.
      phases[v] = analogHash(spec.pitch, Math.round(spec.startBeat * 96), v * 31 + (tag === 'o1' ? 5 : 17));
      tri.push({ value: 0 });
      driftSeed.push((spec.pitch * 7 + v * 13 + (tag === 'o1' ? 0 : 101)) | 0);
    }
    return {
      shape: p(prm, `${tag}shape`, tag === 'o1' ? 0 : 0),
      width: Math.max(0.05, Math.min(0.95, p(prm, `${tag}width`, 0.5))),
      cents: Math.round(p(prm, `${tag}oct`, 0)) * 1200 + Math.round(p(prm, `${tag}semi`, 0)) * 100
        + p(prm, `${tag}fine`, tag === 'o1' ? 0 : 6),
      level: Math.max(0, p(prm, `${tag}level`, tag === 'o1' ? 0.8 : 0.5)),
      phases, tri, driftSeed,
    };
  };
  const o1 = makeOsc('o1');
  const o2 = makeOsc('o2');
  const sync = p(prm, 'sync', 0) > 0.5;
  const ring = Math.max(0, Math.min(1, p(prm, 'ring', 0)));

  const subLevel = Math.max(0, p(prm, 'subLevel', 0));
  const subOct = Math.round(p(prm, 'subOct', -1));
  let subPhase = analogHash(spec.pitch, 3, 55);
  const noiseLevel = Math.max(0, p(prm, 'noise', 0));
  let noiseSeed = (spec.pitch * 2654435761) >>> 0 || 1;

  const ladder = new Ladder();
  const poles = Math.max(2, Math.min(4, Math.round(p(prm, 'poles', 4))));
  const comp = Math.max(0, Math.min(1, p(prm, 'fltComp', 0)));
  const drive = Math.max(0.2, p(prm, 'drive', 1));
  const keyTrack = Math.max(0, Math.min(1, p(prm, 'fltKey', 0.3)));
  const baseCut = p(prm, 'cutoff', 92);
  const envAmt = p(prm, 'envAmt', 24);
  const velFlt = p(prm, 'velFlt', 12);
  const velAmp = Math.max(0, Math.min(1, p(prm, 'velAmp', 0.7)));
  const res = Math.max(0, Math.min(1, p(prm, 'res', 0.2))) * tolRes;

  const lfoDepth = {
    pitch1: p(prm, 'l1pitch', 0), pw1: p(prm, 'l1pw', 0),
    flt1: p(prm, 'l1flt', 0), amp1: p(prm, 'l1amp', 0),
    pitch2: p(prm, 'l2pitch', 0), flt2: p(prm, 'l2flt', 0),
  };

  // ── Per-sample state, refreshed once per control block ──────────────────
  //
  // The drift and the cents-to-hertz conversion were per SAMPLE at first, and
  // that is six `Math.sin` and two `Math.pow` for every unison voice on every
  // sample: a note cost 125 ms.  Neither can move faster than the control
  // rate — the drift's fastest component is half a hertz — so both live here
  // and the phase increments walk between blocks.
  const dt1 = new Float64Array(unison);
  const dt2 = new Float64Array(unison);
  const sDt1 = new Float64Array(unison);
  const sDt2 = new Float64Array(unison);

  // Walking values, refreshed per control block.
  let g = 0; let sG = 0;
  let k = 0; let sK = 0;
  let pw1 = 0; let sPw1 = 0;
  let pw2 = 0; let sPw2 = 0;
  let c1 = 0; let sC1 = 0;
  let c2 = 0; let sC2 = 0;
  let ampMod = 1; let sAmp = 0;
  // The amp envelope walks too.  It is a capacitor curve, so evaluating it
  // per sample means up to four `Math.exp` calls per sample — which measured
  // as most of the instrument's cost.  Nothing about an envelope moves faster
  // than the control rate: the shortest attack the knob offers is half a
  // millisecond and a control block is a third of one.
  let ampEnv = 0; let sAmpEnv = 0;

  const lfoAt = (i: number, t: number): number => {
    const l = lfos[i]!;
    const active = t - l.delay;
    if (active < 0) return 0;
    return lfoValue(l.shape, l.phase + active * l.rate, 0.5, Math.round(spec.pitch) + i * 11);
  };

  const settle = (t: number, samples: number, first: boolean): void => {
    const e2 = analogEnv(t, spec.gateSec, env2.a, env2.d, env2.s, env2.r, curve);
    const a1 = lfoAt(0, t);
    const a2 = lfoAt(1, t);
    const cutSemis = baseCut * tolCut
      + keyTrack * (spec.pitch - 60)
      + envAmt * e2
      + velFlt * vel
      + lfoDepth.flt1 * a1 + lfoDepth.flt2 * a2;
    const fc = Math.min(sr * 0.45, Math.max(20, 8.1758 * Math.pow(2, cutSemis / 12)));
    const tG = Math.tan(Math.PI * (fc / sr));
    const tK = 4 * Math.min(0.999, Math.max(0, res));
    const tPw1 = Math.max(0.05, Math.min(0.95, o1.width + lfoDepth.pw1 * a1 * 0.45));
    const tPw2 = Math.max(0.05, Math.min(0.95, o2.width + lfoDepth.pw1 * a1 * 0.45));
    const bend = lfoDepth.pitch1 * a1 + lfoDepth.pitch2 * a2;
    const tC1 = o1.cents + bend;
    const tC2 = o2.cents + bend;
    const tAmp = 1 + lfoDepth.amp1 * a1 * 0.5;
    const tEnv = analogEnv(t, spec.gateSec, env1.a, env1.d, env1.s, env1.r, curve);

    for (let v = 0; v < unison; v++) {
      const spreadC = unison === 1 ? 0 : (v / (unison - 1) - 0.5) * 2 * detune;
      const d1 = driftCents(t, driftDepth, o1.driftSeed[v] ?? 0);
      const d2 = driftCents(t, driftDepth, o2.driftSeed[v] ?? 0);
      const f1 = spec.freqHz * Math.pow(2, (tC1 + spreadC + d1) / 1200);
      const f2 = spec.freqHz * Math.pow(2, (tC2 - spreadC + d2) / 1200);
      if (first) { dt1[v] = f1 / sr; dt2[v] = f2 / sr; } else {
        sDt1[v] = (f1 / sr - (dt1[v] ?? 0)) / samples;
        sDt2[v] = (f2 / sr - (dt2[v] ?? 0)) / samples;
      }
    }

    if (first) {
      g = tG; k = tK; pw1 = tPw1; pw2 = tPw2; c1 = tC1; c2 = tC2;
      ampMod = tAmp; ampEnv = tEnv;
      return;
    }
    const inv = 1 / samples;
    sG = (tG - g) * inv; sK = (tK - k) * inv;
    sPw1 = (tPw1 - pw1) * inv; sPw2 = (tPw2 - pw2) * inv;
    sC1 = (tC1 - c1) * inv; sC2 = (tC2 - c2) * inv;
    sAmp = (tAmp - ampMod) * inv;
    sAmpEnv = (tEnv - ampEnv) * inv;
  };
  settle(0, 1, true);

  const level = (p(prm, 'level', CALIBRATED_LEVEL) * INSTRUMENT_TRIM.analog)
    * (1 - velAmp + velAmp * vel) * tolAmp;
  const normU = 1 / Math.sqrt(unison);

  // ── Where this voice sits, and why that is the only stereo there is ──────
  //
  // A voice on an analogue poly is MONO end to end: one oscillator pair, one
  // filter, one VCA.  A Prophet-5's output is a mono jack, and the stereo
  // everybody associates with these instruments comes from a chorus after
  // them.  So panning the unison oscillators before a mono filter, which is
  // what this did first, is not a model of anything — the filter sums them
  // back and the measurement said so: the side channel came out at −231 dB.
  //
  // What DOES spread a chord is the voices being in different places, which
  // is what a stereo pair in front of a poly picks up and what the voice-
  // spread switch on the ones that have it does.  So the slot decides the
  // pan, and `spread` is how wide the voices are thrown.  A single held note
  // is mono, as it should be; a chord is wide, as it should be.
  const slotPan = voices <= 1
    ? 0
    : ((spec.slot / (voices - 1)) - 0.5) * 2 * width;
  const panL = Math.cos((slotPan + 1) * Math.PI / 4) * Math.SQRT2;
  const panR = Math.sin((slotPan + 1) * Math.PI / 4) * Math.SQRT2;

  for (let i = 0; i < n; i++) {
    if (i % CONTROL_STRIDE === 0) {
      const remaining = Math.min(CONTROL_STRIDE, n - i);
      settle((i + remaining) / sr, remaining, false);
    }
    let sum = 0;
    let ringA = 0; let ringB = 0;
    for (let v = 0; v < unison; v++) {
      const inc1 = dt1[v] ?? 0;
      const inc2 = dt2[v] ?? 0;

      const before = o1.phases[v] ?? 0;
      const s1 = analogSample(o1.shape, before, inc1, pw1, o1.tri[v]!);
      let ph1 = before + inc1;
      const wrapped = ph1 >= 1;
      if (wrapped) ph1 -= Math.floor(ph1);
      o1.phases[v] = ph1;

      let ph2 = (o2.phases[v] ?? 0);
      const s2 = analogSample(o2.shape, ph2, inc2, pw2, o2.tri[v]!);
      // HARD SYNC: oscillator 2 is restarted every time oscillator 1 wraps.
      // That is what makes the classic tearing sound, and it is a property of
      // the OSCILLATORS rather than a filter setting — the harmonic peak sits
      // at oscillator 2's own frequency while the pitch follows oscillator 1.
      ph2 = sync && wrapped ? 0 : ph2 + inc2;
      if (ph2 >= 1) ph2 -= Math.floor(ph2);
      o2.phases[v] = ph2;

      const a = s1 * o1.level;
      const b = s2 * o2.level;
      ringA += a; ringB += b;
      sum += a + b;

      dt1[v] = inc1 + (sDt1[v] ?? 0);
      dt2[v] = inc2 + (sDt2[v] ?? 0);
    }
    sum *= normU;
    if (ring > 0.001) sum += ringA * ringB * normU * normU * ring * 2;

    let common = 0;
    if (subLevel > 1e-6) {
      common += (subPhase < 0.5 ? 1 : -1) * subLevel;
      subPhase += (spec.freqHz * Math.pow(2, subOct)) / sr;
      if (subPhase >= 1) subPhase -= Math.floor(subPhase);
    }
    if (noiseLevel > 1e-6) {
      noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) >>> 0;
      common += ((noiseSeed / 2147483648) - 1) * noiseLevel;
    }
    // One ladder on the mono voice, then the voice is placed.  That order is
    // the hardware's and it is the reason a resonant sweep stays in one spot
    // in the picture rather than smearing across it.
    const filtered = ladder.step(sum + common, g, k, comp, poles, drive);
    const amp = ampEnv * Math.max(0, ampMod) * level;
    const value = filtered * amp;
    left[i] = value * panL;
    right[i] = value * panR;

    g += sG; k += sK; pw1 += sPw1; pw2 += sPw2; c1 += sC1; c2 += sC2;
    ampMod += sAmp; ampEnv += sAmpEnv;
  }
  return { left, right };
}

/** Seconds a voice needs after the key lifts. */
export function analogTail(params: Readonly<Record<string, number>>): number {
  return Math.min(12, Math.max(p(params, 'e1r', 0.25), p(params, 'e2r', 0.3)) + 0.02);
}

export { CONTROL_STRIDE };
