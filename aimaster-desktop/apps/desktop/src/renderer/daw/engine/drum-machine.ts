// The analogue drum machine's voices.
//
// A second drum instrument, and the reason there are two is worth stating
// because "another kit" would not be one.
//
// `drum-model.ts` next door is a KIT: eleven genre variants of a drum set,
// tuned to sound like drums in a room, with six controls for the whole thing.
// It answers "I need drums".  What it cannot do is the other question, which
// is most of what drum programming has been since 1980: an 808 kick is not a
// bass drum recorded badly, it is a sine wave with a pitch envelope, and its
// length, its pitch bend and its click are three knobs that belong to that
// one voice and to nothing else.
//
// So every voice here has its own controls, and every voice is built the way
// the circuit was rather than the way the drum is:
//
//   · the kick is a decaying sine whose frequency falls, plus a click
//   · the snare is two tuned heads and a band of noise, mixed by a knob
//   · the hats and cymbal are SIX SQUARE WAVES at mutually inharmonic
//     ratios through a high-pass — no noise at all, which is why an 808
//     hi-hat has a pitch and a noise-based one does not
//   · the clap is four noise bursts a few milliseconds apart and then a tail
//   · the cowbell is two squares through a band-pass
//
// ── The ratios are ours ─────────────────────────────────────────────────────
//
// The six ratios below are not the 808's.  Those are a specific set of
// resistor-determined frequencies and this is not a copy of them; these are
// chosen on the same principle — mutually inharmonic, so the sum never
// repeats and the ear hears metal instead of a chord.
//
// ── Determinism ─────────────────────────────────────────────────────────────
//
// The noise is seeded from the note, like everything else in this engine, so
// a bounce is the preview.  Two hits in a row still differ, because the seed
// carries the note's position.

import { mulberry32 } from './drum-model.js';

/** The voices, in the order the panel lays them out. */
export const DRUM_VOICES = [
  'bd', 'sd', 'cp', 'lt', 'mt', 'ht', 'ch', 'oh', 'cy', 'rs', 'cb',
] as const;

export type DrumVoice = typeof DRUM_VOICES[number];

export const DRUM_VOICE_NAMES: Readonly<Record<DrumVoice, string>> = {
  bd: 'Kick', sd: 'Snare', cp: 'Clap', lt: 'Low Tom', mt: 'Mid Tom',
  ht: 'Hi Tom', ch: 'Closed Hat', oh: 'Open Hat', cy: 'Cymbal',
  rs: 'Rim', cb: 'Cowbell',
};

/**
 * Which voice a General MIDI drum note plays.
 *
 * The machine has eleven voices and General MIDI names forty-seven pieces, so
 * this is a mapping and not a table: a drum part written for a kit has to
 * play something sensible here, and the nearest RELATIVE is what it gets —
 * every crash is the cymbal, every tom is one of three, every shaker-ish
 * piece is the closed hat.  A note outside the range takes the nearest one
 * that is mapped, for the reason `drumSpecFor` gives: silence reads as
 * "the drums are broken".
 */
export const DRUM_MAP: Readonly<Record<number, DrumVoice>> = {
  35: 'bd', 36: 'bd',
  37: 'rs', 38: 'sd', 39: 'cp', 40: 'sd',
  41: 'lt', 43: 'lt', 45: 'mt', 47: 'mt', 48: 'ht', 50: 'ht',
  42: 'ch', 44: 'ch', 46: 'oh',
  49: 'cy', 51: 'cy', 52: 'cy', 53: 'cy', 55: 'cy', 57: 'cy', 59: 'cy',
  54: 'ch', 56: 'cb', 58: 'ch',
  60: 'ht', 61: 'mt', 62: 'ht', 63: 'mt', 64: 'lt',
  70: 'ch', 75: 'rs', 76: 'cb', 77: 'cb',
};

export function drumVoiceFor(pitch: number): DrumVoice {
  const exact = DRUM_MAP[pitch];
  if (exact) return exact;
  let best: DrumVoice = 'bd';
  let bestDistance = Infinity;
  for (const key of Object.keys(DRUM_MAP)) {
    const p = Number(key);
    const d = Math.abs(p - pitch);
    if (d < bestDistance) { bestDistance = d; best = DRUM_MAP[p] ?? 'bd'; }
  }
  return best;
}

/**
 * The metal source's six ratios.
 *
 * Mutually inharmonic on purpose: no ratio here is a simple fraction of
 * another, so the six squares never line up and the sum has no period the ear
 * can find.  That absence of a period IS the sound of metal — a set of
 * harmonic ratios would give a chord, and noise would give a hiss with no
 * pitch at all.
 *
 * "Inharmonic" is measured rather than asserted.  Every one of the fifteen
 * pairwise ratios is at least 0.083 away from EVERY fraction n/d with n and d
 * up to four, which is the range an ear hears as an interval.  The first
 * version of this set was chosen by eye and one of its pairs came out 0.021
 * from a perfect fourth — close enough to hear as a chord, which is the one
 * thing a hi-hat must not be.
 */
export const METAL_RATIOS: readonly number[] = [1, 1.2, 1.7, 2.71, 3.23, 3.84];

/** A square wave at a phase in cycles, naive — see the note in `render`. */
function square(phase: number): number {
  return (phase - Math.floor(phase)) < 0.5 ? 1 : -1;
}

/** One-pole low-pass, as a coefficient from a cutoff. */
function onePole(cutoffHz: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * Math.min(cutoffHz, sr * 0.48)) / sr);
}

/** A two-pole state-variable band-pass, the cheapest one that is stable. */
class BandPass {
  private lp = 0;
  private bp = 0;

  step(x: number, f: number, q: number): number {
    const hp = x - this.lp - q * this.bp;
    this.bp += f * hp;
    this.lp += f * this.bp;
    return this.bp;
  }
}

export interface DrumRenderSpec {
  sampleRate: number;
  seconds: number;
  voice: DrumVoice;
  /** 0…1, already quantised by the caller. */
  velocity: number;
  /** A number that varies per hit, so two hits are not the same noise. */
  seed: number;
  params: Readonly<Record<string, number>>;
}

export interface DrumRender { left: Float32Array; right: Float32Array }

function p(params: Readonly<Record<string, number>>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * How long a voice rings, so the caller can size the buffer.
 *
 * Exponential envelopes never reach zero, so this is the length at which the
 * tail is 60 dB down and the render can stop without a click.
 */
export function drumTail(voice: DrumVoice, params: Readonly<Record<string, number>>): number {
  const d = p(params, `${voice}dec`, 0.3);
  const extra = voice === 'cp' ? 0.12 : 0.02;
  return Math.min(8, d * 1.25 + extra);
}

/**
 * Where each voice sits in the field, at width 1.
 *
 * A drum machine's voices came out of one mono jack, so this is a choice
 * rather than a model: kick and snare centred because everything else is
 * built around them, hats to one side and toms across, which is where a
 * listener expects them from decades of records.
 */
const VOICE_PAN: Readonly<Record<DrumVoice, number>> = {
  bd: 0, sd: 0, cp: 0.22, lt: 0.34, mt: 0.1, ht: -0.18,
  ch: -0.3, oh: -0.3, cy: -0.42, rs: -0.08, cb: 0.3,
};

export function renderDrumVoice(spec: DrumRenderSpec): DrumRender {
  const sr = spec.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.01, spec.seconds)));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const prm = spec.params;
  const v = spec.voice;

  const vel = Math.min(1, Math.max(0, spec.velocity));
  // ACCENT is how much velocity matters.  On the machines this models it was
  // one switch per step and one knob for the whole kit, which is why a 909
  // pattern has exactly two loudnesses; here it is continuous and the knob
  // decides how far apart they are.
  const accent = Math.max(0, Math.min(1, p(prm, 'accent', 0.7)));
  const velGain = 1 - accent + accent * vel;

  const master = Math.pow(2, p(prm, 'tune', 0) / 12);
  const decayScale = Math.max(0.05, p(prm, `${v}dec`, 0.3));
  const voiceLevel = Math.max(0, Math.min(1, p(prm, `${v}lvl`, 0.8)));
  const rnd = mulberry32((spec.seed | 0) ^ 0x5bf03635);

  const mono = new Float64Array(n);

  const expEnv = (i: number, seconds: number): number => Math.exp((-6.9 * i) / (sr * seconds));

  switch (v) {
    case 'bd': {
      // A sine whose frequency falls from `bend` semitones above the tuning
      // to the tuning, plus a click.  That falling sine IS an 808 kick; the
      // bridged-T circuit it came from rings and detunes as it decays, and
      // everything a kick does is in the three numbers that describe it.
      const f0 = p(prm, 'bdtune', 52) * master;
      const bend = p(prm, 'bdbend', 26);
      const bendDec = Math.max(0.002, p(prm, 'bddec', 0.5) * 0.09);
      const snap = Math.max(0, Math.min(1, p(prm, 'bdsnap', 0.4)));
      const drive = Math.max(1, p(prm, 'bddrive', 1));
      let phase = 0;
      const clickLp = onePole(3200, sr);
      let click = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const hz = f0 * Math.pow(2, (bend / 12) * Math.exp(-t / bendDec));
        phase += hz / sr;
        const body = Math.sin(2 * Math.PI * phase) * expEnv(i, decayScale);
        // The click is a short burst of filtered noise and a hard edge — it
        // is what a beater sounds like and it is the only reason a kick cuts
        // through a mix on a small speaker.
        const raw = i < sr * 0.004 ? (rnd() * 2 - 1) : 0;
        click += clickLp * (raw - click);
        mono[i] = Math.tanh((body + click * snap * 3) * drive) / Math.tanh(drive);
      }
      break;
    }
    case 'sd': {
      // Two heads and a band of noise.  The heads are what makes it a drum
      // and the noise is the snares underneath; TONE mixes them, and the two
      // ends of that knob are two different instruments.
      const f0 = p(prm, 'sdtune', 185) * master;
      const tone = Math.max(0, Math.min(1, p(prm, 'sdtone', 0.5)));
      const snappy = Math.max(0, Math.min(1, p(prm, 'sdsnappy', 0.6)));
      const noiseDec = Math.max(0.01, p(prm, 'sdsnapdec', 0.16));
      const bp = new BandPass();
      const f = 2 * Math.sin((Math.PI * Math.min(sr * 0.45, 1900 * master)) / sr);
      let a = 0;
      let b = 0;
      for (let i = 0; i < n; i++) {
        a += f0 / sr;
        b += (f0 * 1.588) / sr;
        const heads = (Math.sin(2 * Math.PI * a) * 0.7 + Math.sin(2 * Math.PI * b) * 0.3)
          * expEnv(i, decayScale * 0.6);
        const noise = bp.step(rnd() * 2 - 1, f, 0.7) * expEnv(i, noiseDec) * snappy;
        mono[i] = heads * (1 - tone) * 3.5 + noise * tone * 5.5;
      }
      break;
    }
    case 'cp': {
      // Four bursts and then the room.  A clap is several hands not quite
      // together, and the SPREAD between them is what stops it reading as a
      // short snare.
      const centre = p(prm, 'cptune', 1050) * master;
      const spread = Math.max(0.2, Math.min(3, p(prm, 'cpspread', 1)));
      const bp = new BandPass();
      const f = 2 * Math.sin((Math.PI * Math.min(sr * 0.45, centre)) / sr);
      const bursts = [0, 0.011, 0.023, 0.036].map((o) => Math.round(o * spread * sr));
      for (let i = 0; i < n; i++) {
        let gate = 0;
        for (const start of bursts) {
          if (i >= start && i < start + sr * 0.0045) gate = 1;
        }
        const tail = expEnv(i - (bursts[3] ?? 0), decayScale);
        const amount = Math.max(gate, i > (bursts[3] ?? 0) ? tail : 0);
        mono[i] = bp.step((rnd() * 2 - 1) * amount, f, 0.45) * 3.1;
      }
      break;
    }
    case 'lt': case 'mt': case 'ht': {
      const f0 = p(prm, `${v}tune`, v === 'lt' ? 95 : (v === 'mt' ? 140 : 205)) * master;
      const bend = p(prm, `${v}bend`, 8);
      const bendDec = Math.max(0.002, decayScale * 0.14);
      let phase = 0;
      const bp = new BandPass();
      const f = 2 * Math.sin((Math.PI * Math.min(sr * 0.45, 2600)) / sr);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        phase += (f0 * Math.pow(2, (bend / 12) * Math.exp(-t / bendDec))) / sr;
        const body = Math.sin(2 * Math.PI * phase) * expEnv(i, decayScale) * 0.82;
        // A little noise at the very start: the stick, without which a tom is
        // a sine and reads as a synth bass.
        const hit = i < sr * 0.006 ? bp.step(rnd() * 2 - 1, f, 0.6) * 0.9 : 0;
        mono[i] = body + hit;
      }
      break;
    }
    case 'ch': case 'oh': case 'cy': {
      // Six squares, high-passed.  No noise anywhere — which is exactly why
      // these have a PITCH, and why tuning them is a musical control rather
      // than a tone knob.
      const base = p(prm, v === 'cy' ? 'cytune' : 'chtune', v === 'cy' ? 320 : 540) * master;
      const phases = new Float64Array(METAL_RATIOS.length);
      const hpA = onePole(v === 'cy' ? 3200 : 6800, sr);
      const bp = new BandPass();
      const bf = 2 * Math.sin((Math.PI * Math.min(sr * 0.45, v === 'cy' ? 5200 : 9000)) / sr);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < METAL_RATIOS.length; k++) {
          phases[k] = (phases[k] ?? 0) + (base * (METAL_RATIOS[k] ?? 1)) / sr;
          sum += square(phases[k] ?? 0);
        }
        sum /= METAL_RATIOS.length;
        // High-pass by subtracting a low-pass, then a band-pass to put the
        // peak where a cymbal's is.
        lp += hpA * (sum - lp);
        const hp = sum - lp;
        mono[i] = bp.step(hp, bf, 0.9) * expEnv(i, decayScale) * 4;
      }
      break;
    }
    case 'rs': {
      // An impulse through a resonator: a rim shot is a short ring and
      // nothing else.
      //
      // The damping follows the Decay knob rather than being fixed, and that
      // is not a refinement — with a fixed Q the resonator died in about four
      // milliseconds whatever the knob said, so the knob moved the hit from
      // 11 ms to 15 ms across its whole range and was effectively dead.  On
      // the circuit this models the decay IS the resonator's Q, so tying them
      // together is both the fix and the more honest model.
      const f0 = p(prm, 'rstune', 1650) * master;
      const bp = new BandPass();
      const f = 2 * Math.sin((Math.PI * Math.min(sr * 0.45, f0)) / sr);
      const q = Math.max(0.0015, Math.min(1.2, 2 / (decayScale * 2 * Math.PI * f0)));
      for (let i = 0; i < n; i++) {
        const x = i < 2 ? 1 : 0;
        mono[i] = bp.step(x + (i < sr * 0.001 ? (rnd() * 2 - 1) * 0.4 : 0), f, q)
          * expEnv(i, decayScale) * 3.3;
      }
      break;
    }
    default: {
      // Cowbell: two squares a fifth-and-a-bit apart through a band-pass.
      const f0 = p(prm, 'cbtune', 545) * master;
      let a = 0;
      let b = 0;
      const bp = new BandPass();
      const f = 2 * Math.sin((Math.PI * Math.min(sr * 0.45, f0 * 2.1)) / sr);
      for (let i = 0; i < n; i++) {
        a += f0 / sr;
        b += (f0 * 1.4816) / sr;
        mono[i] = bp.step((square(a) + square(b)) * 0.5, f, 0.28) * expEnv(i, decayScale) * 0.85;
      }
      break;
    }
  }

  const width = Math.max(0, Math.min(1, p(prm, 'width', 0.6)));
  const pan = Math.max(-1, Math.min(1, (VOICE_PAN[v] ?? 0) * width));
  const angle = ((pan + 1) * Math.PI) / 4;
  // Equal power, and √2 back, so panning a voice does not change how loud it
  // is — the same arithmetic every other instrument here uses.
  const gl = Math.cos(angle) * Math.SQRT2 * velGain * voiceLevel;
  const gr = Math.sin(angle) * Math.SQRT2 * velGain * voiceLevel;
  for (let i = 0; i < n; i++) {
    const s = mono[i] ?? 0;
    left[i] = s * gl;
    right[i] = s * gr;
  }
  return { left, right };
}
