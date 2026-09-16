// The FM synth's voice.
//
// Six operators, one pass per sample from op 6 down to op 1, and that order
// is load-bearing: every algorithm's connections run from a higher-numbered
// operator to a lower one (see `FM_ALGORITHMS`), so a modulator's value for
// THIS sample already exists when the operator it feeds asks for it.  The
// only backwards path is the feedback operator reading its own last two
// outputs, which is deliberate and is the one place a delay belongs.
//
// ── What is different from the two synths next door ─────────────────────────
//
// The wavetable synth and the analogue synth are both subtractive: make a
// rich wave, take things away.  Their panels are about the filter because the
// filter is where their sound is decided.  There is no filter here at all.
// An FM patch's brightness is its modulator ENVELOPES — the index rises and
// the sidebands appear — which is why every operator gets its own envelope
// and why those envelopes are exponential.
//
// ── What it costs ───────────────────────────────────────────────────────────
//
// A four-second six-operator note at 48 kHz, measured, best of twelve:
//
//     first version                 178 ms
//     sine from a table              138
//     `fmEnv` without its closure     88
//     pan gains precomputed,
//       dead operators skipped        61
//
// The closure was the surprise and is worth remembering: `fmEnv` built a
// small helper arrow function on every call, and 72 000 calls of it cost more
// than the six operators' entire render loop.
//
// 61 ms is about sixty times faster than real time and roughly twice what the
// analogue synth next door costs.  That is not a mystery — six operators is
// six oscillators plus their envelopes plus their routing, where the analogue
// synth has two and a filter — and it is stated here rather than rounded off.
//
// ── Determinism ─────────────────────────────────────────────────────────────
//
// Every operator starts at phase 0 on every note, which is what an FM
// instrument does and is the reason its attacks are so consistent.  Nothing
// here is random; the noise wave is a hash of the cycle number.

import { CALIBRATED_LEVEL, INSTRUMENT_TRIM } from './instrument-level.js';
import {
  FM_CONTROL_STRIDE, FM_FEEDBACK_SCALE, FM_MOD_SCALE, FM_OPERATORS,
  algorithmAt, feedbackTap, fmEnv, fmSine, fmWave, keyScale, modulatorsOf,
} from './fm-core.js';
import { lfoValue } from './mod-matrix.js';

export interface FmRenderSpec {
  sampleRate: number;
  seconds: number;
  gateSec: number;
  freqHz: number;
  pitch: number;
  velocity: number;
  params: Readonly<Record<string, number>>;
  beatsPerSec: number;
}

export interface FmRender { left: Float32Array; right: Float32Array }

function p(params: Readonly<Record<string, number>>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * How long the note rings after the key lifts.
 *
 * The longest CARRIER release decides it, and the modulators do not: a
 * modulator still running after its carrier has closed is moving a phase
 * nobody is listening to.  Taking the longest of all six would have made
 * every patch with a slow modulator render a tail of silence.
 */
export function fmTail(params: Readonly<Record<string, number>>): number {
  const alg = algorithmAt(p(params, 'algo', 0));
  let longest = 0.05;
  for (const c of alg.carriers) longest = Math.max(longest, p(params, `o${c + 1}r`, 0.3));
  return longest + 0.05;
}

/** Most voices one note may stack.  Three is already eighteen operators. */
const MAX_UNISON = 3;

/**
 * Where each unison voice starts.
 *
 * Not evenly spaced, for the reason the poly synth's comment gives at length:
 * n copies at phases k/n cancel every harmonic that is not a multiple of n.
 * These are the first three terms of the golden-ratio low-discrepancy
 * sequence, which behave like random phases without being random.
 */
const UNISON_PHASE = [0, 0.618034, 0.236068];

export function renderFmVoice(spec: FmRenderSpec): FmRender {
  const sr = spec.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.01, spec.seconds)));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const prm = spec.params;
  const vel = Math.min(1, Math.max(0, spec.velocity));
  const gate = Math.max(0.001, spec.gateSec);

  const alg = algorithmAt(p(prm, 'algo', 0));
  const carriers = alg.carriers;

  // The modulator lists, flattened.  `modList` holds every modulator index
  // back to back and `modAt[i]`/`modEnd[i]` say which slice belongs to
  // operator i.  An array of arrays was the first version and walking it with
  // `for…of` allocated an iterator per operator per sample.
  const byOp = modulatorsOf(alg);
  const modAt = new Int32Array(FM_OPERATORS);
  const modEnd = new Int32Array(FM_OPERATORS);
  const flat: number[] = [];
  for (let i = 0; i < FM_OPERATORS; i++) {
    modAt[i] = flat.length;
    for (const m of byOp[i] ?? []) flat.push(m);
    modEnd[i] = flat.length;
  }
  const modList = Int32Array.from(flat);

  // ── Per-operator settings, read once ────────────────────────────────────
  const ratio = new Float64Array(FM_OPERATORS);
  const fixedHz = new Float64Array(FM_OPERATORS);
  const isFixed = new Uint8Array(FM_OPERATORS);
  const waveOf = new Uint8Array(FM_OPERATORS);
  const outLevel = new Float64Array(FM_OPERATORS);
  const envA = new Float64Array(FM_OPERATORS);
  const envD = new Float64Array(FM_OPERATORS);
  const envS = new Float64Array(FM_OPERATORS);
  const envR = new Float64Array(FM_OPERATORS);

  for (let i = 0; i < FM_OPERATORS; i++) {
    const o = `o${i + 1}`;
    ratio[i] = Math.max(0.0625, p(prm, `${o}ratio`, 1));
    fixedHz[i] = Math.max(0.5, p(prm, `${o}hz`, 440));
    isFixed[i] = p(prm, `${o}fixed`, 0) > 0.5 ? 1 : 0;
    waveOf[i] = Math.round(p(prm, `${o}wave`, 0));
    envA[i] = Math.max(0, p(prm, `${o}a`, 0.005));
    envD[i] = Math.max(0, p(prm, `${o}d`, 0.5));
    envS[i] = Math.max(0, Math.min(1, p(prm, `${o}s`, 0.8)));
    envR[i] = Math.max(0.001, p(prm, `${o}r`, 0.3));

    // Level, velocity sensitivity and key scaling all multiply into one
    // number because none of them changes during the note.  Velocity on a
    // MODULATOR is what makes an FM patch get brighter when you hit it
    // harder — the thing a sampled instrument can only fake with layers.
    const base = Math.max(0, Math.min(1, p(prm, `${o}level`, i === 0 ? 1 : 0.5)));
    const velAmt = Math.max(0, Math.min(1, p(prm, `${o}vel`, 0.4)));
    const velGain = 1 - velAmt + velAmt * vel;
    outLevel[i] = base * velGain * keyScale(spec.pitch, p(prm, `${o}key`, 0));
  }

  const fbOp = Math.max(0, Math.min(FM_OPERATORS - 1, Math.round(p(prm, 'fbOp', 6) - 1)));
  const fbAmount = Math.max(0, Math.min(1, p(prm, 'feedback', 0))) * FM_FEEDBACK_SCALE;

  // ── The pitch envelope ──────────────────────────────────────────────────
  // A short pitch sweep at the start of the note.  It is what gives an FM
  // bass its click and an FM brass its lip attack, and it is one of the few
  // things here that is not an operator setting.
  const pAmt = p(prm, 'pAmt', 0);
  const pAtk = Math.max(0.0005, p(prm, 'pAtk', 0.002));
  const pDec = Math.max(0.001, p(prm, 'pDec', 0.06));

  // ── The LFO ─────────────────────────────────────────────────────────────
  const lfoShape = p(prm, 'lfoShape', 0);
  const lfoSync = p(prm, 'lfoSync', 0) > 0.5;
  const lfoHz = lfoSync
    ? spec.beatsPerSec / Math.max(0.0625, p(prm, 'lfoBeats', 1))
    : Math.max(0.01, p(prm, 'lfoRate', 5));
  const lfoDelay = Math.max(0, p(prm, 'lfoDelay', 0));
  const lfoPitch = Math.max(0, p(prm, 'lfoPitch', 0));
  const lfoAmp = Math.max(0, Math.min(1, p(prm, 'lfoAmp', 0)));

  const unison = Math.max(1, Math.min(MAX_UNISON, Math.round(p(prm, 'unison', 1))));
  const detune = Math.max(0, p(prm, 'detune', 6));
  const width = Math.max(0, Math.min(1, p(prm, 'width', 0.3)));
  const spread = Math.max(0, Math.min(1, p(prm, 'spread', 0)));
  const transpose = p(prm, 'transpose', 0);

  // ── Where each carrier sits in the field ────────────────────────────────
  // A carrier is a separate source with its own spectrum, so spreading them
  // is a real stereo image and not a widener.  With ONE carrier there is
  // nothing to spread and this does nothing, which the panel says.
  const carrierPan = new Float64Array(FM_OPERATORS);
  if (carriers.length > 1) {
    carriers.forEach((c, i) => {
      carrierPan[c] = ((i / (carriers.length - 1)) * 2 - 1) * spread;
    });
  }

  const baseFreq = spec.freqHz * Math.pow(2, transpose / 12);

  // Running state, per unison voice per operator.
  const phase = new Float64Array(unison * FM_OPERATORS);
  // One slot per unison voice, not one per operator: only the feedback
  // operator has a history and only it reads one.
  const prev1 = new Float64Array(unison * FM_OPERATORS);
  const prev2 = new Float64Array(unison * FM_OPERATORS);
  for (let v = 0; v < unison; v++) {
    for (let i = 0; i < FM_OPERATORS; i++) phase[v * FM_OPERATORS + i] = UNISON_PHASE[v] ?? 0;
  }

  // Control-rate values, recomputed every FM_CONTROL_STRIDE samples.
  const env = new Float64Array(FM_OPERATORS);
  const step = new Float64Array(unison * FM_OPERATORS);
  let ampMod = 1;

  // Incoherent sources sum as the square root of their count — dividing by
  // the count instead would make Unison a volume knob that gets quieter as
  // it gets wider, which this repository has already caught once.
  const voiceGain = 1 / Math.sqrt(unison);
  const trim = INSTRUMENT_TRIM['fm'] ?? 1;
  const level = Math.max(0, Math.min(1, p(prm, 'level', CALIBRATED_LEVEL)));
  const outGain = trim * level * voiceGain;

  const out = new Float64Array(FM_OPERATORS);

  // ── Which operators are worth computing ─────────────────────────────────
  // An operator at level 0 contributes nothing as a carrier and nothing as a
  // modulator — its output is multiplied by zero either way — so it can be
  // skipped exactly rather than approximately.  Most patches use three or
  // four of the six, and a three-operator patch now costs three operators.
  // Still in descending order, because that order is what makes a modulator's
  // value for this sample already exist when its carrier asks.
  const activeList: number[] = [];
  for (let i = FM_OPERATORS - 1; i >= 0; i--) if ((outLevel[i] ?? 0) > 0) activeList.push(i);
  const active = Int32Array.from(activeList);
  const live = new Uint8Array(FM_OPERATORS);
  for (const i of activeList) live[i] = 1;

  const carrierList = Int32Array.from(carriers);
  const carrierN = carrierList.length;
  const hasFeedback = fbAmount > 0 && (outLevel[fbOp] ?? 0) > 0;

  // Whether every operator that will run is a plain sine.
  //
  // It usually is — seven of the eight waves exist to be reached for
  // deliberately, and a patch that uses one uses it on one operator.  When
  // they all are, the render loop below calls `fmSine` directly instead of
  // `fmWave`: the difference is not the switch statement but the call, which
  // cannot be inlined while its first argument varies.
  //
  // Measured on the additive algorithm, where all six operators run and all
  // six are sines: 52 ms without this branch and 46 with it.  On the default
  // three-carrier patch it is worth about a millisecond, which is why the
  // measurement is written down rather than the intention.
  let allSine = true;
  for (let a = 0; a < active.length; a++) if ((waveOf[active[a] ?? 0] ?? 0) !== 0) allSine = false;

  // ── Pan gains, worked out once ──────────────────────────────────────────
  // Equal power, so moving a carrier across the field does not change how
  // loud it is, and √2 gives back what dividing one signal between two
  // channels takes away.  These were two `Math.cos` calls per carrier per
  // unison voice per SAMPLE in the first version — six trigonometric calls a
  // sample on a three-carrier patch, which cost more than the operators did.
  const panL = new Float64Array(unison * FM_OPERATORS);
  const panR = new Float64Array(unison * FM_OPERATORS);
  for (let v = 0; v < unison; v++) {
    const voicePan = unison === 1 ? 0 : ((v / (unison - 1)) * 2 - 1) * width;
    for (const c of carriers) {
      const clamped = Math.max(-1, Math.min(1, (carrierPan[c] ?? 0) + voicePan));
      const a = ((clamped + 1) * Math.PI) / 4;
      panL[v * FM_OPERATORS + c] = Math.cos(a) * Math.SQRT2;
      panR[v * FM_OPERATORS + c] = Math.sin(a) * Math.SQRT2;
    }
  }

  const dt = 1 / sr;
  let t = 0;
  let tick = 0;
  for (let s = 0; s < n; s++, t += dt) {
    if (tick === 0) {
      tick = FM_CONTROL_STRIDE;
      for (let i = 0; i < FM_OPERATORS; i++) {
        env[i] = fmEnv(t, gate, envA[i] ?? 0, envD[i] ?? 0, envS[i] ?? 0, envR[i] ?? 0)
          * (outLevel[i] ?? 0);
      }
      // The LFO rises over `lfoDelay` rather than switching on, because a
      // vibrato that starts with the note is a synthesiser and one that
      // arrives is a player.
      const rise = lfoDelay <= 0 ? 1 : Math.min(1, t / lfoDelay);
      const l = lfoValue(lfoShape, t * lfoHz, 0.5, 0) * rise;
      ampMod = 1 - lfoAmp * 0.5 * (1 - l);
      const pitchEnvCents = pAmt === 0
        ? 0
        : pAmt * 100 * (t < pAtk
          ? t / pAtk
          : Math.exp((-4.6 * (t - pAtk)) / pDec));
      const vibratoCents = l * lfoPitch;

      for (let v = 0; v < unison; v++) {
        const off = unison === 1 ? 0 : ((v / (unison - 1)) * 2 - 1) * detune;
        const f = baseFreq * Math.pow(2, (pitchEnvCents + vibratoCents + off) / 1200);
        for (let i = 0; i < FM_OPERATORS; i++) {
          const hz = isFixed[i] ? (fixedHz[i] ?? 440) : f * (ratio[i] ?? 1);
          step[v * FM_OPERATORS + i] = hz * dt;
        }
      }
    }
    tick--;

    let sumL = 0;
    let sumR = 0;
    for (let v = 0; v < unison; v++) {
      const b = v * FM_OPERATORS;
      // Down from 6 to 1: a modulator is always already computed.
      for (let i = FM_OPERATORS - 1; i >= 0; i--) {
        if ((live[i] ?? 0) === 0) continue;
        let mod = 0;
        const to = modEnd[i] ?? 0;
        for (let k = modAt[i] ?? 0; k < to; k++) mod += (out[modList[k] ?? 0] ?? 0) * FM_MOD_SCALE;
        if (hasFeedback && i === fbOp) {
          mod += feedbackTap(prev1[b] ?? 0, prev2[b] ?? 0) * fbAmount;
        }
        const ph = (phase[b + i] ?? 0) + mod;
        const value = (allSine ? fmSine(ph) : fmWave(waveOf[i] ?? 0, ph, i * 7919))
          * (env[i] ?? 0);
        out[i] = value;
        // Only the feedback operator's history is kept.  Keeping all six was
        // two typed-array writes per operator per sample — 2.3 million of
        // them in a four-second note — for a value five of them never read.
        if (hasFeedback && i === fbOp) {
          prev2[b] = prev1[b] ?? 0;
          prev1[b] = value;
        }
        phase[b + i] = (phase[b + i] ?? 0) + (step[b + i] ?? 0);
      }
      for (let k = 0; k < carrierN; k++) {
        const c = carrierList[k] ?? 0;
        const value = out[c] ?? 0;
        sumL += value * (panL[b + c] ?? 0);
        sumR += value * (panR[b + c] ?? 0);
      }
    }
    left[s] = sumL * outGain * ampMod;
    right[s] = sumR * outGain * ampMod;
  }

  return { left, right };
}
