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
    name: 'E-Piano (FM)',
    params: [
      { id: 'ratio',   name: 'Ratio',   min: 0.5, max: 8,  default: 3,    unit: '×' },
      { id: 'index',   name: 'Index',   min: 0,   max: 12, default: 3.2,  unit: '' },
      { id: 'decay',   name: 'Decay',   min: 0.1, max: 6,  default: 1.6,  unit: 's' },
      { id: 'release', name: 'Release', min: 0.02, max: 3, default: 0.35, unit: 's' },
      { id: 'level',   name: 'Level',   min: 0,   max: 1,  default: 0.25, unit: '' },
    ],
    playNote: ({ ctx, destination, note, config, when, durationSec, params }) => {
      const freq = pitchToFrequency(soundingPitch(note));
      const carrier = ctx.createOscillator();
      const modulator = ctx.createOscillator();
      const modGain = ctx.createGain();
      const amp = ctx.createGain();

      carrier.type = 'sine';
      modulator.type = 'sine';
      carrier.frequency.value = freq;
      modulator.frequency.value = freq * (params['ratio'] ?? 3);

      const index = (params['index'] ?? 3.2) * (0.3 + 0.7 * note.velocity);
      modGain.gain.setValueAtTime(freq * index, Math.max(0, when));
      modGain.gain.exponentialRampToValueAtTime(
        Math.max(0.01, freq * index * 0.05),
        Math.max(0.01, when + (params['decay'] ?? 1.6)),
      );

      scheduleCurve(
        carrier.detune, note, { kind: 'pitchBend' }, when, durationSec,
        (v) => v * config.bendRangeSemitones * 100, 0,
      );

      modulator.connect(modGain);
      modGain.connect(carrier.frequency);
      carrier.connect(amp).connect(destination);

      const peak = (params['level'] ?? 0.25) * (0.2 + 0.8 * note.velocity);
      const releaseEnd = adsr(
        amp.gain, when, durationSec,
        0.004, params['decay'] ?? 1.6, 0.35, params['release'] ?? 0.35, peak,
      );

      carrier.start(Math.max(0, when));
      modulator.start(Math.max(0, when));
      carrier.stop(releaseEnd + 0.02);
      modulator.stop(releaseEnd + 0.02);

      return {
        stop: (at: number) => {
          try { carrier.stop(at); modulator.stop(at); } catch { /* already stopped */ }
          try { carrier.disconnect(); modulator.disconnect(); modGain.disconnect(); amp.disconnect(); }
          catch { /* ignore */ }
        },
      };
    },
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
