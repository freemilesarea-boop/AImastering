// Instruments — the sound sources MIDI parts play through.
//
// One VOICE per note, which is what makes per-note expression work: MPE and
// MIDI 2.0 address a single sounding note, so pitch bend, pressure and timbre
// are scheduled on that voice's own oscillator and filter rather than on a
// shared channel.  A channel-wide synth could not represent it.
//
// Native WebAudio nodes only — same rule as the insert plugins, so a MIDI
// part renders identically in an offline bounce.

import {
  curveValueAt, findExpression, pitchToFrequency, soundingPitch,
  type MidiNote, type MidiPartConfig,
} from '../model/midi.js';
import { pluckedString } from './string-model.js';

export interface InstrumentParamDef {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit: string;
}

export interface VoiceContext {
  ctx: BaseAudioContext;
  destination: AudioNode;
  note: MidiNote;
  config: MidiPartConfig;
  /** Context time the note starts. */
  when: number;
  /**
   * How long the note sounds, in seconds.
   *
   * Passed in rather than read off the note: the note's length is in beats,
   * and across a tempo ramp its length in seconds is a measurement only the
   * caller's tempo map can make.
   */
  durationSec: number;
  params: Record<string, number>;
}

export interface InstrumentDescriptor {
  id: string;
  name: string;
  params: InstrumentParamDef[];
  /** Build and schedule one voice.  Returns its nodes for cleanup. */
  playNote: (voice: VoiceContext) => { stop: (at: number) => void };
}

/** Points at which per-note curves are sampled when scheduling. */
const CURVE_STEPS = 24;

/**
 * Schedule a per-note expression curve onto an AudioParam.
 *
 * The curve lives in the note's own time frame, so it is resampled onto
 * absolute context time here.  Sampling (rather than emitting a breakpoint
 * per source point) keeps the schedule bounded no matter how dense the
 * incoming MPE data is.
 */
function scheduleCurve(
  param: AudioParam,
  note: MidiNote,
  target: Parameters<typeof findExpression>[1],
  when: number,
  durationSec: number,
  map: (normalized: number) => number,
  fallback: number,
): void {
  const curve = findExpression(note, target);
  const base = map(fallback);
  param.setValueAtTime(base, Math.max(0, when));
  if (!curve || curve.points.length === 0) return;

  // Two axes: the curve is read in the note's BEATS, and written at the
  // seconds those beats fall on.  Walking both by the same fraction keeps
  // them lined up without a tempo map in here — the note is one span, and
  // a fraction of it is the same fraction on either axis.
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const fraction = i / CURVE_STEPS;
    const value = map(curveValueAt(curve.points, note.durationBeat * fraction, fallback));
    param.linearRampToValueAtTime(value, Math.max(0, when + durationSec * fraction));
  }
}

function adsr(
  param: AudioParam, when: number, durationSec: number,
  attack: number, decay: number, sustain: number, release: number, peak: number,
): number {
  const start = Math.max(0, when);
  const attackEnd = start + Math.max(0.001, attack);
  const decayEnd = attackEnd + Math.max(0.001, decay);
  const noteEnd = start + Math.max(0.02, durationSec);
  param.setValueAtTime(0.0001, start);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), attackEnd);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak * sustain), Math.min(decayEnd, noteEnd));
  param.setValueAtTime(Math.max(0.0002, peak * sustain), Math.max(noteEnd, decayEnd));
  const releaseEnd = noteEnd + Math.max(0.01, release);
  param.exponentialRampToValueAtTime(0.0001, releaseEnd);
  return releaseEnd;
}


/**
 * The string for one note, as a buffer the graph can play.
 *
 * Cached on everything that changes the samples, because a strummed part asks
 * for the same string dozens of times and computing it is the expensive part.
 * The Float32Array is what is cached rather than the AudioBuffer: a buffer
 * belongs to the context that made it, and the offline bounce runs in a
 * different one.
 */
const STRING_CACHE = new Map<string, Float32Array>();
const STRING_CACHE_MAX = 240;

function stringBuffer(
  ctx: BaseAudioContext, freq: number, seconds: number,
  damping: number, brightness: number, pickPosition: number, seed: number,
): AudioBuffer {
  const key = [
    freq.toFixed(3), ctx.sampleRate, seconds.toFixed(2),
    damping.toFixed(5), brightness.toFixed(3), pickPosition.toFixed(3), seed,
  ].join('|');
  let samples = STRING_CACHE.get(key);
  if (!samples) {
    samples = pluckedString({
      freqHz: freq, sampleRate: ctx.sampleRate, seconds,
      damping, brightness, pickPosition, seed,
    });
    if (STRING_CACHE.size >= STRING_CACHE_MAX) {
      // Oldest out.  A Map keeps insertion order, so this is the first key.
      const oldest = STRING_CACHE.keys().next().value;
      if (oldest !== undefined) STRING_CACHE.delete(oldest);
    }
    STRING_CACHE.set(key, samples);
  }
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  // Written through the channel rather than `copyToChannel`: the cached array
  // is typed over ArrayBufferLike, and copyToChannel wants one backed by a
  // plain ArrayBuffer.  Same bytes either way.
  buf.getChannelData(0).set(samples);
  return buf;
}

/**
 * The seed for one note.
 *
 * A function of the note, never of the clock: the same part has to render the
 * same way every time (see `string-model.ts`).  Pitch and start beat are what
 * make one pluck different from its neighbour, which is also true of a real
 * player, so this reads as variation rather than as noise.
 */
function noteSeed(note: MidiNote): number {
  const pitch = Math.round(soundingPitch(note));
  const beat = Math.round(note.startBeat * 96);
  return ((pitch * 2654435761) ^ (beat * 40503) ^ 0x9E3779B9) >>> 0;
}

/** One plucked-string voice, shared by the two guitars. */
function pluckVoice(
  v: VoiceContext,
  tuning: { damping: number; brightness: number; pick: number; bodyHz: number; bodyQ: number; toneHz: number },
): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const freq = pitchToFrequency(soundingPitch(note));
  const level = (params['level'] ?? 0.3) * (0.25 + 0.75 * note.velocity);

  // How long the string is allowed to ring, independent of the note's length:
  // a plucked string does not stop when the key is released, it decays.  The
  // amp envelope below is what ends it.
  const ring = Math.min(8, Math.max(0.35, (params['sustain'] ?? 2.4)));
  const src = ctx.createBufferSource();
  src.buffer = stringBuffer(
    ctx, freq, ring,
    tuning.damping, tuning.brightness, tuning.pick, noteSeed(note),
  );

  // The body (or the pickup): a resonance and a roll-off.  This is what makes
  // the same string a guitar rather than a synth pluck.
  const body = ctx.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.value = tuning.bodyHz;
  body.Q.value = tuning.bodyQ;
  body.gain.value = params['body'] ?? 4;

  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = Math.max(400, params['tone'] ?? tuning.toneHz);
  tone.Q.value = 0.7;

  const amp = ctx.createGain();

  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );

  src.connect(body).connect(tone).connect(amp).connect(destination);

  // A plucked string has no sustain stage — it decays from the moment it is
  // hit.  The envelope's job is only to open cleanly and to close when the
  // note ends, without a click.
  const start = Math.max(0, when);
  const releaseSec = Math.min(1.2, Math.max(0.03, params['release'] ?? 0.14));
  const noteEnd = start + Math.max(0.02, durationSec);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), start + 0.003);
  amp.gain.setValueAtTime(Math.max(0.0002, level), Math.max(start + 0.004, noteEnd));
  const releaseEnd = noteEnd + releaseSec;
  amp.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

  src.start(start);
  src.stop(releaseEnd + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try { src.disconnect(); body.disconnect(); tone.disconnect(); amp.disconnect(); }
      catch { /* ignore */ }
    },
  };
}

export const INSTRUMENTS: InstrumentDescriptor[] = [
  {
    id: 'polysynth',
    name: 'Poly Synth',
    params: [
      { id: 'attack',   name: 'Attack',  min: 0.001, max: 2,    default: 0.008, unit: 's' },
      { id: 'decay',    name: 'Decay',   min: 0.01,  max: 3,    default: 0.18,  unit: 's' },
      { id: 'sustain',  name: 'Sustain', min: 0,     max: 1,    default: 0.65,  unit: '' },
      { id: 'release',  name: 'Release', min: 0.01,  max: 4,    default: 0.22,  unit: 's' },
      { id: 'cutoffHz', name: 'Cutoff',  min: 200,   max: 12000, default: 2800, unit: 'Hz' },
      { id: 'resonance', name: 'Reso',   min: 0.1,   max: 12,   default: 1.2,   unit: '' },
      { id: 'detune',   name: 'Detune',  min: 0,     max: 40,   default: 8,     unit: 'ct' },
      { id: 'level',    name: 'Level',   min: 0,     max: 1,    default: 0.22,  unit: '' },
    ],
    playNote: ({ ctx, destination, note, config, when, durationSec, params }) => {
      const freq = pitchToFrequency(soundingPitch(note));
      const detune = params['detune'] ?? 8;

      const amp = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = params['resonance'] ?? 1.2;

      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      oscA.type = 'sawtooth';
      oscB.type = 'sawtooth';
      oscA.frequency.value = freq;
      oscB.frequency.value = freq;
      oscA.detune.value = -detune;
      oscB.detune.value = detune;

      // Per-note pitch bend → this voice's detune, in cents.
      const bendCents = (normalized: number): number => normalized * config.bendRangeSemitones * 100;
      scheduleCurve(oscA.detune, note, { kind: 'pitchBend' }, when, durationSec, (v) => bendCents(v) - detune, 0);
      scheduleCurve(oscB.detune, note, { kind: 'pitchBend' }, when, durationSec, (v) => bendCents(v) + detune, 0);

      // Pressure and timbre open the filter — the two expressive dimensions
      // an MPE controller sends continuously.
      const baseCutoff = params['cutoffHz'] ?? 2800;
      const velocityCutoff = baseCutoff * (0.45 + 0.85 * note.velocity);
      scheduleCurve(
        filter.frequency, note, { kind: 'timbre' }, when, durationSec,
        (v) => Math.min(18_000, velocityCutoff * (0.6 + 1.6 * v)), 0.5,
      );
      scheduleCurve(
        amp.gain, note, { kind: 'pressure' }, when, durationSec,
        () => 1, 1,
      );

      oscA.connect(filter);
      oscB.connect(filter);
      filter.connect(amp).connect(destination);

      const peak = (params['level'] ?? 0.22) * (0.25 + 0.75 * note.velocity);
      const releaseEnd = adsr(
        amp.gain, when, durationSec,
        params['attack'] ?? 0.008, params['decay'] ?? 0.18,
        params['sustain'] ?? 0.65, params['release'] ?? 0.22, peak,
      );

      oscA.start(Math.max(0, when));
      oscB.start(Math.max(0, when));
      oscA.stop(releaseEnd + 0.02);
      oscB.stop(releaseEnd + 0.02);

      return {
        stop: (at: number) => {
          try { oscA.stop(at); oscB.stop(at); } catch { /* already stopped */ }
          try { oscA.disconnect(); oscB.disconnect(); filter.disconnect(); amp.disconnect(); }
          catch { /* ignore */ }
        },
      };
    },
  },

  {
    id: 'epiano',
    name: 'Rhodes (FM)',
    // The parameters that were here keep their ids and defaults, so a session
    // saved before this rebuild opens sounding the same shape.  The ones added
    // below are what turn a 2-operator FM tone into a Rhodes.
    params: [
      { id: 'ratio',    name: 'Ratio',    min: 0.5,  max: 8,   default: 3,    unit: '×' },
      { id: 'index',    name: 'Index',    min: 0,    max: 12,  default: 3.2,  unit: '' },
      { id: 'decay',    name: 'Decay',    min: 0.1,  max: 6,   default: 1.6,  unit: 's' },
      { id: 'release',  name: 'Release',  min: 0.02, max: 3,   default: 0.35, unit: 's' },
      { id: 'level',    name: 'Level',    min: 0,    max: 1,   default: 0.25, unit: '' },
      { id: 'bark',     name: 'Bark',     min: 0,    max: 1,   default: 0.7,  unit: '' },
      { id: 'tine',     name: 'Tine',     min: 0,    max: 1,   default: 0.5,  unit: '' },
      { id: 'pickup',   name: 'Pickup',   min: 0,    max: 1,   default: 0.35, unit: '' },
      { id: 'tremRate', name: 'Trem Rate', min: 0,   max: 10,  default: 0,    unit: 'Hz' },
      { id: 'tremDepth', name: 'Trem',    min: 0,    max: 1,   default: 0.35, unit: '' },
    ],
    playNote: ({ ctx, destination, note, config, when, durationSec, params }) => {
      const freq = pitchToFrequency(soundingPitch(note));
      const start = Math.max(0, when);
      const carrier = ctx.createOscillator();
      const modulator = ctx.createOscillator();
      const modGain = ctx.createGain();
      const amp = ctx.createGain();

      carrier.type = 'sine';
      modulator.type = 'sine';
      carrier.frequency.value = freq;
      modulator.frequency.value = freq * (params['ratio'] ?? 3);

      // ── The bark ────────────────────────────────────────────────────────
      // What makes a Rhodes a Rhodes rather than a sine with an envelope: hit
      // it hard and the tine barks, bright and metallic, and that brightness
      // dies away in a couple of hundred milliseconds while the body note
      // rings on.  So the FM index is steered by velocity and given its OWN
      // fast decay, separate from the amplitude's.  A fixed index gives you
      // an electric piano that plays every dynamic with the same face.
      const bark = params['bark'] ?? 0.7;
      const vel = note.velocity;
      const index = (params['index'] ?? 3.2) * (1 - bark + bark * (0.15 + 1.55 * vel * vel));
      const barkDecay = 0.08 + 0.32 * (1 - bark);
      modGain.gain.setValueAtTime(freq * index, start);
      modGain.gain.exponentialRampToValueAtTime(
        Math.max(0.01, freq * index * 0.06), start + barkDecay,
      );
      modGain.gain.exponentialRampToValueAtTime(
        Math.max(0.005, freq * index * 0.02),
        start + Math.max(barkDecay + 0.05, params['decay'] ?? 1.6),
      );

      // ── The tine ────────────────────────────────────────────────────────
      // The physical strike on the metal tine — a short, high, inharmonic
      // ping that is gone before the note has settled.  It is most of what
      // you hear in the first 30 ms and it is why a Rhodes cuts through.
      const tineAmount = params['tine'] ?? 0.5;
      let tine: OscillatorNode | null = null;
      let tineGain: GainNode | null = null;
      if (tineAmount > 0.001) {
        tine = ctx.createOscillator();
        tineGain = ctx.createGain();
        tine.type = 'triangle';
        // Deliberately not a harmonic of the note: a struck bar is not a
        // string, and its overtone sits where it likes.
        tine.frequency.value = Math.min(12000, freq * 6.7);
        const tinePeak = 0.09 * tineAmount * (0.2 + 0.8 * vel);
        tineGain.gain.setValueAtTime(Math.max(0.0002, tinePeak), start);
        tineGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.055);
        tine.connect(tineGain).connect(amp);
        tine.start(start);
        tine.stop(start + 0.09);
      }

      // ── The pickup ──────────────────────────────────────────────────────
      // A Rhodes is heard through an electromagnetic pickup facing the tine,
      // and it does not sit centred: the waveform is asymmetric, which adds
      // EVEN harmonics.  That asymmetry is the growl, and a symmetric
      // waveshaper would remove exactly the thing being modelled.
      const pickupAmount = params['pickup'] ?? 0.35;
      let shaper: WaveShaperNode | null = null;
      if (pickupAmount > 0.001) {
        shaper = ctx.createWaveShaper();
        const N = 1024;
        const curve = new Float32Array(N);
        const k = 1 + 4 * pickupAmount;
        for (let i = 0; i < N; i++) {
          const x = (i / (N - 1)) * 2 - 1;
          // Asymmetric: the positive half is compressed harder than the
          // negative one.
          const bias = x >= 0 ? k : k * 0.55;
          curve[i] = Math.tanh(x * bias) / Math.tanh(bias);
        }
        shaper.curve = curve;
        shaper.oversample = '2x';
      }

      scheduleCurve(
        carrier.detune, note, { kind: 'pitchBend' }, when, durationSec,
        (val) => val * config.bendRangeSemitones * 100, 0,
      );

      modulator.connect(modGain);
      modGain.connect(carrier.frequency);
      carrier.connect(amp);

      // ── Tremolo ─────────────────────────────────────────────────────────
      // Off by default, because a suitcase Rhodes' tremolo is a choice and
      // not a property of the instrument.  It is amplitude, applied after
      // everything else so it moves the whole voice.
      const tremRate = params['tremRate'] ?? 0;
      const out = ctx.createGain();
      let lfo: OscillatorNode | null = null;
      let lfoGain: GainNode | null = null;
      if (tremRate > 0.01) {
        const depth = Math.min(1, Math.max(0, params['tremDepth'] ?? 0.35));
        lfo = ctx.createOscillator();
        lfoGain = ctx.createGain();
        lfo.type = 'sine';
        lfo.frequency.value = tremRate;
        lfoGain.gain.value = depth * 0.5;
        out.gain.value = 1 - depth * 0.5;
        lfo.connect(lfoGain).connect(out.gain);
        lfo.start(start);
      }

      const tail = shaper ? amp.connect(shaper) : amp;
      (tail as AudioNode).connect(out).connect(destination);

      const peak = (params['level'] ?? 0.25) * (0.2 + 0.8 * vel);
      const releaseEnd = adsr(
        amp.gain, when, durationSec,
        0.004, params['decay'] ?? 1.6, 0.35, params['release'] ?? 0.35, peak,
      );

      carrier.start(start);
      modulator.start(start);
      carrier.stop(releaseEnd + 0.02);
      modulator.stop(releaseEnd + 0.02);
      if (lfo) lfo.stop(releaseEnd + 0.02);

      return {
        stop: (at: number) => {
          try {
            carrier.stop(at); modulator.stop(at);
            if (tine) tine.stop(at);
            if (lfo) lfo.stop(at);
          } catch { /* already stopped */ }
          try {
            carrier.disconnect(); modulator.disconnect(); modGain.disconnect();
            amp.disconnect(); out.disconnect();
            if (tineGain) tineGain.disconnect();
            if (tine) tine.disconnect();
            if (shaper) shaper.disconnect();
            if (lfoGain) lfoGain.disconnect();
            if (lfo) lfo.disconnect();
          } catch { /* ignore */ }
        },
      };
    },
  },

  {
    id: 'agtr',
    name: 'Acoustic Guitar',
    params: [
      { id: 'tone',    name: 'Tone',    min: 800, max: 16000, default: 7000, unit: 'Hz' },
      { id: 'body',    name: 'Body',    min: -6,  max: 12,    default: 5,    unit: 'dB' },
      { id: 'pick',    name: 'Pick',    min: 0.02, max: 0.5,  default: 0.14, unit: '' },
      { id: 'sustain', name: 'Sustain', min: 0.4, max: 8,     default: 3,    unit: 's' },
      { id: 'release', name: 'Release', min: 0.03, max: 1.2,  default: 0.18, unit: 's' },
      { id: 'level',   name: 'Level',   min: 0,   max: 1,     default: 0.32, unit: '' },
    ],
    // A steel-string body: the big air resonance sits near 100 Hz and the
    // top plate around 200.  Bright, and it loses its highs quickly, which
    // is the difference between an acoustic and an amplified string.
    playNote: (v) => pluckVoice(v, {
      damping: 0.9955, brightness: 0.85,
      pick: v.params['pick'] ?? 0.14,
      bodyHz: 110, bodyQ: 1.1, toneHz: 7000,
    }),
  },

  {
    id: 'egtr',
    name: 'Electric Guitar',
    params: [
      { id: 'tone',    name: 'Tone',    min: 800, max: 12000, default: 3400, unit: 'Hz' },
      { id: 'body',    name: 'Pickup',  min: -6,  max: 12,    default: 6,    unit: 'dB' },
      { id: 'pick',    name: 'Pick',    min: 0.02, max: 0.5,  default: 0.09, unit: '' },
      { id: 'sustain', name: 'Sustain', min: 0.4, max: 8,     default: 5,    unit: 's' },
      { id: 'release', name: 'Release', min: 0.03, max: 1.2,  default: 0.1,  unit: 's' },
      { id: 'level',   name: 'Level',   min: 0,   max: 1,     default: 0.3,  unit: '' },
    ],
    // Rings far longer than the acoustic — an electric's string is not asked
    // to move any air, so it keeps its energy — and the pickup's resonance
    // near 2.5 kHz is the honk everyone recognises.  Plucked closer to the
    // bridge, which is where a pickup is.
    //
    // No amp here on purpose.  The insert chain already has `tube`,
    // `saturation`, `clipper` and `spring`, and an amp baked into the
    // instrument would be one you could never change.
    playNote: (v) => pluckVoice(v, {
      damping: 0.9987, brightness: 0.7,
      pick: v.params['pick'] ?? 0.09,
      bodyHz: 2500, bodyQ: 1.6, toneHz: 3400,
    }),
  },
];

export function findInstrument(id: string | null): InstrumentDescriptor | undefined {
  return id ? INSTRUMENTS.find((i) => i.id === id) : undefined;
}

export function defaultInstrumentParams(id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of findInstrument(id)?.params ?? []) out[p.id] = p.default;
  return out;
}
