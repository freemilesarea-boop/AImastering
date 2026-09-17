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
  INSTRUMENT_TRIM, CALIBRATED_LEVEL,
} from './instrument-level.js';
import {
  curveValueAt, findExpression, pitchToFrequency, soundingPitch,
  type MidiNote, type MidiPartConfig,
} from '../model/midi.js';
import { pluckedString } from './string-model.js';
import {
  inharmonicity, renderModes, ringSeconds, stringsForPitch, struckString,
} from './struck-string.js';
import { BAR_KINDS, barModes, barProfile } from './bar-model.js';
import { WAVETABLES } from './wavetable.js';
import { LFO_SHAPES, MATRIX_ROWS, MOD_DESTS, MOD_SOURCES, noteRandom, rowParams } from './mod-matrix.js';
import { SUB_SHAPES, renderVoice, tailSeconds } from './wave-synth.js';
import { ANALOG_SHAPES } from './analog-model.js';
import { BUTTERWORTH_Q } from './plugin-kit.js';
import { analogTail, renderAnalogVoice, voiceSlot } from './analog-synth.js';
import { FM_ALGORITHMS, FM_OPERATORS, FM_WAVES } from './fm-core.js';
import { fmTail, renderFmVoice } from './fm-synth.js';
import {
  BOWED_PARAMS, BOWED_PARAM_IDS, bowedTail, renderBowedVoice,
} from './bowed-string.js';
import {
  DRUM_MAX_DECAY, drumTail, drumVoiceFor, renderDrumVoice,
} from './drum-machine.js';
import {
  CLAP_OFFSETS, noiseSamples, type DrumSpec,
} from './drum-model.js';
import { drumSpecIn, kitGenreOf } from './drum-presets.js';
import { bufferFor, loadedLibrary } from './sample-library.js';
import { pickZone, playbackRateFor, zonesFor } from './sampler.js';

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

/**
 * How hard the Rhodes' pickup waveshaper is driven, at full velocity.
 *
 * Was the instrument's old default Level, which is where its voicing was
 * judged; kept as a constant so that moving Level past the waveshaper (see
 * the epiano voice) changed the instrument's loudness and not its character.
 */
const EPIANO_PICKUP_DRIVE = 0.25;

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

/**
 * The round robin's position.
 *
 * Module-level on purpose: it has to survive between notes, and it must NOT
 * be per-voice — a counter created with the voice is always zero, which picks
 * take one every time and defeats the entire mechanism.
 */
let roundRobinCount = 0;
function nextRoundRobin(): number { return roundRobinCount++; }

// ── The kit ─────────────────────────────────────────────────────────────────

/**
 * Noise, as an AudioBuffer, cached per context and seed.
 *
 * One second is longer than any noise voice here needs, so every hit reads a
 * different window of the same buffer rather than allocating its own — a
 * sixteenth-note hat pattern is 8 hits a second, and building a fresh
 * Float32Array for each of them is work the audio thread does not need.
 */
const NOISE_CACHE = new Map<string, AudioBuffer>();
const NOISE_SECONDS = 2;

function noiseBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const key = `${ctx.sampleRate}|${seed}`;
  const hit = NOISE_CACHE.get(key);
  if (hit) return hit;
  const length = Math.round(ctx.sampleRate * NOISE_SECONDS);
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  // Written through the channel rather than `copyToChannel`, for the same
  // reason `stringBuffer` does: the array is typed over ArrayBufferLike.
  buf.getChannelData(0).set(noiseSamples(length, seed));
  if (NOISE_CACHE.size >= 8) {
    const oldest = NOISE_CACHE.keys().next().value;
    if (oldest !== undefined) NOISE_CACHE.delete(oldest);
  }
  NOISE_CACHE.set(key, buf);
  return buf;
}

/**
 * A percussive amplitude envelope: instant on, exponential off.
 *
 * Every piece of a kit has this shape and nothing else — there is no sustain
 * and no release, because a drum does not care when the key came up.  The
 * note's LENGTH is therefore ignored on purpose: a kick written as a whole
 * note and a kick written as a sixteenth are the same kick, which is what
 * every drum machine and every sampler does, and what a drummer does.
 */
function hit(gain: GainNode, when: number, peak: number, decay: number): number {
  const end = when + decay;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.0015);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  return end;
}

/** A pitched drum: a sine that falls.  Kick and toms are the same voice. */
function drumTone(
  ctx: BaseAudioContext, out: AudioNode, spec: DrumSpec,
  when: number, peak: number, decay: number, tune: number,
  /** How hard the stick arrived, 0…1 — how much of the sweep it earns. */
  strike = 1,
): number {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const base = spec.hz * tune;
  // The sweep IS the drum.  Held at a constant frequency the same oscillator
  // is a bass note; the fast fall from a few times the fundamental is the
  // beater arriving.
  //
  // And how FAR it falls from is how hard it was hit.  A head struck harder
  // stretches further and its pitch starts higher — which is why a soft tom
  // is not a quiet loud tom, and why scaling this with velocity is the
  // difference between a kit and a sampler with one sample per drum.
  osc.frequency.setValueAtTime(base * (1 + (spec.sweep - 1) * strike), when);
  osc.frequency.exponentialRampToValueAtTime(base, when + Math.min(0.09, decay * 0.35));
  const gain = ctx.createGain();
  const end = hit(gain, when, peak, decay);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(end + 0.02);
  return end;
}

/**
 * Filtered noise, which is the other half of every kit.
 *
 * `q` means two different things depending on `filterType`, because Web Audio
 * does: on the bandpasses here (the rim at 6, the clap at 1.4) it is a
 * cookbook Q, and on the highpasses (0.5 to 0.8) it is a resonance in
 * DECIBELS.  Each caller's number was chosen against the sound the node
 * actually made, so they are left as they are rather than converted — see
 * `BUTTERWORTH_Q` for the unit, and the ceiling below for a number that WAS
 * meant to be Butterworth and now is.
 */
function drumNoise(
  ctx: BaseAudioContext, out: AudioNode, seed: number,
  when: number, peak: number, decay: number,
  filterType: BiquadFilterType, cutoff: number, q: number,
  airHz = 18000,
): number {
  const nyquist = ctx.sampleRate / 2 - 100;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, seed);
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = Math.max(20, Math.min(nyquist, cutoff));
  filter.Q.value = q;
  // The ceiling.  Every voice here is highpassed, so `tone` can only make a
  // kit brighter or leave it alone — a dark kit needs a lowpass of its own,
  // which is a thing a measurement found rather than a thing anyone noticed.
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = Math.max(200, Math.min(nyquist, airHz));
  air.Q.value = BUTTERWORTH_Q;
  const gain = ctx.createGain();
  const end = hit(gain, when, peak, decay);
  src.connect(filter).connect(air).connect(gain).connect(out);
  // Each hit reads a different window of the shared buffer, so two hats in a
  // row are not bit-identical — which is what a real pair of hats is.
  //
  // And it LOOPS, because a source that starts 1.35 s into a 2 s buffer stops
  // 0.65 s later whatever its envelope says.  Measured: a crash with a 1.6 s
  // decay went silent at 0.67 s, and the reading was easy to misdiagnose as
  // the decay being too short — the envelope was fine, the audio ran out.
  src.loop = true;
  src.start(when, (seed % 1000) / 1000 * (NOISE_SECONDS - 0.6));
  src.stop(end + 0.02);
  return end;
}

/**
 * One drum, built from its spec.
 *
 * The families differ in WHICH of the two generators above they use and how
 * many, not in kind — which is why a kit this small can cover a GM map.
 */
function drumVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, when, params } = v;
  // Which KIT, then which piece.  The kit is a number in `instrumentParams`
  // so it survives save, undo, freeze and the offline bounce without any of
  // them being taught what a kit is.
  const spec = drumSpecIn(kitGenreOf(params['kit']), Math.round(soundingPitch(note)));

  // How hard the stick arrived.  Measured before this existed: normalised
  // for level, a tom hit at a quarter velocity and at full velocity were the
  // same spectrum to within 0.032 — velocity was a volume knob and nothing
  // else.  A real head struck softly puts less energy into its high
  // partials, so what velocity moves here is the BRIGHTNESS ceiling and the
  // depth of the pitch sweep, not only the amplitude.
  const strike = 0.35 + 0.65 * note.velocity;

  // And no two hits are the same hit.  The kick was bit-identical every
  // time — a spectral distance of 0.000 between two strikes — which is
  // correct for a drum machine and wrong for every acoustic kit here.  The
  // wobble is derived from the note, so a part still renders identically
  // every time it is rendered; it is variation, not randomness.
  const wobble = (((noteSeed(note) >>> 9) % 2000) / 1000) - 1;

  // Pitch moves least of the three on purpose: one of these kits is an 808
  // whose kick IS the bass line, and detuning that would be a wrong note
  // rather than a livelier drum.  0.5% is four cents.
  const tune = Math.pow(2, (params['tune'] ?? 0) / 12) * (1 + wobble * 0.005);
  const decayScale = Math.max(0.1, params['decay'] ?? 1) * (1 + wobble * 0.06);
  const toneScale = Math.max(0.25, params['tone'] ?? 1);
  const snap = Math.max(0, Math.min(1, params['snap'] ?? 0.5)) * (1 + wobble * 0.12);
  // `tone` moves the ceiling as well as the floor, so one knob still darkens
  // or opens the whole kit.
  // The ceiling follows the stick: 45% of the way open at the softest hit
  // and all the way at the hardest.
  const air = spec.air * toneScale * (0.45 + 0.55 * strike);
  // Velocity on a drum is dynamics, not a trim: a ghost note is a different
  // sound from a rimshot, so it moves the level a long way.
  const level = (params['level'] ?? CALIBRATED_LEVEL) * INSTRUMENT_TRIM.drumkit
    * spec.level * (0.08 + 0.92 * Math.pow(note.velocity, 1.4));
  // Tried and dropped: scaling this with velocity too.  "Less energy in is
  // less time to get out" is true of a real cymbal, and measuring it made
  // five of the six pieces LESS different between a soft hit and a hard one,
  // not more — a shorter tail moves the balance back toward the body the
  // hard hit already has.  The hypothesis was reasonable and the numbers
  // said no.
  const decay = spec.decay * decayScale;
  const seed = noteSeed(note);

  // A master gain in front of the panner exists only so a stop can FADE.
  // The other instruments disconnect on stop, which is instant and therefore
  // clicks; a kit is the one instrument where that would be heard on every
  // transport stop, because something is always still ringing.
  const master = ctx.createGain();
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-1, Math.min(1, spec.pan));
  master.connect(pan).connect(destination);

  let end = when + 0.05;
  const later = (t: number): void => { end = Math.max(end, t); };

  switch (spec.family) {
    case 'kick':
      later(drumTone(ctx, master, spec, when, level, decay, tune, strike));
      // The click: a beater on a head, not part of the tone.
      // The beater click needs the energy to exist at all: it is most of
      // what separates a thump from a kick, and a brush stroke has none.
      later(drumNoise(ctx, master, seed, when, level * 0.30 * snap * strike, 0.012,
        'highpass', 1800 * toneScale, 0.7, air));
      break;

    case 'tom':
      later(drumTone(ctx, master, spec, when, level, decay, tune, strike));
      later(drumNoise(ctx, master, seed, when, level * 0.16 * snap, 0.03,
        'bandpass', 900 * toneScale, 1.2, air));
      break;

    case 'snare':
      // Two bodies a fifth apart, then the wires.  The wires are most of what
      // you hear and all of what makes it a snare rather than a small tom.
      later(drumTone(ctx, master, spec, when, level * 0.45, decay * 0.55, tune, strike));
      later(drumTone(ctx, master, { ...spec, hz: spec.hz * 1.48, sweep: 1.2 },
        when, level * 0.28, decay * 0.42, tune, strike));
      // The wires need to be driven.  A ghost note is a dull thud with
      // barely any rattle in it, and a rimshot is almost all rattle — the
      // ceiling alone never reached this, because a snare's wires sit well
      // below it and it measured 0.057 against a kick's 0.115.  They never
      // vanish, because a snare with the wires off is a tom.
      later(drumNoise(ctx, master, seed, when, level * 0.85 * (0.25 + 0.75 * strike), decay,
        'highpass', spec.hz * spec.tone * toneScale, 0.6, air));
      break;

    case 'rim':
      later(drumNoise(ctx, master, seed, when, level, decay,
        'bandpass', spec.hz * toneScale, 6, air));
      later(drumTone(ctx, master, { ...spec, hz: 420, sweep: 1.1 },
        when, level * 0.35, 0.03, tune, strike));
      break;

    case 'clap':
      // Several hands, not quite together — the spread is the clap.
      CLAP_OFFSETS.forEach((offset, i) => {
        const last = i === CLAP_OFFSETS.length - 1;
        later(drumNoise(ctx, master, seed + i * 7919, when + offset,
          level * (last ? 0.8 : 0.55), last ? decay : 0.02,
          'bandpass', spec.hz * spec.tone * toneScale, 1.4, air));
      });
      break;

    case 'hat':
      // Also tried: a short bright stick transient, the way the kick has a
      // beater click.  Worth 0.005 of extra velocity response, for a node on
      // the most frequently struck drum in any pattern — so a hat stays one
      // burst of noise and answers the stick through its ceiling alone.
      later(drumNoise(ctx, master, seed, when, level, decay,
        'highpass', spec.hz * toneScale, 0.8, air));
      break;

    case 'cymbal':
      later(drumNoise(ctx, master, seed, when, level, decay,
        'highpass', spec.hz * 0.55 * toneScale, 0.5, air));
      // A cymbal is pure noise, so it has no sweep to deepen — its only
      // way to answer the stick is WHICH of its modes get excited.  The
      // high, short component is the "crash"; without it the same cymbal is
      // a wash, which is exactly what one sounds like brushed.
      later(drumNoise(ctx, master, seed + 104729, when, level * 0.45 * strike, decay * 0.35,
        'bandpass', spec.hz * 1.4 * toneScale, 0.9, air));
      break;

    case 'bell':
      // A ride is a cymbal you can hear the stick on.
      later(drumNoise(ctx, master, seed, when, level * 0.55, decay,
        'highpass', spec.hz * 0.7 * toneScale, 0.6, air));
      // The stick on a ride is the part that comes and goes with the arm.
      later(drumTone(ctx, master, { ...spec, hz: spec.hz * 0.22, sweep: 1.05 },
        when, level * 0.5 * (0.4 + snap) * strike, 0.09, tune, strike));
      break;

    case 'cowbell': {
      // Two squares a fifth-ish apart: the classic, and genuinely how it is
      // built in every drum machine since the 808.
      for (const ratio of [1, 1.485]) {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = spec.hz * ratio * tune;
        const gain = ctx.createGain();
        const stop = hit(gain, when, level * 0.5, decay);
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = spec.hz * 1.6 * toneScale;
        band.Q.value = 1.4;
        osc.connect(band).connect(gain).connect(master);
        osc.start(when);
        osc.stop(stop + 0.02);
        later(stop);
      }
      break;
    }

    case 'shaker':
      later(drumNoise(ctx, master, seed, when, level, decay,
        'bandpass', spec.hz * toneScale, 1.1, air));
      break;
  }

  return {
    stop: (at: number) => {
      // A drum has already decided how long it rings — a stop can only cut it
      // short, and it has to do that with a ramp.  Every source here already
      // has its own `stop` scheduled, so nothing is left running afterwards.
      if (at >= end) return;
      try {
        master.gain.cancelScheduledValues(at);
        master.gain.setTargetAtTime(0.0001, at, 0.004);
      } catch { /* context gone */ }
    },
  };
}

/** One plucked-string voice, shared by the two guitars. */
function pluckVoice(
  v: VoiceContext,
  tuning: {
    damping: number; brightness: number; pick: number;
    bodyHz: number; bodyQ: number; toneHz: number;
    /** This guitar's output trim — the two share a voice, not a level. */
    trim: number;
  },
): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const freq = pitchToFrequency(soundingPitch(note));
  const level = (params['level'] ?? CALIBRATED_LEVEL) * tuning.trim * (0.25 + 0.75 * note.velocity);

  // How long the string is allowed to ring, independent of the note's length:
  // a plucked string does not stop when the key is released, it decays.  The
  // amp envelope below is what ends it.
  const ring = Math.min(8, Math.max(0.35, (params['sustain'] ?? 2.4)));

  // The STRING, which is what a patch was previously unable to change.
  //
  // Damping and brightness were fixed per instrument, so every acoustic patch
  // was the same steel string behind a different EQ — measured, the whole
  // five-patch bank fitted into a band narrower than the poly synth's closest
  // two patches.  Nylon is not a darker steel string; it is a string that
  // loses its highs faster and starts with fewer of them.
  const damping = Math.min(0.9999, Math.max(0.97, params['damp'] ?? tuning.damping));
  const pickPos = params['pick'] ?? tuning.pick;

  // How hard the string was actually plucked.
  //
  // Measured before this existed: normalised for level, a guitar plucked at a
  // quarter velocity and at full velocity differed by 0.002 — a hundred times
  // less than the poly synth, three hundred times less than the Rhodes, and
  // against the kick's 0.620 it is nothing at all.  Velocity was a volume
  // knob, which on a plucked instrument is the wrong knob: a string displaced
  // further is released from a SHARPER corner, and a sharper corner is more
  // high partials.  That is the whole difference between a strum and a
  // caress, and none of it was there.
  //
  // `brightness` is the excitation's low-pass, which is exactly that corner —
  // so velocity belongs on it and not on a filter further down the chain,
  // where it would be an amp's tone control rather than a player's hand.
  //
  // It does not reach zero at zero velocity: a string touched at all still
  // rings, and the floor is what keeps a ghost note from vanishing into a
  // thud.
  const strike = 0.25 + 0.75 * note.velocity;
  const brightness = Math.min(1, Math.max(0,
    (params['bright'] ?? tuning.brightness) * strike));
  const src = ctx.createBufferSource();
  src.buffer = stringBuffer(ctx, freq, ring, damping, brightness, pickPos, noteSeed(note));

  // A second string, slightly out with the first.  A twelve-string's courses
  // and a doubled electric are the same trick, and it is a trick no amount of
  // EQ imitates: two strings beat against each other, one string does not.
  const doubling = Math.max(0, Math.min(1, params['double'] ?? 0));
  const sides: StereoPannerNode[] = [];
  let twin: AudioBufferSourceNode | null = null;
  let twinGain: GainNode | null = null;
  if (doubling > 0.01) {
    twin = ctx.createBufferSource();
    // A different seed, so the two are plucked independently — the same
    // buffer twice would sum coherently and only be 6 dB louder.
    twin.buffer = stringBuffer(ctx, freq, ring, damping, brightness, pickPos, noteSeed(note) ^ 0x5bf03635);
    twin.detune.value = 6 + 10 * doubling;
    twinGain = ctx.createGain();
    twinGain.gain.value = doubling;
  }
  // Where the two strings sit.  One guitar is one source and stays mono —
  // measured, every melodic instrument here was at negative infinity on the
  // side channel, and widening a single plucked string would be inventing a
  // room rather than modelling an instrument.  A DOUBLED string is two
  // sources, which is exactly what a twelve-string's courses and a
  // double-tracked electric are, and they are what gets placed.
  const spread = Math.max(0, Math.min(1, params['width'] ?? 0.6));
  // Power, not amplitude — the same rule the synth's unison follows.
  const pairGain = ctx.createGain();
  const placed = twin !== null && spread > 0.001;
  pairGain.gain.value = (1 / Math.sqrt(1 + doubling * doubling)) * (placed ? PANNER_MAKEUP : 1);

  // The body (or the pickup): resonances and a roll-off.  This is what makes
  // the same string a guitar rather than a synth pluck — and WHERE the
  // resonance sits is which guitar it is, so it is a parameter now and not a
  // constant.  A real acoustic has two: the air inside the box, and the top
  // plate about an octave above it.
  const body = ctx.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.value = Math.max(40, params['bodyHz'] ?? tuning.bodyHz);
  body.Q.value = Math.max(0.2, params['bodyQ'] ?? tuning.bodyQ);
  body.gain.value = params['body'] ?? 4;

  const plateGain = params['plate'] ?? 0;
  let plate: BiquadFilterNode | null = null;
  if (Math.abs(plateGain) > 0.1) {
    plate = ctx.createBiquadFilter();
    plate.type = 'peaking';
    plate.frequency.value = Math.max(80, (params['bodyHz'] ?? tuning.bodyHz) * 1.9);
    plate.Q.value = 1.8;
    plate.gain.value = plateGain;
  }

  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = Math.max(400, params['tone'] ?? tuning.toneHz);
  tone.Q.value = BUTTERWORTH_Q;

  const amp = ctx.createGain();

  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );

  if (twin && twinGain && placed) {
    const left = ctx.createStereoPanner();
    const right = ctx.createStereoPanner();
    left.pan.value = -spread;
    right.pan.value = spread;
    src.connect(left).connect(pairGain);
    twin.connect(twinGain).connect(right).connect(pairGain);
    sides.push(left, right);
  } else {
    src.connect(pairGain);
    if (twin && twinGain) twin.connect(twinGain).connect(pairGain);
  }
  const shaped = plate ? pairGain.connect(body).connect(plate) : pairGain.connect(body);
  (shaped as AudioNode).connect(tone).connect(amp).connect(destination);

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
  if (twin) { twin.start(start); twin.stop(releaseEnd + 0.02); }
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      if (twin) { try { twin.stop(at); } catch { /* already stopped */ } }
      try {
        src.disconnect(); twin?.disconnect(); twinGain?.disconnect();
        for (const p of sides) p.disconnect();
        pairGain.disconnect(); body.disconnect(); plate?.disconnect();
        tone.disconnect(); amp.disconnect();
      } catch { /* ignore */ }
    },
  };
}


// ── The pianos ──────────────────────────────────────────────────────────────

/**
 * Where the dampers stop.
 *
 * The top notes of a piano have no dampers at all — the strings are so short
 * that they stop on their own faster than a damper could reach them, and
 * leaving them free lets them ring in sympathy with everything below.  Which
 * note it starts at is a builder's choice; the top year and a half of the
 * keyboard is usual, and MIDI 88 (E6) is inside that range on most grands.
 *
 * It is audible and it is not a detail: above this line, letting go of the
 * key does nothing at all.
 */
const UNDAMPED_FROM = 88;

/**
 * How fast a damper actually stops a string, in seconds.
 *
 * Faster at the top, where the felt has less string to stop and the string
 * has less energy in it.  A single release time across the keyboard makes the
 * bass sound clipped off and the treble sound smeared, which is the wrong
 * error in both directions at once.
 */
function damperSeconds(pitch: number, scale: number): number {
  const wide = 0.34 - 0.0028 * Math.max(0, pitch - 21);
  return Math.min(1.2, Math.max(0.03, wide * scale));
}

/**
 * The piano for one note, cached.
 *
 * Same argument as the plucked string's cache and the same shape: a part
 * plays the same few pitches over and over, the Float32Array outlives any one
 * context, and computing it is the expensive part.  Bigger than the string
 * cache because a piano part is chords — ten notes at once, each with its own
 * velocity bucket, is a lot of distinct keys in flight.
 */
const PIANO_CACHE = new Map<string, Float32Array>();
const PIANO_CACHE_MAX = 320;

/**
 * Velocity is rounded before it reaches the cache key.
 *
 * Velocity changes the SAMPLES here — that is the whole hammer model — so an
 * unrounded velocity makes every note a cache miss, and a performance played
 * from a keyboard never repeats a velocity exactly.  Sixteen buckets is finer
 * than the ear resolves on a single note and coarse enough to hit.
 */
const VELOCITY_BUCKETS = 16;

interface PianoTuning {
  /** Multiplies the fitted inharmonicity — an upright's strings are shorter. */
  stretch: number;
  hammerHz: number;
  strike: number;
  /** Multiplies the fitted ring time. */
  decay: number;
  bodyHz: number;
  bodyQ: number;
  toneHz: number;
  trim: number;
}

function pianoBuffer(
  ctx: BaseAudioContext, spec: Parameters<typeof struckString>[0],
): AudioBuffer {
  const key = [
    spec.freqHz.toFixed(3), spec.sampleRate, spec.seconds.toFixed(2),
    spec.B.toExponential(3), spec.velocity.toFixed(3), spec.strikePosition.toFixed(3),
    spec.hammerHz.toFixed(0), spec.t60.toFixed(3), spec.aftersound.toFixed(2),
    spec.aftersoundLevel.toFixed(3), spec.hfDamping.toFixed(4),
    spec.unisonCents.toFixed(2), spec.strings,
  ].join('|');
  let samples = PIANO_CACHE.get(key);
  if (!samples) {
    samples = struckString(spec);
    if (PIANO_CACHE.size >= PIANO_CACHE_MAX) {
      const oldest = PIANO_CACHE.keys().next().value;
      if (oldest !== undefined) PIANO_CACHE.delete(oldest);
    }
    PIANO_CACHE.set(key, samples);
  }
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.getChannelData(0).set(samples);
  return buf;
}

/**
 * One struck note: the string, the soundboard, where it sits, and the damper.
 *
 * The string itself is `struck-string.ts` and its whole argument lives there.
 * What is here is everything between the string and the room.
 */
function pianoVoice(
  v: VoiceContext, tuning: PianoTuning,
): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const pitch = soundingPitch(note);
  const freq = pitchToFrequency(pitch);

  // Velocity does NOT scale the output here the way it does on the synth.
  // It reaches the hammer, which changes what the string does, and the gain
  // it still carries is the small remainder: a piano played softly is much
  // more than a quiet piano, and if the whole dynamic were in this number the
  // hammer model would be decoration.
  const velocity = Math.min(1, Math.max(0, note.velocity));
  const bucket = Math.round(velocity * VELOCITY_BUCKETS) / VELOCITY_BUCKETS;
  const level = (params['level'] ?? CALIBRATED_LEVEL) * tuning.trim * (0.5 + 0.5 * velocity);

  const stretch = Math.max(0.05, params['stretch'] ?? 1) * tuning.stretch;
  const B = inharmonicity(pitch, stretch);
  const bloom = Math.min(20, Math.max(1, params['bloom'] ?? 8));
  // `ringSeconds` is the whole note's audible ring, which is the aftersound.
  // The fast plane is what is left when that is divided out — see the two
  // stages in `struck-string.ts`.
  const ring = ringSeconds(freq) * Math.max(0.2, params['decay'] ?? 1);
  const fast = Math.max(0.05, ring / bloom);

  const damped = pitch < UNDAMPED_FROM;
  const releaseSec = damperSeconds(pitch, Math.max(0.1, params['release'] ?? 1));
  // How much audio to compute.  A damped note stops when the key does, so it
  // is not worth computing its twelve-second aftersound; an undamped one has
  // no key to stop it and gets the whole ring.
  const seconds = Math.min(ring + 0.1,
    damped ? Math.max(0.12, durationSec) + releaseSec + 0.05 : Math.max(0.12, durationSec) + ring);

  const src = ctx.createBufferSource();
  src.buffer = pianoBuffer(ctx, {
    freqHz: freq, sampleRate: ctx.sampleRate, seconds, B, velocity: bucket,
    strikePosition: params['strike'] ?? tuning.strike,
    hammerHz: Math.max(400, params['hammer'] ?? tuning.hammerHz),
    t60: fast, aftersound: bloom,
    aftersoundLevel: Math.max(0, Math.min(1, params['after'] ?? 0.28)),
    hfDamping: Math.max(0.0005, params['toneDecay'] ?? 0.015),
    unisonCents: Math.max(0, params['unison'] ?? 1.2),
    strings: stringsForPitch(pitch),
  });

  // The soundboard.  One broad resonance and a roll-off, the same shape the
  // guitar's body uses — a piano's board has dozens, but they are a room's
  // worth of detail and this is the one that changes whether the instrument
  // sounds like a piano or like a struck wire.
  const body = ctx.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.value = Math.max(50, params['bodyHz'] ?? tuning.bodyHz);
  body.Q.value = Math.max(0.2, params['bodyQ'] ?? tuning.bodyQ);
  body.gain.value = params['body'] ?? 3.5;

  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = Math.min(
    ctx.sampleRate * 0.45, Math.max(600, params['tone'] ?? tuning.toneHz));
  tone.Q.value = BUTTERWORTH_Q;

  // Where the note sits across the stereo picture.
  //
  // From the PLAYER's seat, which is the convention every piano library
  // follows: the bass is on the left because the player's left hand is.  The
  // span is the keyboard, not a pan law — a piano is one instrument in one
  // place, and this is the width of that one instrument.
  const spread = Math.max(0, Math.min(1, params['spread'] ?? 0.45));
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-1, Math.min(1, ((pitch - 60) / 36) * spread));

  const amp = ctx.createGain();
  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );

  src.connect(body).connect(tone).connect(pan).connect(amp).connect(destination);

  const start = Math.max(0, when);
  const noteEnd = start + Math.max(0.02, durationSec);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), start + 0.002);
  // The damper.  Above `UNDAMPED_FROM` there isn't one, so the envelope holds
  // and the string's own decay is what ends the note.
  const stopAt = damped ? noteEnd + releaseSec : start + seconds;
  amp.gain.setValueAtTime(Math.max(0.0002, level), Math.max(start + 0.003, damped ? noteEnd : stopAt - 0.02));
  amp.gain.exponentialRampToValueAtTime(0.0001, stopAt);

  src.start(start);
  src.stop(stopAt + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try {
        src.disconnect(); body.disconnect(); tone.disconnect();
        pan.disconnect(); amp.disconnect();
      } catch { /* ignore */ }
    },
  };
}

/** The parameters both pianos take.  Same knobs, different rest positions. */
function pianoParams(d: {
  hammer: number; strike: number; stretch: number; unison: number;
  bloom: number; decay: number; bodyHz: number; bodyQ: number; tone: number;
}): InstrumentParamDef[] {
  return [
    { id: 'hammer',    name: 'Hammer',   min: 900,   max: 9000,  default: d.hammer,  unit: 'Hz' },
    { id: 'strike',    name: 'Strike',   min: 0.04,  max: 0.28,  default: d.strike,  unit: '' },
    { id: 'stretch',   name: 'Stretch',  min: 0.1,   max: 4,     default: d.stretch, unit: '×' },
    { id: 'unison',    name: 'Unison',   min: 0,     max: 12,    default: d.unison,  unit: 'ct' },
    { id: 'bloom',     name: 'Bloom',    min: 1,     max: 20,    default: d.bloom,   unit: '×' },
    { id: 'after',     name: 'After',    min: 0,     max: 1,     default: 0.28,      unit: '' },
    { id: 'decay',     name: 'Decay',    min: 0.2,   max: 2.5,   default: d.decay,   unit: '×' },
    { id: 'toneDecay', name: 'Tone Dec', min: 0.002, max: 0.06,  default: 0.015,     unit: '' },
    { id: 'bodyHz',    name: 'Board Hz', min: 50,    max: 500,   default: d.bodyHz,  unit: 'Hz' },
    { id: 'bodyQ',     name: 'Board Q',  min: 0.3,   max: 6,     default: d.bodyQ,   unit: '' },
    { id: 'body',      name: 'Board',    min: -6,    max: 12,    default: 3.5,       unit: 'dB' },
    { id: 'tone',      name: 'Tone',     min: 900,   max: 18000, default: d.tone,    unit: 'Hz' },
    { id: 'spread',    name: 'Spread',   min: 0,     max: 1,     default: 0.45,      unit: '' },
    { id: 'release',   name: 'Damper',   min: 0.1,   max: 3,     default: 1,         unit: '×' },
    { id: 'level',     name: 'Level',    min: 0,     max: 1,     default: CALIBRATED_LEVEL, unit: '' },
  ];
}


// ── The mallet instruments ──────────────────────────────────────────────────

const BAR_CACHE = new Map<string, Float32Array>();
const BAR_CACHE_MAX = 240;

/**
 * One struck bar.
 *
 * The bar itself is `bar-model.ts`; what is here is the resonator under it
 * and the motor in the resonator, which are the two things a bar on its own
 * does not have.
 */
function malletVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const pitch = soundingPitch(note);
  const freq = pitchToFrequency(pitch);
  const velocity = Math.min(1, Math.max(0, note.velocity));
  const bucket = Math.round(velocity * 12) / 12;
  const profile = barProfile(params['bar'] ?? 0);
  const level = (params['level'] ?? CALIBRATED_LEVEL) * INSTRUMENT_TRIM.mallet
    * (0.35 + 0.65 * velocity);

  // A small bar rings for less time than a big one, on every instrument in
  // the family.  Scaled off the profile's middle rather than fitted
  // separately: four instruments and one exponent is as much as the shape of
  // the data supports.
  const ring = profile.ringSeconds * Math.pow(261.63 / Math.max(40, freq), 0.6)
    * Math.max(0.2, params['decay'] ?? 1);
  const damped = (params['damp'] ?? 0) > 0.5;
  const seconds = Math.min(ring + 0.1,
    damped ? Math.max(0.1, durationSec) + 0.25 : Math.max(0.12, durationSec) + ring);

  const spec = {
    freqHz: freq, sampleRate: ctx.sampleRate, profile, velocity: bucket,
    ringSeconds: ring, hardness: Math.max(0.2, params['hardness'] ?? 1),
  };
  const key = [
    freq.toFixed(3), ctx.sampleRate, seconds.toFixed(2), bucket.toFixed(3),
    ring.toFixed(3), spec.hardness.toFixed(2), profile.ratios.join(','),
  ].join('|');
  let samples = BAR_CACHE.get(key);
  if (!samples) {
    const modes = barModes(spec);
    samples = renderModes(modes, ctx.sampleRate, seconds);
    let sum = 0;
    for (const m of barModes({ ...spec, velocity: 1 })) sum += m.amp;
    const norm = 1 / Math.max(1e-6, sum);
    for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) * norm;
    if (BAR_CACHE.size >= BAR_CACHE_MAX) {
      const oldest = BAR_CACHE.keys().next().value;
      if (oldest !== undefined) BAR_CACHE.delete(oldest);
    }
    BAR_CACHE.set(key, samples);
  }
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  // The tube under the bar.  One resonance at the bar's own pitch, which is
  // what a tube cut to a quarter of that wavelength is for: it makes the
  // fundamental loud and does nothing for the partials above it, and that
  // selectivity is why a marimba without its tubes sounds like a xylophone.
  const tube = ctx.createBiquadFilter();
  tube.type = 'peaking';
  tube.frequency.value = Math.min(ctx.sampleRate * 0.45, freq);
  tube.Q.value = Math.max(0.3, params['tubeQ'] ?? 2.2);
  tube.gain.value = params['tube'] ?? 5;

  const amp = ctx.createGain();
  const pan = ctx.createStereoPanner();
  const spread = Math.max(0, Math.min(1, params['spread'] ?? 0.35));
  pan.pan.value = Math.max(-1, Math.min(1, ((pitch - 65) / 30) * spread));

  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );

  const start = Math.max(0, when);
  const stopAt = start + seconds;
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), start + 0.002);
  if (damped) {
    const end = start + Math.max(0.02, durationSec);
    amp.gain.setValueAtTime(Math.max(0.0002, level), Math.max(start + 0.003, end));
    amp.gain.exponentialRampToValueAtTime(0.0001, end + 0.22);
  }

  // The vibraphone's motor: discs spinning in the mouths of the tubes, which
  // open and close them.  It is an AMPLITUDE wobble and not a pitch one —
  // "vibrato" is the wrong word for what the instrument is named after, and
  // modelling it as pitch is the commonest way to get a vibraphone wrong.
  const motorHz = Math.max(0, params['motor'] ?? 0);
  let lfo: OscillatorNode | null = null;
  let lfoGain: GainNode | null = null;
  const depth = Math.max(0, Math.min(1, params['motorDepth'] ?? 0.5));
  if (profile.motor && motorHz > 0.05 && depth > 0.01) {
    lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = motorHz;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = depth * level * 0.5;
    lfo.connect(lfoGain).connect(amp.gain);
    lfo.start(start);
    lfo.stop(stopAt + 0.02);
  }

  src.connect(tube).connect(pan).connect(amp).connect(destination);
  src.start(start);
  src.stop(stopAt + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try { lfo?.stop(at); } catch { /* already stopped */ }
      try {
        src.disconnect(); tube.disconnect(); pan.disconnect(); amp.disconnect();
        lfo?.disconnect(); lfoGain?.disconnect();
      } catch { /* ignore */ }
    },
  };
}

// ── The drawbar organ ───────────────────────────────────────────────────────

/**
 * What each drawbar is, as a multiple of the key's own pitch.
 *
 * In footages, which is what the instrument is labelled in, and they are not
 * in order: the second drawbar is a TWELFTH above the first and sits between
 * the 16' and the 8', because the panel is laid out by pitch and 5⅓' is
 * lower than 8'.  Everybody who has played one knows the brown-white-brown
 * layout and almost nobody knows why the first two are brown; it is because
 * those two are the ones below unison.
 *
 *     16'   5⅓'   8'    4'    2⅔'   2'    1⅗'   1⅓'   1'
 *     0.5   1.5   1     2     3     4     5     6     8
 */
const DRAWBAR_RATIOS: readonly number[] = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
const DRAWBAR_IDS: readonly string[] = [
  'db16', 'db513', 'db8', 'db4', 'db223', 'db2', 'db135', 'db113', 'db1',
];

/**
 * The drawbars as ONE periodic wave rather than nine oscillators.
 *
 * Every ratio above is a whole multiple of HALF the key's pitch — 0.5 is the
 * first, 1.5 is the third, 1 is the second — so all nine are harmonics of
 * f0/2 and a single oscillator running an octave down can carry the lot.
 * Nine oscillators per key would be nine times the nodes for the same
 * samples, and a ten-finger chord on an organ is not unusual.
 *
 * ── Why the coefficients are normalised here and not by WebAudio ────────────
 *
 * `createPeriodicWave` takes a `disableNormalization` flag, and the two
 * renderers this engine has to agree in do not agree about it.  Measured, at
 * 220 Hz, coefficients [0, ⅓, ⅓, ⅓]:
 *
 *                            disableNormalization: true      : false
 *     Chromium               peak 0.8332  rms 0.4082     peak 1.0000  rms 0.4900
 *     node-web-audio-api     peak 1.0000  rms 0.4900     peak 1.0000  rms 0.4900
 *
 * node ignores the flag and normalises whatever it is given to a peak of one.
 * Which meant the organ measured 1.59 LU louder under node than in the app —
 * exactly 20·log10(0.49/0.4082) — and, worse than the offset, it meant the
 * DRAWBARS DID NOT CHANGE THE LEVEL AT ALL under node, because every
 * registration was renormalised back to the same peak.  A suite measuring an
 * organ there would have been measuring a constant.
 *
 * So the normalisation is done here, in arithmetic both renderers run the
 * same way: the coefficients are divided by the wave's own peak, which makes
 * the wave peak at one under either interpretation of the flag, and the level
 * the registration implies is handed back as a gain.  Pulling out more
 * drawbars is louder again, in both, by the same amount.
 */
function drawbarWave(
  ctx: BaseAudioContext, params: Record<string, number>,
): { wave: PeriodicWave; gain: number } {
  // Harmonics of f0/2, so ratio r lands at index 2r.
  const size = 17;
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  let any = false;
  DRAWBAR_RATIOS.forEach((ratio, i) => {
    // 0..8, the way the stops are drawn out, and roughly 3 dB a step — which
    // is what the tapped transformer in the original actually does.
    const setting = Math.max(0, Math.min(8, params[DRAWBAR_IDS[i] ?? ''] ?? 0));
    if (setting <= 0) return;
    imag[Math.round(ratio * 2)] = Math.pow(10, (setting - 8) * 3 / 20);
    any = true;
  });
  // All the stops pushed in is silence on the real instrument too, but a
  // silent oscillator is indistinguishable from a broken one, so the unison
  // stands in — a registration nobody meant is better than a note nobody can
  // hear while they work out why.
  if (!any) imag[2] = 1;

  const peak = wavePeak(imag);
  for (let i = 0; i < size; i++) imag[i] = (imag[i] ?? 0) / peak;
  return {
    wave: ctx.createPeriodicWave(real, imag, { disableNormalization: true }),
    // Relative to the registration the trim was measured on, so that the
    // default sits at unity and the calibration is about the instrument
    // rather than about one setting of it.
    gain: peak / DRAWBAR_REFERENCE_PEAK,
  };
}

/**
 * The peak of one period of a sine series, found by looking.
 *
 * There is no closed form for the peak of a sum of sines — it is a
 * trigonometric polynomial, and where its maximum falls depends on every
 * coefficient.  2048 points across a period is far more than the sixteen
 * harmonics here need: the sampled maximum is under a hundredth of a percent
 * below the true one, which is a thousand times smaller than the 3 dB a
 * drawbar step is worth.
 */
function wavePeak(imag: Float32Array): number {
  const steps = 2048;
  let peak = 0;
  for (let s = 0; s < steps; s++) {
    const theta = (2 * Math.PI * s) / steps;
    let v = 0;
    for (let k = 1; k < imag.length; k++) {
      const c = imag[k] ?? 0;
      if (c !== 0) v += c * Math.sin(k * theta);
    }
    peak = Math.max(peak, Math.abs(v));
  }
  return Math.max(1e-6, peak);
}

/**
 * The peak of the 888000000 registration — the one the trim was measured on.
 *
 * Computed once at module load rather than written down, so that it cannot
 * drift away from what `wavePeak` actually returns for those drawbars.
 */
const DRAWBAR_REFERENCE_PEAK = (() => {
  const imag = new Float32Array(17);
  imag[1] = 1; imag[2] = 1; imag[3] = 1;    // 16', 8', 5⅓' all the way out
  return wavePeak(imag);
})();

/**
 * One key of a drawbar organ.
 *
 * No decay at all while the key is held — that is the whole character of the
 * instrument, and it is why an organ part is written with its hands rather
 * than with its dynamics: the keyboard has no velocity.  Velocity here moves
 * the KEY CLICK and nothing else, which is the honest translation, since the
 * only thing a player's speed changes on a tonewheel organ is how fast the
 * contacts close.
 */
function organVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const pitch = soundingPitch(note);
  const freq = pitchToFrequency(pitch);
  const level = (params['level'] ?? CALIBRATED_LEVEL) * INSTRUMENT_TRIM.organ;

  const registration = drawbarWave(ctx, params);
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(registration.wave);
  // Half pitch, because the wave's harmonics are counted from there.
  osc.frequency.value = freq / 2;

  const amp = ctx.createGain();
  const out = ctx.createGain();
  out.gain.value = level * registration.gain;

  scheduleCurve(
    osc.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );

  // Key click: the contacts on a tonewheel organ are nine metal wires closing
  // on nine busbars, never quite together, and the click is the transient
  // that makes.  It is not a flaw somebody failed to filter out — it is the
  // instrument's attack, and an organ without it sounds like a sine bank.
  const click = ctx.createGain();
  const clickAmount = Math.max(0, Math.min(1, params['click'] ?? 0.35));
  let clickSrc: AudioBufferSourceNode | null = null;
  let clickFilter: BiquadFilterNode | null = null;
  const start = Math.max(0, when);
  if (clickAmount > 0.01) {
    const n = Math.max(8, Math.round(ctx.sampleRate * 0.012));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic, like every other source here: the same key twice is the
    // same click twice, or a bounce stops matching the preview.
    let seed = (pitch * 2654435761) >>> 0;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = ((seed / 4294967296) * 2 - 1) * Math.pow(1 - i / n, 3);
    }
    clickSrc = ctx.createBufferSource();
    clickSrc.buffer = buf;
    clickFilter = ctx.createBiquadFilter();
    clickFilter.type = 'bandpass';
    clickFilter.frequency.value = Math.min(ctx.sampleRate * 0.4, 2600);
    clickFilter.Q.value = 0.8;
    click.gain.value = clickAmount * level * (0.4 + 0.6 * note.velocity);
    clickSrc.connect(clickFilter).connect(click).connect(destination);
    clickSrc.start(start);
  }

  // Percussion: a single decaying harmonic on the attack, and only on the
  // attack of the first key in a legato phrase on the real instrument.  That
  // last part is not modelled — it is a property of the whole performance and
  // not of one note, and a per-note engine has nowhere to keep it.
  const percLevel = Math.max(0, Math.min(1, params['perc'] ?? 0));
  let perc: OscillatorNode | null = null;
  let percGain: GainNode | null = null;
  if (percLevel > 0.01) {
    perc = ctx.createOscillator();
    perc.type = 'sine';
    perc.frequency.value = Math.min(ctx.sampleRate * 0.45,
      freq * ((params['percHarmonic'] ?? 0) > 0.5 ? 3 : 2));
    percGain = ctx.createGain();
    const decay = Math.max(0.05, params['percDecay'] ?? 0.25);
    percGain.gain.setValueAtTime(percLevel * level, start);
    percGain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    perc.connect(percGain).connect(destination);
    perc.start(start);
    perc.stop(start + decay + 0.02);
  }

  const noteEnd = start + Math.max(0.02, durationSec);
  // Milliseconds, not a synth's envelope: a tonewheel is already turning
  // before the key is touched, so the note is there the moment the contact
  // closes and gone the moment it opens.
  const edge = Math.min(0.03, Math.max(0.002, params['edge'] ?? 0.006));
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(1, start + edge);
  amp.gain.setValueAtTime(1, Math.max(start + edge + 0.001, noteEnd));
  amp.gain.exponentialRampToValueAtTime(0.0001, noteEnd + edge);

  osc.connect(amp).connect(out).connect(destination);
  osc.start(start);
  osc.stop(noteEnd + edge + 0.02);
  return {
    stop: (at: number) => {
      try { osc.stop(at); } catch { /* already stopped */ }
      try { perc?.stop(at); } catch { /* already stopped */ }
      try { clickSrc?.stop(at); } catch { /* already stopped */ }
      try {
        osc.disconnect(); amp.disconnect(); out.disconnect();
        perc?.disconnect(); percGain?.disconnect();
        clickSrc?.disconnect(); clickFilter?.disconnect(); click.disconnect();
      } catch { /* ignore */ }
    },
  };
}


// ── The wavetable synth ─────────────────────────────────────────────────────

/**
 * The parameter list, built rather than written out.
 *
 * Ninety-odd parameters typed by hand is ninety-odd chances to give one the
 * wrong range, and the two oscillators are the same fourteen controls twice
 * — so they are generated from one description and cannot drift apart.  The
 * matrix is the same argument again: eight identical rows.
 */
function waveSynthParams(): InstrumentParamDef[] {
  const out: InstrumentParamDef[] = [];
  const lastTable = WAVETABLES.length - 1;

  for (const o of ['a', 'b'] as const) {
    const up = o.toUpperCase();
    out.push(
      { id: `${o}Table`,  name: `${up} Table`,  min: 0, max: lastTable, default: o === 'a' ? 0 : 1, unit: '' },
      { id: `${o}Pos`,    name: `${up} WT Pos`, min: 0, max: 7,   default: 0,  unit: 'fr' },
      { id: `${o}Oct`,    name: `${up} Oct`,    min: -3, max: 3,  default: 0,  unit: '' },
      { id: `${o}Semi`,   name: `${up} Semi`,   min: -12, max: 12, default: 0, unit: 'st' },
      { id: `${o}Fine`,   name: `${up} Fine`,   min: -100, max: 100, default: 0, unit: 'ct' },
      { id: `${o}Unison`, name: `${up} Unison`, min: 1, max: 7,   default: o === 'a' ? 3 : 1, unit: '' },
      { id: `${o}Detune`, name: `${up} Detune`, min: 0, max: 50,  default: 14, unit: 'ct' },
      { id: `${o}Blend`,  name: `${up} Blend`,  min: 0, max: 1,   default: 0.7, unit: '' },
      { id: `${o}Phase`,  name: `${up} Phase`,  min: 0, max: 1,   default: 0,  unit: '' },
      { id: `${o}Rand`,   name: `${up} Rand`,   min: 0, max: 1,   default: o === 'a' ? 0.35 : 0.35, unit: '' },
      { id: `${o}Width`,  name: `${up} Width`,  min: 0, max: 1,   default: 0.6, unit: '' },
      { id: `${o}Pan`,    name: `${up} Pan`,    min: -1, max: 1,  default: 0,  unit: '' },
      { id: `${o}Level`,  name: `${up} Level`,  min: 0, max: 1,   default: o === 'a' ? 0.8 : 0, unit: '' },
    );
  }

  out.push(
    { id: 'subWave',    name: 'Sub Wave',  min: 0, max: SUB_SHAPES.length - 1, default: 0, unit: '' },
    { id: 'subOct',     name: 'Sub Oct',   min: -2, max: 0, default: -1, unit: '' },
    { id: 'subLevel',   name: 'Sub',       min: 0, max: 1, default: 0, unit: '' },
    { id: 'noiseColour', name: 'Noise Col', min: 0, max: 1, default: 0.5, unit: '' },
    { id: 'noiseLevel', name: 'Noise',     min: 0, max: 1, default: 0, unit: '' },

    { id: 'fltType', name: 'Filter', min: 0, max: FILTER_MODES.length - 1, default: 0, unit: '' },
    // Cutoff in SEMITONES from 8.1758 Hz (MIDI 0), not hertz.  A filter
    // tracked to the keyboard, swept by an envelope or wobbled by an LFO is
    // moving in musical intervals every time, and a knob in hertz makes the
    // same modulation depth mean something different in every octave.
    { id: 'cutoff',  name: 'Cutoff', min: 12,  max: 135, default: 110, unit: 'st' },
    { id: 'res',     name: 'Res',    min: 0,   max: 0.98, default: 0.15, unit: '' },
    { id: 'flt24',   name: '24 dB',  min: 0,   max: 1,  default: 1,  unit: '' },
    { id: 'fltKey',  name: 'Key Trk', min: 0,  max: 1,  default: 0,  unit: '' },
    { id: 'fltMix',  name: 'Flt Mix', min: 0,  max: 1,  default: 1,  unit: '' },
    { id: 'drive',   name: 'Drive',  min: 0,   max: 1,  default: 0,  unit: '' },
  );

  for (let i = 1; i <= 3; i++) {
    const amp = i === 1;
    out.push(
      { id: `e${i}a`, name: `E${i} Atk`, min: 0.0005, max: 4, default: amp ? 0.004 : 0.01, unit: 's' },
      { id: `e${i}d`, name: `E${i} Dec`, min: 0.002,  max: 8, default: amp ? 0.5 : 0.3, unit: 's' },
      { id: `e${i}s`, name: `E${i} Sus`, min: 0, max: 1, default: amp ? 0.75 : 0, unit: '' },
      { id: `e${i}r`, name: `E${i} Rel`, min: 0.002, max: 8, default: amp ? 0.25 : 0.2, unit: 's' },
    );
  }

  for (let i = 1; i <= 4; i++) {
    out.push(
      { id: `l${i}shape`, name: `L${i} Shape`, min: 0, max: LFO_SHAPES.length - 1, default: 0, unit: '' },
      { id: `l${i}sync`,  name: `L${i} Sync`,  min: 0, max: 1, default: 1, unit: '' },
      { id: `l${i}beats`, name: `L${i} Beats`, min: 0.0625, max: 16, default: 1, unit: 'b' },
      { id: `l${i}rate`,  name: `L${i} Rate`,  min: 0.01, max: 40, default: 4, unit: 'Hz' },
      { id: `l${i}skew`,  name: `L${i} Skew`,  min: 0.02, max: 0.98, default: 0.5, unit: '' },
      { id: `l${i}phase`, name: `L${i} Phase`, min: 0, max: 1, default: 0, unit: '' },
      { id: `l${i}delay`, name: `L${i} Delay`, min: 0, max: 4, default: 0, unit: 's' },
      { id: `l${i}rise`,  name: `L${i} Rise`,  min: 0, max: 8, default: 0, unit: 's' },
    );
  }

  for (let i = 1; i <= 4; i++) {
    out.push({ id: `macro${i}`, name: `Macro ${i}`, min: 0, max: 1, default: 0, unit: '' });
  }

  for (let r = 0; r < MATRIX_ROWS; r++) {
    const ids = rowParams(r);
    out.push(
      { id: ids.src, name: `M${r + 1} Src`, min: 0, max: MOD_SOURCES.length - 1, default: 0, unit: '' },
      { id: ids.dst, name: `M${r + 1} Dst`, min: 0, max: MOD_DESTS.length - 1, default: 0, unit: '' },
      { id: ids.amt, name: `M${r + 1} Amt`, min: -1, max: 1, default: 0, unit: '' },
    );
  }

  out.push(
    { id: 'wheel',    name: 'Mod Whl', min: 0, max: 1, default: 0, unit: '' },
    { id: 'pressure', name: 'Pressure', min: 0, max: 1, default: 0, unit: '' },
    { id: 'level',    name: 'Level', min: 0, max: 1, default: CALIBRATED_LEVEL, unit: '' },
  );
  return out;
}

const FILTER_MODES = ['LP', 'BP', 'HP', 'Notch'] as const;

const WAVE_SYNTH_PARAMS: InstrumentParamDef[] = waveSynthParams();
const WAVE_SYNTH_PARAM_IDS: readonly string[] = WAVE_SYNTH_PARAMS.map((d) => d.id);

/**
 * The rendered voice, cached.
 *
 * Keyed on everything that changes the samples, which for this instrument is
 * nearly the whole parameter set — so the key is a hash rather than a joined
 * string of ninety numbers.  A collision would play the wrong sound, so it is
 * a 53-bit hash and the parameters are folded in with their names: two
 * patches differing in one knob have to disagree here, and they do.
 */
const SYNTH_CACHE = new Map<string, { left: Float32Array; right: Float32Array }>();
const SYNTH_CACHE_MAX = 96;

function synthKey(
  spec: Parameters<typeof renderVoice>[0], ids: readonly string[],
): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const fold = (x: number): void => {
    const v = Math.round(x * 1e6) | 0;
    h1 = Math.imul(h1 ^ v, 16777619) >>> 0;
    h2 = Math.imul(h2 + v, 2246822519) >>> 0;
  };
  for (const id of ids) fold(spec.params[id] ?? 0);
  fold(spec.freqHz); fold(spec.velocity); fold(spec.seconds);
  fold(spec.gateSec); fold(spec.random); fold(spec.beatsPerSec); fold(spec.sampleRate);
  return `${h1.toString(36)}.${h2.toString(36)}`;
}

function waveSynthVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const pitch = soundingPitch(note);
  const freq = pitchToFrequency(pitch);
  // Velocity is quantised before it reaches the cache for the same reason the
  // piano's is: it changes the SAMPLES here — through the matrix — and a
  // performance from a keyboard never repeats a velocity exactly.
  const velocity = Math.round(Math.min(1, Math.max(0, note.velocity)) * 24) / 24;

  const gate = Math.max(0.01, durationSec);
  const seconds = Math.min(30, gate + tailSeconds(params));
  const spec = {
    sampleRate: ctx.sampleRate, seconds, gateSec: gate,
    freqHz: freq, pitch, velocity,
    random: noteRandom(pitch, note.startBeat, 5),
    params,
    // The tempo where this note is, derived rather than passed.
    //
    // A note carries its length in BEATS and the caller converts it to
    // SECONDS through the session's tempo map before handing it over — so the
    // ratio of the two is the tempo at this note, including inside a ramp,
    // and it is already correct without `MidiPartConfig` learning about
    // tempo at all.  A zero-length note has no ratio, so it falls back to
    // 120 bpm, which only decides where a synced LFO starts on a note too
    // short to complete a cycle of one.
    beatsPerSec: durationSec > 1e-6 && note.durationBeat > 1e-6
      ? note.durationBeat / durationSec
      : 2,
  };

  const key = synthKey(spec, WAVE_SYNTH_PARAM_IDS);
  let rendered = SYNTH_CACHE.get(key);
  if (!rendered) {
    rendered = renderVoice(spec);
    if (SYNTH_CACHE.size >= SYNTH_CACHE_MAX) {
      const oldest = SYNTH_CACHE.keys().next().value;
      if (oldest !== undefined) SYNTH_CACHE.delete(oldest);
    }
    SYNTH_CACHE.set(key, rendered);
  }

  const buf = ctx.createBuffer(2, rendered.left.length, ctx.sampleRate);
  buf.getChannelData(0).set(rendered.left);
  buf.getChannelData(1).set(rendered.right);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const amp = ctx.createGain();
  amp.gain.value = (params['level'] ?? CALIBRATED_LEVEL) * INSTRUMENT_TRIM.wavesynth;

  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );

  src.connect(amp).connect(destination);
  const start = Math.max(0, when);
  src.start(start);
  src.stop(start + seconds + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try { src.disconnect(); amp.disconnect(); } catch { /* ignore */ }
    },
  };
}


// ── The analogue synth ──────────────────────────────────────────────────────

/**
 * A short, opinionated panel, and that is the design rather than a shortcut.
 *
 * The wavetable synth has a hundred and thirteen parameters and a matrix
 * because anything driving anything IS what a wavetable synth is for.  An
 * analogue synth is the opposite argument: a Minimoog has no matrix, every
 * useful routing is already wired, and it is still the one everybody can
 * play.  So the modulation here is a list of named depths — LFO to pitch, LFO
 * to pulse width, envelope to filter, velocity to filter — and the knobs that
 * are left are the ones that decide the sound.
 */
function analogParams(): InstrumentParamDef[] {
  const out: InstrumentParamDef[] = [];
  for (const o of ['o1', 'o2'] as const) {
    const up = o === 'o1' ? 'VCO 1' : 'VCO 2';
    out.push(
      { id: `${o}shape`, name: `${up} Wave`, min: 0, max: ANALOG_SHAPES.length - 1, default: 0, unit: '' },
      { id: `${o}width`, name: `${up} PW`,   min: 0.05, max: 0.95, default: 0.5, unit: '' },
      { id: `${o}oct`,   name: `${up} Oct`,  min: -3, max: 3, default: 0, unit: '' },
      { id: `${o}semi`,  name: `${up} Semi`, min: -12, max: 12, default: 0, unit: 'st' },
      { id: `${o}fine`,  name: `${up} Fine`, min: -50, max: 50, default: o === 'o1' ? 0 : 6, unit: 'ct' },
      { id: `${o}level`, name: `${up} Level`, min: 0, max: 1, default: o === 'o1' ? 0.8 : 0.5, unit: '' },
    );
  }
  out.push(
    { id: 'sync',     name: 'Sync',    min: 0, max: 1, default: 0, unit: '' },
    { id: 'ring',     name: 'Ring',    min: 0, max: 1, default: 0, unit: '' },
    { id: 'subOct',   name: 'Sub Oct', min: -2, max: -1, default: -1, unit: '' },
    { id: 'subLevel', name: 'Sub',     min: 0, max: 1, default: 0, unit: '' },
    { id: 'noise',    name: 'Noise',   min: 0, max: 1, default: 0, unit: '' },
    { id: 'unison',   name: 'Unison',  min: 1, max: 5, default: 1, unit: '' },
    { id: 'detune',   name: 'Detune',  min: 0, max: 40, default: 8, unit: 'ct' },
    { id: 'spread',   name: 'Spread',  min: 0, max: 1, default: 0.5, unit: '' },

    // Cutoff in semitones from MIDI 0, like the wavetable synth's, so that
    // every depth below is in the same unit and a filter envelope means the
    // same thing in every octave.
    { id: 'cutoff',  name: 'Cutoff',  min: 12, max: 135, default: 92, unit: 'st' },
    { id: 'res',     name: 'Res',     min: 0,  max: 1,   default: 0.2, unit: '' },
    { id: 'poles',   name: 'Slope',   min: 2,  max: 4,   default: 4, unit: 'p' },
    { id: 'drive',   name: 'Drive',   min: 0.2, max: 12, default: 1, unit: '×' },
    { id: 'fltKey',  name: 'Key Trk', min: 0,  max: 1,   default: 0.3, unit: '' },
    { id: 'fltComp', name: 'Bass Comp', min: 0, max: 1,  default: 0, unit: '' },
    { id: 'envAmt',  name: 'Env Amt', min: -60, max: 60, default: 24, unit: 'st' },
    { id: 'velFlt',  name: 'Vel → Flt', min: -40, max: 40, default: 12, unit: 'st' },
    { id: 'velAmp',  name: 'Vel → Amp', min: 0, max: 1,  default: 0.7, unit: '' },

    { id: 'envCurve', name: 'Env Curve', min: 0, max: 1, default: 0.85, unit: '' },
  );
  for (const i of [1, 2]) {
    const amp = i === 1;
    out.push(
      { id: `e${i}a`, name: `E${i} Atk`, min: 0.0005, max: 4, default: amp ? 0.004 : 0.01, unit: 's' },
      { id: `e${i}d`, name: `E${i} Dec`, min: 0.002, max: 8, default: amp ? 0.4 : 0.5, unit: 's' },
      { id: `e${i}s`, name: `E${i} Sus`, min: 0, max: 1, default: amp ? 0.7 : 0.2, unit: '' },
      { id: `e${i}r`, name: `E${i} Rel`, min: 0.002, max: 8, default: amp ? 0.25 : 0.3, unit: 's' },
    );
  }
  for (const i of [1, 2]) {
    out.push(
      { id: `l${i}shape`, name: `L${i} Wave`, min: 0, max: LFO_SHAPES.length - 1, default: 0, unit: '' },
      { id: `l${i}sync`,  name: `L${i} Sync`, min: 0, max: 1, default: 0, unit: '' },
      { id: `l${i}beats`, name: `L${i} Beats`, min: 0.0625, max: 16, default: 1, unit: 'b' },
      { id: `l${i}rate`,  name: `L${i} Rate`, min: 0.01, max: 30, default: i === 1 ? 5 : 0.6, unit: 'Hz' },
    );
  }
  out.push(
    { id: 'l1delay', name: 'L1 Delay', min: 0, max: 4, default: 0, unit: 's' },
    { id: 'l2delay', name: 'L2 Delay', min: 0, max: 4, default: 0, unit: 's' },
    { id: 'l1pitch', name: 'L1 → Pitch', min: 0, max: 100, default: 0, unit: 'ct' },
    { id: 'l1pw',    name: 'L1 → PW',    min: 0, max: 1,   default: 0, unit: '' },
    { id: 'l1flt',   name: 'L1 → Flt',   min: -48, max: 48, default: 0, unit: 'st' },
    { id: 'l1amp',   name: 'L1 → Amp',   min: 0, max: 1,   default: 0, unit: '' },
    { id: 'l2pitch', name: 'L2 → Pitch', min: 0, max: 100, default: 0, unit: 'ct' },
    { id: 'l2flt',   name: 'L2 → Flt',   min: -48, max: 48, default: 0, unit: 'st' },

    // The three that make it analogue rather than a synth with a ladder.
    { id: 'drift',     name: 'Drift',     min: 0, max: 25, default: 3.5, unit: 'ct' },
    { id: 'tolerance', name: 'Tolerance', min: 0, max: 0.2, default: 0.03, unit: '' },
    { id: 'voices',    name: 'Voices',    min: 1, max: 8, default: 6, unit: '' },

    { id: 'level', name: 'Level', min: 0, max: 1, default: CALIBRATED_LEVEL, unit: '' },
  );
  return out;
}

/**
 * The FM synth's parameters.
 *
 * Twelve per operator times six, plus the algorithm, the feedback, a pitch
 * envelope, an LFO and the stack.  That is a lot of numbers and it is the
 * right number: an operator IS twelve decisions, and an FM synth with fewer
 * per operator is one that has picked some of them for you.
 *
 * The defaults are a two-operator electric piano on algorithm 15 — a tine,
 * not a sine — because an instrument whose default patch is a bare sine wave
 * teaches the user nothing about what it is for.
 */
function fmParams(): InstrumentParamDef[] {
  const out: InstrumentParamDef[] = [];
  // Carriers 1, 3 and 5 on algorithm 15; 2, 4 and 6 are their modulators.
  const level = [1, 0.62, 0.55, 0.3, 0.3, 0.18];
  const ratios = [1, 14, 1, 1, 2, 7];
  const decay = [1.6, 0.9, 2.2, 1.1, 1.8, 0.7];
  for (let i = 1; i <= FM_OPERATORS; i++) {
    const up = `OP ${i}`;
    const k = i - 1;
    out.push(
      { id: `o${i}ratio`, name: `${up} Ratio`, min: 0.0625, max: 32, default: ratios[k] ?? 1, unit: '×' },
      { id: `o${i}fine`,  name: `${up} Fine`,  min: -100, max: 100, default: 0, unit: 'ct' },
      { id: `o${i}fixed`, name: `${up} Fixed`, min: 0, max: 1, default: 0, unit: '' },
      { id: `o${i}hz`,    name: `${up} Hz`,    min: 1, max: 8000, default: 440, unit: 'Hz' },
      { id: `o${i}wave`,  name: `${up} Wave`,  min: 0, max: FM_WAVES.length - 1, default: 0, unit: '' },
      { id: `o${i}level`, name: `${up} Level`, min: 0, max: 1, default: level[k] ?? 0.5, unit: '' },
      { id: `o${i}a`,     name: `${up} Atk`,   min: 0.0005, max: 4, default: 0.002, unit: 's' },
      { id: `o${i}d`,     name: `${up} Dec`,   min: 0.002, max: 12, default: decay[k] ?? 1, unit: 's' },
      { id: `o${i}s`,     name: `${up} Sus`,   min: 0, max: 1, default: 0, unit: '' },
      { id: `o${i}r`,     name: `${up} Rel`,   min: 0.002, max: 12, default: 0.4, unit: 's' },
      { id: `o${i}vel`,   name: `${up} Vel`,   min: 0, max: 1, default: k % 2 === 0 ? 0.3 : 0.8, unit: '' },
      { id: `o${i}key`,   name: `${up} Key`,   min: -1, max: 1, default: k % 2 === 0 ? 0 : -0.35, unit: '' },
    );
  }
  out.push(
    { id: 'algo',     name: 'Algorithm', min: 0, max: FM_ALGORITHMS.length - 1, default: 14, unit: '' },
    { id: 'fbOp',     name: 'FB Op',     min: 1, max: FM_OPERATORS, default: 6, unit: '' },
    { id: 'feedback', name: 'Feedback',  min: 0, max: 1, default: 0, unit: '' },

    { id: 'pAmt',     name: 'Pitch Env', min: -24, max: 24, default: 0, unit: 'st' },
    { id: 'pAtk',     name: 'P Atk',     min: 0.0005, max: 1, default: 0.002, unit: 's' },
    { id: 'pDec',     name: 'P Dec',     min: 0.001, max: 2, default: 0.06, unit: 's' },

    { id: 'lfoShape', name: 'LFO Wave',  min: 0, max: LFO_SHAPES.length - 1, default: 0, unit: '' },
    { id: 'lfoSync',  name: 'LFO Sync',  min: 0, max: 1, default: 0, unit: '' },
    { id: 'lfoBeats', name: 'LFO Beats', min: 0.0625, max: 16, default: 1, unit: 'b' },
    { id: 'lfoRate',  name: 'LFO Rate',  min: 0.01, max: 30, default: 5, unit: 'Hz' },
    { id: 'lfoDelay', name: 'LFO Delay', min: 0, max: 4, default: 0.4, unit: 's' },
    { id: 'lfoPitch', name: 'LFO → Pitch', min: 0, max: 100, default: 0, unit: 'ct' },
    { id: 'lfoAmp',   name: 'LFO → Amp',   min: 0, max: 1, default: 0, unit: '' },

    { id: 'unison',    name: 'Unison',  min: 1, max: 3, default: 1, unit: '' },
    { id: 'detune',    name: 'Detune',  min: 0, max: 40, default: 6, unit: 'ct' },
    { id: 'width',     name: 'Width',   min: 0, max: 1, default: 0.3, unit: '' },
    { id: 'spread',    name: 'Spread',  min: 0, max: 1, default: 0.35, unit: '' },
    { id: 'transpose', name: 'Transpose', min: -24, max: 24, default: 0, unit: 'st' },

    { id: 'level', name: 'Level', min: 0, max: 1, default: CALIBRATED_LEVEL, unit: '' },
  );
  return out;
}

/**
 * The analogue drum machine's parameters.
 *
 * Eleven voices, each with the controls that voice actually has rather than a
 * shared set applied to all of them.  That is the whole difference from the
 * kit next door: a kick's BEND and a hat's TUNE are not the same control with
 * two names, and giving every voice "tone" would be a kit with eleven tone
 * knobs rather than a drum machine.
 */
function drumMachineParams(): InstrumentParamDef[] {
  const out: InstrumentParamDef[] = [
    { id: 'tune',   name: 'Master Tune', min: -12, max: 12, default: 0, unit: 'st' },
    { id: 'accent', name: 'Accent',      min: 0, max: 1, default: 0.7, unit: '' },
    { id: 'width',  name: 'Width',       min: 0, max: 1, default: 0.6, unit: '' },

    { id: 'bdtune',  name: 'Kick Tune',  min: 28, max: 120, default: 52, unit: 'Hz' },
    { id: 'bddec',   name: 'Kick Decay', min: 0.05, max: DRUM_MAX_DECAY.bd, default: 0.55, unit: 's' },
    { id: 'bdbend',  name: 'Kick Bend',  min: 0, max: 48, default: 26, unit: 'st' },
    { id: 'bdsnap',  name: 'Kick Snap',  min: 0, max: 1, default: 0.4, unit: '' },
    { id: 'bddrive', name: 'Kick Drive', min: 1, max: 8, default: 1.4, unit: '×' },
    { id: 'bdlvl',   name: 'Kick Level', min: 0, max: 1, default: 0.95, unit: '' },

    { id: 'sdtune',    name: 'Snare Tune',   min: 100, max: 420, default: 185, unit: 'Hz' },
    { id: 'sddec',     name: 'Snare Decay',  min: 0.05, max: DRUM_MAX_DECAY.sd, default: 0.28, unit: 's' },
    { id: 'sdtone',    name: 'Snare Tone',   min: 0, max: 1, default: 0.5, unit: '' },
    { id: 'sdsnappy',  name: 'Snappy',       min: 0, max: 1, default: 0.6, unit: '' },
    { id: 'sdsnapdec', name: 'Snappy Decay', min: 0.02, max: 0.8, default: 0.16, unit: 's' },
    { id: 'sdlvl',     name: 'Snare Level',  min: 0, max: 1, default: 0.8, unit: '' },

    { id: 'cptune',   name: 'Clap Tone',   min: 500, max: 2200, default: 1050, unit: 'Hz' },
    { id: 'cpdec',    name: 'Clap Decay',  min: 0.05, max: DRUM_MAX_DECAY.cp, default: 0.3, unit: 's' },
    { id: 'cpspread', name: 'Clap Spread', min: 0.2, max: 3, default: 1, unit: '×' },
    { id: 'cplvl',    name: 'Clap Level',  min: 0, max: 1, default: 0.7, unit: '' },
  ];
  const toms: Array<[string, string, number, number]> = [
    ['lt', 'Low Tom', 95, 0.55],
    ['mt', 'Mid Tom', 140, 0.45],
    ['ht', 'Hi Tom', 205, 0.38],
  ];
  for (const [id, name, hz, dec] of toms) {
    out.push(
      { id: `${id}tune`, name: `${name} Tune`, min: 50, max: 400, default: hz, unit: 'Hz' },
      { id: `${id}dec`,  name: `${name} Decay`, min: 0.05, max: DRUM_MAX_DECAY[id as 'lt'], default: dec, unit: 's' },
      { id: `${id}bend`, name: `${name} Bend`, min: 0, max: 24, default: 8, unit: 'st' },
      { id: `${id}lvl`,  name: `${name} Level`, min: 0, max: 1, default: 0.75, unit: '' },
    );
  }
  out.push(
    { id: 'chtune', name: 'Hat Tune',   min: 200, max: 1200, default: 540, unit: 'Hz' },
    { id: 'chdec',  name: 'Hat Decay',  min: 0.01, max: DRUM_MAX_DECAY.ch, default: 0.06, unit: 's' },
    { id: 'chlvl',  name: 'Hat Level',  min: 0, max: 1, default: 0.6, unit: '' },
    { id: 'ohdec',  name: 'Open Decay', min: 0.05, max: DRUM_MAX_DECAY.oh, default: 0.55, unit: 's' },
    { id: 'ohlvl',  name: 'Open Level', min: 0, max: 1, default: 0.6, unit: '' },

    { id: 'cytune', name: 'Cymbal Tune',  min: 120, max: 800, default: 320, unit: 'Hz' },
    { id: 'cydec',  name: 'Cymbal Decay', min: 0.1, max: DRUM_MAX_DECAY.cy, default: 1.8, unit: 's' },
    { id: 'cylvl',  name: 'Cymbal Level', min: 0, max: 1, default: 0.55, unit: '' },

    { id: 'rstune', name: 'Rim Tune',  min: 600, max: 3000, default: 1650, unit: 'Hz' },
    { id: 'rsdec',  name: 'Rim Decay', min: 0.01, max: DRUM_MAX_DECAY.rs, default: 0.07, unit: 's' },
    { id: 'rslvl',  name: 'Rim Level', min: 0, max: 1, default: 0.6, unit: '' },

    { id: 'cbtune', name: 'Cowbell Tune',  min: 300, max: 1200, default: 545, unit: 'Hz' },
    { id: 'cbdec',  name: 'Cowbell Decay', min: 0.05, max: DRUM_MAX_DECAY.cb, default: 0.32, unit: 's' },
    { id: 'cblvl',  name: 'Cowbell Level', min: 0, max: 1, default: 0.55, unit: '' },

    { id: 'level', name: 'Level', min: 0, max: 1, default: CALIBRATED_LEVEL, unit: '' },
  );
  return out;
}

const DRUM_MACHINE_PARAMS: InstrumentParamDef[] = drumMachineParams();
const DRUM_MACHINE_PARAM_IDS: readonly string[] = DRUM_MACHINE_PARAMS.map((d) => d.id);

const DRUM_MACHINE_CACHE = new Map<string, { left: Float32Array; right: Float32Array }>();
const DRUM_MACHINE_CACHE_MAX = 160;

function drumMachineVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, when, params } = v;
  const pitch = soundingPitch(note);
  const voice = drumVoiceFor(pitch);
  const velocity = Math.round(Math.min(1, Math.max(0, note.velocity)) * 24) / 24;
  const seconds = drumTail(voice, params);

  // A drum's length is its own, not the note's: holding a kick does not make
  // it longer on any machine this models, and a part written on a grid holds
  // every note for a sixteenth.
  const seed = Math.round(note.startBeat * 96) ^ (pitch * 2654435761);

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const fold = (x: number): void => {
    const q = Math.round(x * 1e6) | 0;
    h1 = Math.imul(h1 ^ q, 16777619) >>> 0;
    h2 = Math.imul(h2 + q, 2246822519) >>> 0;
  };
  for (const id of DRUM_MACHINE_PARAM_IDS) fold(params[id] ?? 0);
  fold(pitch); fold(velocity); fold(seed); fold(ctx.sampleRate);
  const key = `${h1.toString(36)}.${h2.toString(36)}`;

  let rendered = DRUM_MACHINE_CACHE.get(key);
  if (!rendered) {
    rendered = renderDrumVoice({
      sampleRate: ctx.sampleRate, seconds, voice, velocity, seed, params,
    });
    if (DRUM_MACHINE_CACHE.size >= DRUM_MACHINE_CACHE_MAX) {
      const oldest = DRUM_MACHINE_CACHE.keys().next().value;
      if (oldest !== undefined) DRUM_MACHINE_CACHE.delete(oldest);
    }
    DRUM_MACHINE_CACHE.set(key, rendered);
  }

  const buf = ctx.createBuffer(2, rendered.left.length, ctx.sampleRate);
  buf.getChannelData(0).set(rendered.left);
  buf.getChannelData(1).set(rendered.right);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const amp = ctx.createGain();
  const trim = INSTRUMENT_TRIM['drummachine'] ?? 1;
  amp.gain.value = trim * Math.max(0, Math.min(1, params['level'] ?? CALIBRATED_LEVEL));
  src.connect(amp).connect(destination);
  const start = Math.max(0, when);
  src.start(start);
  src.stop(start + seconds + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try { src.disconnect(); amp.disconnect(); } catch { /* ignore */ }
    },
  };
}

const FM_PARAMS: InstrumentParamDef[] = fmParams();
const FM_PARAM_IDS: readonly string[] = FM_PARAMS.map((d) => d.id);

const FM_CACHE = new Map<string, { left: Float32Array; right: Float32Array }>();
const FM_CACHE_MAX = 96;

function fmVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const pitch = soundingPitch(note);
  const freq = pitchToFrequency(pitch);
  const velocity = Math.round(Math.min(1, Math.max(0, note.velocity)) * 24) / 24;
  const gate = Math.max(0.01, durationSec);
  const seconds = Math.min(30, gate + fmTail(params));

  // `fine` is folded into the ratio here rather than inside the render loop:
  // it never changes during a note, and doing it per sample would be six
  // `Math.pow` calls per sample for a number that is constant.
  const tuned: Record<string, number> = { ...params };
  for (let i = 1; i <= FM_OPERATORS; i++) {
    const cents = params[`o${i}fine`] ?? 0;
    if (cents !== 0) {
      tuned[`o${i}ratio`] = (params[`o${i}ratio`] ?? 1) * Math.pow(2, cents / 1200);
    }
  }

  const spec = {
    sampleRate: ctx.sampleRate, seconds, gateSec: gate, freqHz: freq, pitch, velocity,
    params: tuned,
    beatsPerSec: durationSec > 1e-6 && note.durationBeat > 1e-6
      ? note.durationBeat / durationSec
      : 2,
  };

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const fold = (x: number): void => {
    const q = Math.round(x * 1e6) | 0;
    h1 = Math.imul(h1 ^ q, 16777619) >>> 0;
    h2 = Math.imul(h2 + q, 2246822519) >>> 0;
  };
  for (const id of FM_PARAM_IDS) fold(tuned[id] ?? 0);
  fold(freq); fold(velocity); fold(seconds); fold(gate);
  fold(pitch); fold(spec.beatsPerSec); fold(ctx.sampleRate);
  const key = `${h1.toString(36)}.${h2.toString(36)}`;

  let rendered = FM_CACHE.get(key);
  if (!rendered) {
    rendered = renderFmVoice(spec);
    if (FM_CACHE.size >= FM_CACHE_MAX) {
      const oldest = FM_CACHE.keys().next().value;
      if (oldest !== undefined) FM_CACHE.delete(oldest);
    }
    FM_CACHE.set(key, rendered);
  }

  const buf = ctx.createBuffer(2, rendered.left.length, ctx.sampleRate);
  buf.getChannelData(0).set(rendered.left);
  buf.getChannelData(1).set(rendered.right);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const amp = ctx.createGain();
  amp.gain.value = 1;
  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );
  src.connect(amp).connect(destination);
  const start = Math.max(0, when);
  src.start(start);
  src.stop(start + seconds + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try { src.disconnect(); amp.disconnect(); } catch { /* ignore */ }
    },
  };
}

const BOWED_CACHE = new Map<string, { left: Float32Array; right: Float32Array }>();
const BOWED_CACHE_MAX = 64;

/**
 * One bowed note.
 *
 * Rendered rather than wired, for the same reason the plucked string is: the
 * friction has to be solved sample by sample against a delay line that IS the
 * pitch, and there is no arrangement of native nodes that does that.  Cached
 * on every input, because a held string section is the same note again and
 * again and solving it twice is wasted.
 */
function bowedVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const pitch = soundingPitch(note);
  const freq = pitchToFrequency(pitch);
  const velocity = Math.round(Math.min(1, Math.max(0, note.velocity)) * 24) / 24;
  const gate = Math.max(0.02, durationSec);
  const seconds = Math.min(30, gate + bowedTail(params));

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const fold = (x: number): void => {
    const q = Math.round(x * 1e6) | 0;
    h1 = Math.imul(h1 ^ q, 16777619) >>> 0;
    h2 = Math.imul(h2 + q, 2246822519) >>> 0;
  };
  for (const id of BOWED_PARAM_IDS) fold(params[id] ?? 0);
  fold(freq); fold(pitch); fold(velocity); fold(seconds); fold(gate);
  fold(note.startBeat); fold(ctx.sampleRate);
  const key = `${h1.toString(36)}.${h2.toString(36)}`;

  let rendered = BOWED_CACHE.get(key);
  if (!rendered) {
    rendered = renderBowedVoice({
      sampleRate: ctx.sampleRate, seconds, gateSec: gate, freqHz: freq, pitch,
      velocity, startBeat: note.startBeat, params,
    });
    if (BOWED_CACHE.size >= BOWED_CACHE_MAX) {
      const oldest = BOWED_CACHE.keys().next().value;
      if (oldest !== undefined) BOWED_CACHE.delete(oldest);
    }
    BOWED_CACHE.set(key, rendered);
  }

  const buf = ctx.createBuffer(2, rendered.left.length, ctx.sampleRate);
  buf.getChannelData(0).set(rendered.left);
  buf.getChannelData(1).set(rendered.right);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const amp = ctx.createGain();
  amp.gain.value = 1;
  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );
  src.connect(amp).connect(destination);
  const start = Math.max(0, when);
  src.start(start);
  src.stop(start + seconds + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try { src.disconnect(); amp.disconnect(); } catch { /* ignore */ }
    },
  };
}

const ANALOG_PARAMS: InstrumentParamDef[] = analogParams();
const ANALOG_PARAM_IDS: readonly string[] = ANALOG_PARAMS.map((d) => d.id);

const ANALOG_CACHE = new Map<string, { left: Float32Array; right: Float32Array }>();
const ANALOG_CACHE_MAX = 96;

function analogVoice(v: VoiceContext): { stop: (at: number) => void } {
  const { ctx, destination, note, config, when, durationSec, params } = v;
  const pitch = soundingPitch(note);
  const freq = pitchToFrequency(pitch);
  const velocity = Math.round(Math.min(1, Math.max(0, note.velocity)) * 24) / 24;
  const gate = Math.max(0.01, durationSec);
  const seconds = Math.min(30, gate + analogTail(params));

  const spec = {
    sampleRate: ctx.sampleRate, seconds, gateSec: gate, freqHz: freq, pitch, velocity,
    slot: voiceSlot(pitch, note.startBeat, params['voices'] ?? 6),
    startBeat: note.startBeat,
    params,
    beatsPerSec: durationSec > 1e-6 && note.durationBeat > 1e-6
      ? note.durationBeat / durationSec
      : 2,
  };

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const fold = (x: number): void => {
    const q = Math.round(x * 1e6) | 0;
    h1 = Math.imul(h1 ^ q, 16777619) >>> 0;
    h2 = Math.imul(h2 + q, 2246822519) >>> 0;
  };
  for (const id of ANALOG_PARAM_IDS) fold(params[id] ?? 0);
  fold(freq); fold(velocity); fold(seconds); fold(gate);
  fold(spec.slot); fold(note.startBeat); fold(spec.beatsPerSec); fold(ctx.sampleRate);
  const key = `${h1.toString(36)}.${h2.toString(36)}`;

  let rendered = ANALOG_CACHE.get(key);
  if (!rendered) {
    rendered = renderAnalogVoice(spec);
    if (ANALOG_CACHE.size >= ANALOG_CACHE_MAX) {
      const oldest = ANALOG_CACHE.keys().next().value;
      if (oldest !== undefined) ANALOG_CACHE.delete(oldest);
    }
    ANALOG_CACHE.set(key, rendered);
  }

  const buf = ctx.createBuffer(2, rendered.left.length, ctx.sampleRate);
  buf.getChannelData(0).set(rendered.left);
  buf.getChannelData(1).set(rendered.right);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const amp = ctx.createGain();
  amp.gain.value = 1;
  scheduleCurve(
    src.detune, note, { kind: 'pitchBend' }, when, durationSec,
    (val) => val * config.bendRangeSemitones * 100, 0,
  );
  src.connect(amp).connect(destination);
  const start = Math.max(0, when);
  src.start(start);
  src.stop(start + seconds + 0.02);
  return {
    stop: (at: number) => {
      try { src.stop(at); } catch { /* already stopped */ }
      try { src.disconnect(); amp.disconnect(); } catch { /* ignore */ }
    },
  };
}

// ── The poly synth's oscillator bank ────────────────────────────────────────

/**
 * The shapes the `wave` parameter selects, in its own order.
 *
 * An index rather than a name for the same reason the kit is one (see
 * drum-presets.ts): `instrumentParams` is `Record<string, number>`, and
 * everything that carries a track — save, undo, template, freeze, bounce,
 * automation — carries a number without being taught what it means.
 */
const SYNTH_WAVES = ['saw', 'square', 'pulse', 'triangle', 'sine'] as const;
type SynthWave = typeof SYNTH_WAVES[number];

/**
 * The highest a filter cutoff is allowed to reach.
 *
 * Taken with the sample rate: a biquad's coefficients are only defined below
 * Nyquist, and the offline bounce can run at a different rate from the
 * preview.
 */
const FILTER_CEILING_HZ = 18_000;

/**
 * What inserting a StereoPanner costs, and why it has to be given back.
 *
 * A mono node connected straight to a stereo destination is UP-MIXED: both
 * channels carry the whole signal, so the total power is twice the source's.
 * A StereoPanner does not up-mix — it divides one signal between two
 * channels, and equal-power panning keeps the sum at exactly the source's
 * power whatever the position, centre included.
 *
 * So the moment a panner appears in a path that had none, the total drops
 * 3 dB — measured, the synth went from −26.0 to −29.0 LUFS on the day Width
 * was added, and the unison check caught it as "Unison is a volume knob".
 * Without this factor Width would BE a level control, which is the one thing
 * every control here is not allowed to be.
 *
 * Exactly √2, and exactly independent of the pan position: cos²x + sin²x = 1
 * for every x.
 */
const PANNER_MAKEUP = Math.SQRT2;

/** Most voices one note may stack.  Seven is already seven oscillators. */
const MAX_UNISON = 7;

/**
 * Where each unison voice starts in its cycle.
 *
 * These are not evenly spaced, and the first attempt at this was — which is
 * the worst possible choice and it took a measurement to see it.  Summing n
 * copies of a wave at phases k/n cancels every harmonic that is not a
 * multiple of n: measured, the stack lost up to 188 dB of a harmonic, and a
 * seven-voice unison at zero detune came out 8.35 dB QUIETER than one voice.
 * A comb filter, not a unison.
 *
 * What unison needs is phases that behave like random ones — where the n
 * voices sum to about √n, the way incoherent sources do.  Low-discrepancy
 * sequences are no good either, for the same reason: being evenly spread is
 * exactly the property that cancels.  So these were SEARCHED for, scored on
 * two things at once over every prefix of 2…7 voices and the first 24
 * harmonics:
 *
 *   · each harmonic sums to within 7.3 dB of √n — no systematic comb
 *   · the summed waveform's PEAK stays within 2.8 dB of √n — the onset does
 *     not grow with the voice count, which is what would click and clip
 */
const UNISON_PHASES = [0, 0.0073, 0.5701, 0.2179, 0.3942, 0.9949, 0.2544] as const;

/**
 * Most harmonics a built wave may carry, and how many it actually gets.
 *
 * A fixed 64 was wrong in both directions at once, and measuring the
 * oscillator across the keyboard is what showed it:
 *
 *   LOW notes were truncated.  A sawtooth at C1 ran out of harmonics at
 *   2 kHz while the same wave at C4 reached 16.7 kHz — so brightness
 *   depended on WHICH NOTE was played, and a bass line got brighter as it
 *   climbed.  No oscillator behaves that way; every bass patch was dull.
 *
 *   HIGH notes aliased.  At C8, 64 harmonics reach 268 kHz, and what comes
 *   back is −20.6 dB of energy at frequencies that are not harmonics of
 *   anything.
 *
 * Both are the same mistake — a harmonic count that ignores the pitch it is
 * played at.  The count is now the largest power of two that fits under
 * Nyquist, which is one table per octave rather than one per note: at worst
 * it spends half the harmonics available, and on a spectrum falling at
 * 6 dB/octave the ones it gives up are the quietest there are.
 */
const WAVE_HARMONICS_MAX = 512;
const WAVE_HARMONICS_MIN = 4;

function harmonicsFor(freqHz: number, sampleRate: number): number {
  const fits = sampleRate / 2 / Math.max(1, freqHz);
  const pow2 = Math.pow(2, Math.floor(Math.log2(Math.max(1, fits))));
  return Math.max(WAVE_HARMONICS_MIN, Math.min(WAVE_HARMONICS_MAX, pow2));
}

/**
 * Built waves, per context.
 *
 * Keyed by the context and not only by the shape, because a PeriodicWave
 * belongs to the context that made it — the same trap `stringBuffer` avoids
 * by caching samples rather than an AudioBuffer, and the offline bounce runs
 * in a different context from the preview.
 */
const WAVE_CACHE = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/**
 * One wave shape, BUILT rather than picked.
 *
 * `OscillatorNode.type` covers saw, square and triangle, and not the two
 * things patches need most:
 *
 *   A PULSE WIDTH, which is a different waveform at every setting — narrowing
 *   a pulse is what turns a synth brass into a reedy lead, and the type-based
 *   oscillators have exactly one duty cycle.
 *
 *   A STARTING PHASE, which the API does not expose at all.  Every oscillator
 *   starts at phase zero, so a unison stack built from them begins perfectly
 *   in step: it sums coherently for the first milliseconds (a click, and a
 *   peak that grows with the voice count) and reads thin afterwards, because
 *   the whole point of unison is voices that are NOT in step.  Rotating
 *   harmonic n by n·φ shifts the wave in time without changing its shape,
 *   which is the per-voice phase offset the API will not give.
 */
function synthWave(
  ctx: BaseAudioContext, kind: SynthWave, pulseWidth: number, phase: number,
  harmonics: number,
): PeriodicWave {
  let perContext = WAVE_CACHE.get(ctx);
  if (!perContext) { perContext = new Map(); WAVE_CACHE.set(ctx, perContext); }
  const key = `${kind}|${kind === 'pulse' ? pulseWidth.toFixed(3) : '-'}|${phase.toFixed(4)}|${harmonics}`;
  const hit = perContext.get(key);
  if (hit) return hit;

  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    let a = 0, b = 0;
    const odd = n % 2 === 1;
    if (kind === 'saw') b = 1 / n;
    else if (kind === 'square') b = odd ? 1 / n : 0;
    // A pulse of duty w: the sine terms cancel and the cosine ones carry
    // sin(nπw) — which is why w = 0.5 silences every even harmonic and hands
    // back a square, and why narrowing it brings them all in.
    else if (kind === 'pulse') a = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * pulseWidth);
    else if (kind === 'triangle') b = odd ? (8 / (Math.PI * Math.PI * n * n)) * (((n - 1) / 2) % 2 === 0 ? 1 : -1) : 0;
    else b = n === 1 ? 1 : 0;

    const angle = 2 * Math.PI * n * phase;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    real[n] = a * cos + b * sin;
    imag[n] = b * cos - a * sin;
  }

  const wave = ctx.createPeriodicWave(real, imag);
  perContext.set(key, wave);
  return wave;
}

/**
 * The drive curve, gain-compensated so that Drive is a TIMBRE control.
 *
 * Same rule the Rhodes' Level had to be taught (see instrument-level.ts): a
 * control that shapes the sound must not also move the loudness, or the user
 * cannot tell which of the two they are hearing.
 *
 * Dividing by `tanh(k)` — which is what this did first — does NOT achieve
 * that, and a break test is what said so.  It normalises the curve's
 * ENDPOINTS, and by k = 2 (drive 0.07) tanh(k) is already 0.96 and on its way
 * to 1, so past the very bottom of the knob it divides by nothing.  What
 * actually moves is the RMS: squaring off a sine raises it by 3 dB however
 * the endpoints are scaled.
 *
 * So the compensation is measured from the curve instead — the RMS it gives
 * a full-scale sine, against the RMS of that sine.  A sine because it is the
 * worst case for this: the more a waveform already resembles what tanh turns
 * it into, the less the shaper changes, and a sine resembles it least.
 */
function driveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const k = 1 + 14 * amount;
  const shape = (x: number): number => Math.tanh(x * k) / Math.tanh(k);

  let sum = 0;
  const STEPS = 512;
  for (let i = 0; i < STEPS; i++) {
    const y = shape(Math.sin((2 * Math.PI * i) / STEPS));
    sum += y * y;
  }
  const outRms = Math.sqrt(sum / STEPS);
  const compensation = outRms > 1e-6 ? Math.SQRT1_2 / outRms : 1;

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = shape((i / (n - 1)) * 2 - 1) * compensation;
  }
  return out;
}

export const INSTRUMENTS: InstrumentDescriptor[] = [
  {
    id: 'polysynth',
    name: 'Poly Synth',
    // Two detuned saws through a fixed lowpass is one sound with an envelope
    // on it, and no number of presets makes it more than one.  The parameters
    // below the original eight are what a patch can actually differ BY: a
    // shape, a width, a stack, a filter that moves, something to move it.
    //
    // Every one of them rests at "off", so the eight that were here keep both
    // their ids and their behaviour and a session saved before this opens
    // sounding like itself.
    params: [
      { id: 'wave',      name: 'Wave',    min: 0,     max: 4,     default: 0,     unit: '' },
      { id: 'pulseWidth', name: 'Width',  min: 0.05,  max: 0.5,   default: 0.25,  unit: '' },
      { id: 'voices',    name: 'Unison',  min: 1,     max: 7,     default: 2,     unit: '' },
      { id: 'detune',    name: 'Detune',  min: 0,     max: 40,    default: 8,     unit: 'ct' },
      { id: 'sub',       name: 'Sub',     min: 0,     max: 1,     default: 0,     unit: '' },
      { id: 'noise',     name: 'Noise',   min: 0,     max: 1,     default: 0,     unit: '' },

      { id: 'cutoffHz',  name: 'Cutoff',  min: 200,   max: 12000, default: 2800,  unit: 'Hz' },
      { id: 'resonance', name: 'Reso',    min: 0.1,   max: 12,    default: 1.2,   unit: '' },
      { id: 'keyTrack',  name: 'Key Trk', min: 0,     max: 1,     default: 0,     unit: '' },
      { id: 'fegAmount', name: 'Env Amt', min: -4,    max: 6,     default: 0,     unit: 'oct' },
      { id: 'fegAttack', name: 'Env Atk', min: 0.001, max: 2,     default: 0.005, unit: 's' },
      { id: 'fegDecay',  name: 'Env Dec', min: 0.02,  max: 4,     default: 0.4,   unit: 's' },

      { id: 'attack',    name: 'Attack',  min: 0.001, max: 2,     default: 0.008, unit: 's' },
      { id: 'decay',     name: 'Decay',   min: 0.01,  max: 3,     default: 0.18,  unit: 's' },
      { id: 'sustain',   name: 'Sustain', min: 0,     max: 1,     default: 0.65,  unit: '' },
      { id: 'release',   name: 'Release', min: 0.01,  max: 4,     default: 0.22,  unit: 's' },

      { id: 'lfoRate',   name: 'LFO',     min: 0,     max: 12,    default: 0,     unit: 'Hz' },
      { id: 'lfoPitch',  name: 'Vibrato', min: 0,     max: 100,   default: 0,     unit: 'ct' },
      { id: 'lfoFilter', name: 'Wobble',  min: 0,     max: 4,     default: 0,     unit: 'oct' },

      { id: 'drive',     name: 'Drive',   min: 0,     max: 1,     default: 0,     unit: '' },
      { id: 'width',     name: 'Width',   min: 0,     max: 1,     default: 0.35,  unit: '' },
      { id: 'level',     name: 'Level',   min: 0,     max: 1,     default: CALIBRATED_LEVEL, unit: '' },
    ],
    playNote: ({ ctx, destination, note, config, when, durationSec, params }) => {
      const freq = pitchToFrequency(soundingPitch(note));
      const start = Math.max(0, when);
      const detune = params['detune'] ?? 8;
      const bendCents = (normalized: number): number => normalized * config.bendRangeSemitones * 100;

      const amp = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      // NOT converted, deliberately.  Web Audio reads this in decibels (see
      // `BUTTERWORTH_Q`), so the knob's 0.1-to-12 is really a Q of 1.01 to
      // 4.0 — tamer at the top than the number suggests.  Every patch in the
      // library was voiced by ear against that, so changing the units here
      // would re-voice all of them to fix a label nobody reads.  The number
      // is documented rather than corrected.
      filter.Q.value = params['resonance'] ?? 1.2;

      // ── The stack ───────────────────────────────────────────────────────
      const voices = Math.max(1, Math.min(MAX_UNISON, Math.round(params['voices'] ?? 2)));
      const kind = SYNTH_WAVES[Math.max(0, Math.min(SYNTH_WAVES.length - 1,
        Math.round(params['wave'] ?? 0)))] ?? 'saw';
      const pulseWidth = params['pulseWidth'] ?? 0.25;

      // Every instrument here was dead mono until Width — measured, the side
      // channel of all four sat at negative infinity.  It is given where
      // there is something physical to spread and not otherwise: a unison
      // stack is many sources and belongs across the field; one plucked
      // string is one source and does not.
      const width = Math.max(0, Math.min(1, params['width'] ?? 0.35));

      const oscMix = ctx.createGain();
      // Power, not amplitude.  Detuned voices drift out of step within a cycle
      // or two, so they add the way noise does rather than the way one louder
      // oscillator would — dividing by the count instead would make Unison a
      // volume knob that gets quieter as it gets wider.
      const spreadVoices = width > 0.001 && voices > 1;
      oscMix.gain.value = (1 / Math.sqrt(voices)) * (spreadVoices ? PANNER_MAKEUP : 1);
      oscMix.connect(filter);

      const oscs: OscillatorNode[] = [];
      const pans: StereoPannerNode[] = [];
      for (let i = 0; i < voices; i++) {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(synthWave(ctx, kind, pulseWidth, UNISON_PHASES[i] ?? 0,
          harmonicsFor(freq, ctx.sampleRate)));
        osc.frequency.value = freq;
        // Spread evenly across ±detune, so an odd count always keeps one
        // voice at pitch and an even one stays symmetric about it.
        const spread = voices === 1 ? 0 : (i / (voices - 1)) * 2 - 1;
        const cents = spread * detune;
        scheduleCurve(osc.detune, note, { kind: 'pitchBend' }, when, durationSec,
          (v) => bendCents(v) + cents, 0);
        // The same spread that detunes it places it.  The voice a listener
        // hears as furthest out of tune is the one furthest to the side,
        // which is what a real stack of oscillators through a real desk
        // does, and it is why a wide unison reads as wide rather than as
        // merely blurred.
        if (spreadVoices) {
          const pan = ctx.createStereoPanner();
          pan.pan.value = spread * width;
          osc.connect(pan).connect(oscMix);
          pans.push(pan);
        } else {
          osc.connect(oscMix);
        }
        oscs.push(osc);
      }

      // The sub and the noise join AFTER the unison scaling: neither of them
      // is part of the stack, and neither should get quieter for widening it.
      const subAmount = params['sub'] ?? 0;
      let subOsc: OscillatorNode | null = null;
      if (subAmount > 0.001) {
        subOsc = ctx.createOscillator();
        // Its own count: the sub is an octave down, so twice as many
        // harmonics fit under Nyquist as the note above it.
        subOsc.setPeriodicWave(synthWave(ctx, 'square', 0.5, 0,
          harmonicsFor(freq / 2, ctx.sampleRate)));
        subOsc.frequency.value = freq / 2;
        scheduleCurve(subOsc.detune, note, { kind: 'pitchBend' }, when, durationSec, bendCents, 0);
        const g = ctx.createGain();
        g.gain.value = subAmount * 0.8;
        subOsc.connect(g).connect(filter);
      }

      const noiseAmount = params['noise'] ?? 0;
      let noise: AudioBufferSourceNode | null = null;
      if (noiseAmount > 0.001) {
        noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer(ctx, noteSeed(note));
        noise.loop = true;
        const g = ctx.createGain();
        g.gain.value = noiseAmount * 0.3;
        noise.connect(g).connect(filter);
      }

      // ── The filter ──────────────────────────────────────────────────────
      // A cutoff that does not follow the keyboard sounds duller the higher
      // you play, because the same frequency takes more off a higher note.
      const keyTrack = Math.max(0, Math.min(1, params['keyTrack'] ?? 0));
      const baseCutoff = (params['cutoffHz'] ?? 2800) * Math.pow(freq / 261.6256, keyTrack);
      const velocityCutoff = baseCutoff * (0.45 + 0.85 * note.velocity);

      // How far the modulation may push the cutoff.
      //
      // `frequency` is clamped below, but the envelope and the LFO both write
      // CENTS to `detune`, and cents are unclamped — so a bright patch with a
      // positive envelope multiplies its way straight past Nyquist.  A biquad
      // has no coefficients up there: it went non-finite, the samples reached
      // the drive shaper's oversampler, and the whole node was removed from
      // the graph mid-render.  Which is to say the patch went silent and the
      // only sign was a line on stderr.
      //
      // So the two modulators share a budget, measured from the highest the
      // cutoff can already be driven by velocity and the timbre curve.
      const ceilingHz = Math.min(FILTER_CEILING_HZ, ctx.sampleRate * 0.45);
      const reachableHz = Math.min(ceilingHz, velocityCutoff * 2.2);
      const headroomCents = 1200 * Math.log2(Math.max(1, ceilingHz / reachableHz));

      const fegAmount = params['fegAmount'] ?? 0;
      if (Math.abs(fegAmount) > 0.001) {
        // On `detune`, not on `frequency`.  Frequency already carries the MPE
        // timbre curve, and two writers on one AudioParam is one of them
        // silently losing — which is how a filter envelope would appear to
        // work everywhere except under an expressive controller.  Cents are
        // the right unit anyway: an octave is 1200 of them at any pitch.
        const fa = Math.max(0.001, params['fegAttack'] ?? 0.005);
        const fd = Math.max(0.02, params['fegDecay'] ?? 0.4);
        const peakCents = Math.max(-4800, Math.min(fegAmount * 1200, headroomCents));
        filter.detune.setValueAtTime(0, start);
        filter.detune.linearRampToValueAtTime(peakCents, start + fa);
        filter.detune.linearRampToValueAtTime(0, start + fa + fd);
      }

      scheduleCurve(
        filter.frequency, note, { kind: 'timbre' }, when, durationSec,
        (v) => Math.min(ceilingHz, velocityCutoff * (0.6 + 1.6 * v)), 0.5,
      );
      scheduleCurve(
        amp.gain, note, { kind: 'pressure' }, when, durationSec,
        () => 1, 1,
      );

      // ── The LFO ─────────────────────────────────────────────────────────
      const lfoRate = params['lfoRate'] ?? 0;
      let lfo: OscillatorNode | null = null;
      if (lfoRate > 0.01) {
        lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = lfoRate;
        const pitchDepth = params['lfoPitch'] ?? 0;
        if (pitchDepth > 0.01) {
          const g = ctx.createGain();
          g.gain.value = pitchDepth;
          lfo.connect(g);
          // Connected, not scheduled: the pitch bend curve is already the
          // intrinsic value of these params, and a connection SUMS with it
          // instead of replacing it.
          for (const o of oscs) g.connect(o.detune);
          if (subOsc) g.connect(subOsc.detune);
        }
        const filterDepth = params['lfoFilter'] ?? 0;
        if (filterDepth > 0.001) {
          // What the envelope did not spend.  The LFO is the one that gives
          // way, because an envelope that is cut short changes the patch's
          // shape while a wobble that is narrower is still a wobble.
          const spent = Math.max(0, Math.min((params['fegAmount'] ?? 0) * 1200, headroomCents));
          const g = ctx.createGain();
          g.gain.value = Math.min(filterDepth * 1200, Math.max(0, headroomCents - spent));
          lfo.connect(g).connect(filter.detune);
        }
      }

      // ── Out ─────────────────────────────────────────────────────────────
      const drive = params['drive'] ?? 0;
      let shaper: WaveShaperNode | null = null;
      if (drive > 0.001) {
        shaper = ctx.createWaveShaper();
        shaper.curve = driveCurve(drive);
        shaper.oversample = '2x';
      }
      const tail = shaper ? filter.connect(shaper) : filter;
      (tail as AudioNode).connect(amp).connect(destination);

      const peak = (params['level'] ?? CALIBRATED_LEVEL) * INSTRUMENT_TRIM.polysynth
        * (0.25 + 0.75 * note.velocity);
      const releaseEnd = adsr(
        amp.gain, when, durationSec,
        params['attack'] ?? 0.008, params['decay'] ?? 0.18,
        params['sustain'] ?? 0.65, params['release'] ?? 0.22, peak,
      );

      const stopAt = releaseEnd + 0.02;
      for (const o of oscs) { o.start(start); o.stop(stopAt); }
      if (subOsc) { subOsc.start(start); subOsc.stop(stopAt); }
      if (noise) { noise.start(start); noise.stop(stopAt); }
      if (lfo) { lfo.start(start); lfo.stop(stopAt); }

      return {
        stop: (at: number) => {
          for (const o of [...oscs, subOsc, lfo]) {
            if (o) { try { o.stop(at); } catch { /* already stopped */ } }
          }
          if (noise) { try { noise.stop(at); } catch { /* already stopped */ } }
          try {
            for (const o of oscs) o.disconnect();
            for (const p of pans) p.disconnect();
            subOsc?.disconnect(); noise?.disconnect(); lfo?.disconnect();
            oscMix.disconnect(); filter.disconnect(); shaper?.disconnect(); amp.disconnect();
          } catch { /* ignore */ }
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
      { id: 'level',    name: 'Level',    min: 0,    max: 1,   default: CALIBRATED_LEVEL, unit: '' },
      { id: 'bark',     name: 'Bark',     min: 0,    max: 1,   default: 0.7,  unit: '' },
      { id: 'tine',     name: 'Tine',     min: 0,    max: 1,   default: 0.5,  unit: '' },
      { id: 'pickup',   name: 'Pickup',   min: 0,    max: 1,   default: 0.35, unit: '' },
      { id: 'tremRate', name: 'Trem Rate', min: 0,   max: 10,  default: 0,    unit: 'Hz' },
      { id: 'tremDepth', name: 'Trem',    min: 0,    max: 1,   default: 0.35, unit: '' },
      { id: 'width',    name: 'Width',   min: 0,    max: 1,   default: 0.5,  unit: '' },
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
      // Level is a GAIN, and a gain must not change the sound.  It sits here,
      // AFTER the pickup, because the pickup is a waveshaper: driven from the
      // amp envelope instead, turning Level down would have quietened the
      // Rhodes AND cleaned it up, and turning it up would have growled.  That
      // is a drive control wearing a level control's name.  Measured: it was
      // the one instrument of the five whose crest factor moved when nothing
      // but its gain changed.
      const lvl = (params['level'] ?? CALIBRATED_LEVEL) * INSTRUMENT_TRIM.epiano;
      out.gain.value = lvl;
      let lfo: OscillatorNode | null = null;
      let lfoGain: GainNode | null = null;
      let panner: StereoPannerNode | null = null;
      let panDepth: GainNode | null = null;
      if (tremRate > 0.01) {
        const depth = Math.min(1, Math.max(0, params['tremDepth'] ?? 0.35));
        // How much of the tremolo is a PAN rather than a level swing.
        //
        // This is what a suitcase actually does, and it is why a suitcase
        // sounds enormous next to a stage piano through the same amp: the
        // cabinet has two speakers and the oscillator moves the signal
        // between them.  Modelling it as amplitude alone — which is what was
        // here — gets the wobble and throws away the reason anyone wants it.
        //
        // The Rhodes stays MONO when its tremolo is off, which is correct: a
        // stage piano taken from the DI is one source.
        const width = Math.max(0, Math.min(1, params['width'] ?? 0.5));
        lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = tremRate;

        const swing = depth * (1 - width);
        // The makeup goes in here, not on a node of its own: a panner in this
        // path costs 3 dB (see PANNER_MAKEUP), and the tremolo's two halves
        // have to be scaled together or the swing would change with it.
        const makeup = width > 0.001 ? PANNER_MAKEUP : 1;
        lfoGain = ctx.createGain();
        lfoGain.gain.value = lvl * makeup * swing * 0.5;
        out.gain.value = lvl * makeup * (1 - swing * 0.5);
        lfo.connect(lfoGain).connect(out.gain);

        if (width > 0.001) {
          panner = ctx.createStereoPanner();
          panDepth = ctx.createGain();
          panDepth.gain.value = depth * width;
          lfo.connect(panDepth).connect(panner.pan);
        }
        lfo.start(start);
      }

      const tail = shaper ? amp.connect(shaper) : amp;
      const wet = (tail as AudioNode).connect(out);
      (panner ? wet.connect(panner) : wet).connect(destination);

      // What the pickup is driven by: velocity, and nothing else.  The
      // constant is the level the voice was originally tuned at, kept so the
      // move above did not also change how barky the instrument is.
      const peak = EPIANO_PICKUP_DRIVE * (0.2 + 0.8 * vel);
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
      { id: 'damp',    name: 'Damping', min: 0.97, max: 0.9999, default: 0.9955, unit: '' },
      { id: 'bright',  name: 'String',  min: 0,   max: 1,     default: 0.85, unit: '' },
      { id: 'pick',    name: 'Pick',    min: 0.02, max: 0.5,  default: 0.14, unit: '' },
      { id: 'double',  name: 'Double',  min: 0,   max: 1,     default: 0,    unit: '' },
      { id: 'bodyHz',  name: 'Body Hz', min: 60,  max: 400,   default: 110,  unit: 'Hz' },
      { id: 'bodyQ',   name: 'Body Q',  min: 0.3, max: 6,     default: 1.1,  unit: '' },
      { id: 'body',    name: 'Body',    min: -6,  max: 12,    default: 5,    unit: 'dB' },
      { id: 'plate',   name: 'Plate',   min: 0,   max: 12,    default: 0,    unit: 'dB' },
      { id: 'tone',    name: 'Tone',    min: 800, max: 16000, default: 7000, unit: 'Hz' },
      { id: 'width',   name: 'Width',   min: 0,   max: 1,     default: 0.6,  unit: '' },
      { id: 'sustain', name: 'Sustain', min: 0.4, max: 8,     default: 3,    unit: 's' },
      { id: 'release', name: 'Release', min: 0.03, max: 1.2,  default: 0.18, unit: 's' },
      { id: 'level',   name: 'Level',   min: 0,   max: 1,     default: CALIBRATED_LEVEL, unit: '' },
    ],
    // A steel-string body: the big air resonance sits near 100 Hz and the
    // top plate around 200.  Bright, and it loses its highs quickly, which
    // is the difference between an acoustic and an amplified string.
    playNote: (v) => pluckVoice(v, {
      damping: 0.9955, brightness: 0.85,
      pick: v.params['pick'] ?? 0.14,
      bodyHz: 110, bodyQ: 1.1, toneHz: 7000, trim: INSTRUMENT_TRIM.agtr,
    }),
  },

  {
    id: 'egtr',
    name: 'Electric Guitar',
    params: [
      { id: 'damp',    name: 'Damping', min: 0.97, max: 0.9999, default: 0.9987, unit: '' },
      { id: 'bright',  name: 'String',  min: 0,   max: 1,     default: 0.7,  unit: '' },
      { id: 'pick',    name: 'Pick',    min: 0.02, max: 0.5,  default: 0.09, unit: '' },
      { id: 'double',  name: 'Double',  min: 0,   max: 1,     default: 0,    unit: '' },
      { id: 'bodyHz',  name: 'Pickup Hz', min: 60, max: 4000, default: 2500, unit: 'Hz' },
      { id: 'bodyQ',   name: 'Pickup Q', min: 0.3, max: 6,    default: 1.6,  unit: '' },
      { id: 'body',    name: 'Pickup',  min: -6,  max: 12,    default: 6,    unit: 'dB' },
      { id: 'plate',   name: 'Plate',   min: 0,   max: 12,    default: 0,    unit: 'dB' },
      { id: 'tone',    name: 'Tone',    min: 800, max: 12000, default: 3400, unit: 'Hz' },
      { id: 'width',   name: 'Width',   min: 0,   max: 1,     default: 0.6,  unit: '' },
      { id: 'sustain', name: 'Sustain', min: 0.4, max: 8,     default: 5,    unit: 's' },
      { id: 'release', name: 'Release', min: 0.03, max: 1.2,  default: 0.1,  unit: 's' },
      { id: 'level',   name: 'Level',   min: 0,   max: 1,     default: CALIBRATED_LEVEL, unit: '' },
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
      bodyHz: 2500, bodyQ: 1.6, toneHz: 3400, trim: INSTRUMENT_TRIM.egtr,
    }),
  },

  {
    id: 'piano',
    name: 'Grand Piano',
    params: pianoParams({
      hammer: 4600, strike: 0.125, stretch: 1, unison: 1.2,
      bloom: 8, decay: 1, bodyHz: 140, bodyQ: 1.1, tone: 11000,
    }),
    // A concert instrument: long strings, so the fitted inharmonicity stands
    // unscaled, a hammer bright enough to carry a hall, and the strike point
    // at 1/8 where the eighth partial dies.
    playNote: (v) => pianoVoice(v, {
      stretch: 1, hammerHz: 4600, strike: 0.125, decay: 1,
      bodyHz: 140, bodyQ: 1.1, toneHz: 11000, trim: INSTRUMENT_TRIM.piano,
    }),
  },

  {
    id: 'upright',
    name: 'Upright Piano',
    params: pianoParams({
      hammer: 3300, strike: 0.105, stretch: 2.4, unison: 2.6,
      bloom: 5.5, decay: 0.62, bodyHz: 190, bodyQ: 1.9, tone: 7600,
    }),
    // The same instrument with nowhere to put the strings.
    //
    // An upright is a grand stood on its end and cut short, and every
    // difference here follows from the strings being shorter: inharmonicity
    // goes as the inverse cube of length, so 2.4× is a modest reading of what
    // a foreshortened bass does; there is less string to store energy, so it
    // rings well under half as long; the board is smaller and boxier, so its
    // resonance sits higher with a tighter Q.
    //
    // The unison is left wider on purpose.  An upright is the piano in a
    // practice room, and the practice-room piano was last tuned some time ago.
    playNote: (v) => pianoVoice(v, {
      stretch: 2.4, hammerHz: 3300, strike: 0.105, decay: 0.62,
      bodyHz: 190, bodyQ: 1.9, toneHz: 7600, trim: INSTRUMENT_TRIM.upright,
    }),
  },

  {
    id: 'bass',
    name: 'Bass Guitar',
    params: [
      { id: 'damp',    name: 'Damping', min: 0.97, max: 0.9999, default: 0.9992, unit: '' },
      { id: 'bright',  name: 'String',  min: 0,   max: 1,     default: 0.42, unit: '' },
      { id: 'pick',    name: 'Pick',    min: 0.02, max: 0.5,  default: 0.07, unit: '' },
      { id: 'double',  name: 'Double',  min: 0,   max: 1,     default: 0,    unit: '' },
      { id: 'bodyHz',  name: 'Pickup Hz', min: 40, max: 2000, default: 620,  unit: 'Hz' },
      { id: 'bodyQ',   name: 'Pickup Q', min: 0.3, max: 6,    default: 1.2,  unit: '' },
      { id: 'body',    name: 'Pickup',  min: -6,  max: 12,    default: 5,    unit: 'dB' },
      { id: 'plate',   name: 'Plate',   min: 0,   max: 12,    default: 0,    unit: 'dB' },
      { id: 'tone',    name: 'Tone',    min: 800, max: 12000, default: 2200, unit: 'Hz' },
      { id: 'width',   name: 'Width',   min: 0,   max: 1,     default: 0,    unit: '' },
      { id: 'sustain', name: 'Sustain', min: 0.4, max: 8,     default: 4.5,  unit: 's' },
      { id: 'release', name: 'Release', min: 0.03, max: 1.2,  default: 0.12, unit: 's' },
      { id: 'level',   name: 'Level',   min: 0,   max: 1,     default: CALIBRATED_LEVEL, unit: '' },
    ],
    // The same plucked string as the guitars, which is not a shortcut: a bass
    // IS a long guitar string, and what makes it a bass is the register plus
    // three settings.
    //
    //   · plucked close to the bridge (0.07), because that is where a bass is
    //     played and it is what gives the note its edge instead of a boom
    //   · a much duller string (0.42 against the electric's 0.7) — a wound
    //     bass string is heavy, and heavy strings start with fewer highs
    //   · damping close to 1, so it sustains: a bass note that stopped like
    //     an acoustic guitar's would leave a hole under every bar
    //
    // The pickup resonance sits at 620 Hz rather than the electric's 2.5 k
    // because the pickup is four times as far from a much slower string, and
    // that placement is the growl.
    playNote: (v) => pluckVoice(v, {
      damping: 0.9992, brightness: 0.42,
      pick: v.params['pick'] ?? 0.07,
      bodyHz: 620, bodyQ: 1.2, toneHz: 2200, trim: INSTRUMENT_TRIM.bass,
    }),
  },

  {
    id: 'mallet',
    name: 'Mallets',
    params: [
      { id: 'bar',        name: 'Bar',      min: 0,    max: BAR_KINDS.length - 1, default: 0, unit: '' },
      { id: 'hardness',   name: 'Mallet',   min: 0.2,  max: 3,   default: 1,    unit: '×' },
      { id: 'decay',      name: 'Decay',    min: 0.2,  max: 3,   default: 1,    unit: '×' },
      { id: 'damp',       name: 'Damper',   min: 0,    max: 1,   default: 0,    unit: '' },
      { id: 'tube',       name: 'Tube',     min: -6,   max: 14,  default: 5,    unit: 'dB' },
      { id: 'tubeQ',      name: 'Tube Q',   min: 0.3,  max: 8,   default: 2.2,  unit: '' },
      { id: 'motor',      name: 'Motor',    min: 0,    max: 12,  default: 0,    unit: 'Hz' },
      { id: 'motorDepth', name: 'Depth',    min: 0,    max: 1,   default: 0.5,  unit: '' },
      { id: 'spread',     name: 'Spread',   min: 0,    max: 1,   default: 0.35, unit: '' },
      { id: 'level',      name: 'Level',    min: 0,    max: 1,   default: CALIBRATED_LEVEL, unit: '' },
    ],
    // Four instruments behind one `bar` index, for the reason the kit is one
    // instrument behind a `kit` index: everything that carries a track —
    // save, undo, template, freeze, bounce, automation — carries a number
    // without needing to be taught what it means.
    //
    // The Motor only does anything on the vibraphone, which is the only one
    // of the four that has one.  It is left in the list rather than hidden so
    // that the parameter set does not change shape when the Bar does, and the
    // voice ignores it elsewhere.
    playNote: (v) => malletVoice(v),
  },

  {
    id: 'organ',
    name: 'Drawbar Organ',
    params: [
      // Drawn out the way the panel is: 16' and 5⅓' first, then unison up.
      // 8 is all the way out, 0 is pushed in.  888000000 is the one everybody
      // starts from, and it is what these defaults are.
      { id: 'db16',  name: "16'",  min: 0, max: 8, default: 8, unit: '' },
      { id: 'db513', name: "5⅓'", min: 0, max: 8, default: 8, unit: '' },
      { id: 'db8',   name: "8'",   min: 0, max: 8, default: 8, unit: '' },
      { id: 'db4',   name: "4'",   min: 0, max: 8, default: 0, unit: '' },
      { id: 'db223', name: "2⅔'", min: 0, max: 8, default: 0, unit: '' },
      { id: 'db2',   name: "2'",   min: 0, max: 8, default: 0, unit: '' },
      { id: 'db135', name: "1⅗'", min: 0, max: 8, default: 0, unit: '' },
      { id: 'db113', name: "1⅓'", min: 0, max: 8, default: 0, unit: '' },
      { id: 'db1',   name: "1'",   min: 0, max: 8, default: 0, unit: '' },
      { id: 'click', name: 'Click', min: 0, max: 1, default: 0.35, unit: '' },
      { id: 'perc',  name: 'Perc',  min: 0, max: 1, default: 0,    unit: '' },
      { id: 'percHarmonic', name: 'Perc 3rd', min: 0, max: 1, default: 0, unit: '' },
      { id: 'percDecay',    name: 'Perc Dec', min: 0.05, max: 1.5, default: 0.25, unit: 's' },
      { id: 'edge',  name: 'Edge',  min: 0.002, max: 0.03, default: 0.006, unit: 's' },
      { id: 'level', name: 'Level', min: 0, max: 1, default: CALIBRATED_LEVEL, unit: '' },
    ],
    // No rotary speaker here on purpose, and it is the same argument the
    // electric guitar makes about not baking in an amp: the insert chain
    // already has one, and a cabinet welded to the instrument is a cabinet
    // nobody can take off.
    playNote: (v) => organVoice(v),
  },

  {
    id: 'wavesynth',
    name: 'Wavetable Synth',
    params: WAVE_SYNTH_PARAMS,
    // Two tables, a sub, noise, a state-variable filter and eight matrix rows
    // — the whole argument for why it is computed rather than wired lives in
    // `wave-synth.ts`, and the short version is that a `PeriodicWave` cannot
    // be moved while it sounds and a wavetable synth is nothing else.
    playNote: (v) => waveSynthVoice(v),
  },

  {
    id: 'analog',
    name: 'Analog Synth',
    params: ANALOG_PARAMS,
    // Two free-running VCOs that drift, a transistor ladder that saturates
    // and loses its bass as the resonance comes up, capacitor envelopes, and
    // a per-voice component tolerance so a chord is six slightly different
    // instruments.  Every one of those is measured in `analog-model.ts`.
    playNote: (v) => analogVoice(v),
  },

  {
    id: 'fm',
    name: 'FM Synth',
    params: FM_PARAMS,
    // Six operators and thirty-two algorithms.  There is no filter: an FM
    // patch's brightness is its modulator envelopes, which is why every
    // operator has its own and why they are exponential.  The maths, and
    // what the name gets wrong, are in `fm-core.ts`.
    playNote: (v) => fmVoice(v),
  },

  {
    id: 'bowed',
    name: 'Bowed Strings',
    params: BOWED_PARAMS as InstrumentParamDef[],
    // Violin, viola, cello and double bass, as one instrument because they
    // are one instrument: the same friction, the same string, four boxes.
    //
    // The bow is a nonlinearity rather than an envelope, which is what makes
    // a crescendo on one note possible here and impossible on a sampled
    // library.  Bow Speed is loudness, Bow Force is which of the three
    // regimes it plays in, and Bow Position is a comb.  All three are
    // measured in `bowed-string.ts`.
    playNote: (v) => bowedVoice(v),
  },

  {
    id: 'drummachine',
    name: 'Analog Drums',
    params: DRUM_MACHINE_PARAMS,
    // Eleven voices built the way the circuits were rather than the way the
    // drums are — a kick that is a falling sine, hats that are six squares
    // and no noise at all.  Every voice has its own controls, which is the
    // whole difference from the kit below it.  See `drum-machine.ts`.
    playNote: (v) => drumMachineVoice(v),
  },

  {
    id: 'drumkit',
    name: 'Drum Kit',
    params: [
      { id: 'level', name: 'Level', min: 0,    max: 1,  default: CALIBRATED_LEVEL, unit: '' },
      { id: 'tune',  name: 'Tune',  min: -12,  max: 12, default: 0,   unit: 'st' },
      { id: 'decay', name: 'Decay', min: 0.2,  max: 2,  default: 1,   unit: 'x' },
      { id: 'tone',  name: 'Tone',  min: 0.4,  max: 2,  default: 1,   unit: 'x' },
      { id: 'snap',  name: 'Snap',  min: 0,    max: 1,  default: 0.5, unit: '' },
      // Which kit — 0 is the built-in one, 1..10 are the genres in
      // GENRE_ORDER.  A number rather than an enum so every carrier of a
      // track moves it for free; see `drum-presets.ts`.
      { id: 'kit',   name: 'Kit',   min: 0,    max: 10, default: 0,   unit: '' },
    ],
    // The pitch chooses the PIECE, not the note.  Every other instrument here
    // turns the note number into a frequency; a kit that did that would answer
    // a drum part with a chromatic run of bleeps — which is exactly what this
    // app did before, since the drum map named and ordered and choked the rows
    // and then handed the part to a poly synth.
    playNote: drumVoice,
  },

  {
    id: 'sampler',
    name: 'Sampler (SFZ)',
    params: [
      { id: 'level',   name: 'Level',   min: 0,    max: 1,   default: 0.7,  unit: '' },
      { id: 'attack',  name: 'Attack',  min: 0,    max: 0.5, default: 0.001, unit: 's' },
      { id: 'release', name: 'Release', min: 0.02, max: 3,   default: 0.4,  unit: 's' },
      { id: 'rrOff',   name: 'RR Off',  min: 0,    max: 1,   default: 0,    unit: '' },
      { id: 'velTone', name: 'Vel Tone', min: 0,   max: 1,   default: 0.5,  unit: '' },
      { id: 'spread',  name: 'Spread',  min: 0,    max: 1,   default: 0,    unit: '' },
    ],
    // Plays whatever library is loaded.  With none loaded it is SILENT, and
    // that is the honest behaviour: the alternative is a fallback synth tone
    // that makes an empty sampler sound like a working one, and then the
    // first thing anyone reports is that their piano sounds like a beep.
    playNote: ({ ctx, destination, note, config, when, durationSec, params }) => {
      const lib = loadedLibrary();
      const pitch = Math.round(soundingPitch(note));
      const candidates = lib ? zonesFor(lib.set, pitch, note.velocity) : [];
      // The round robin counts per library, not per note: a counter reset on
      // every note would always choose take one, which is the bug a round
      // robin exists to prevent.
      const zone = pickZone(candidates, (params['rrOff'] ?? 0) >= 0.5 ? 0 : nextRoundRobin());
      const buffer = zone ? bufferFor(zone.resolvedPath) : undefined;
      if (!zone || !buffer) return { stop: () => { /* nothing sounding */ } };

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // The zone knows the pitch it was recorded at, so the rate is a
      // function of the sounding pitch and nothing else.
      src.playbackRate.value = playbackRateFor(zone, soundingPitch(note));

      if (zone.loopMode === 'loop_continuous' || zone.loopMode === 'loop_sustain') {
        const rate = buffer.sampleRate;
        src.loop = true;
        src.loopStart = zone.loopStart / rate;
        src.loopEnd = zone.loopEnd > zone.loopStart ? zone.loopEnd / rate : buffer.duration;
      }

      // Where the note sits.  The library's own pan first, then — only if
      // asked — the player's-seat spread that puts low keys left and high
      // keys right.  Default 0: a sampler's stereo image belongs to whoever
      // recorded it, and inventing one is a decision the user makes, not a
      // decision an instrument makes for them.
      const spread = Math.max(0, Math.min(1, params['spread'] ?? 0));
      const keyPlace = Math.max(-1, Math.min(1, (pitch - 60) / 36));
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, zone.pan / 100 + spread * keyPlace));

      // Velocity, where the library left it to us.
      //
      // Measured on a library with one layer per key and on the same library
      // split in two: 0.009 and 0.811.  A sampler's velocity response IS its
      // layers, and a library that has them needs nothing from the engine —
      // adding a fixed amount on top would double what its author already
      // decided.  A library with ONE layer per key gets pure volume, which
      // is what every other instrument here has just stopped doing.
      //
      // So the amount is scaled by how much of the velocity range this zone
      // covers: a zone spanning the whole range said nothing about velocity
      // and is filled in; anything narrower said something and is left
      // alone.  The fade runs out by the time a zone covers half, which is
      // two layers.
      const coverage = (zone.hiVel - zone.loVel + 1) / 128;
      const libraryGap = Math.max(0, Math.min(1, (coverage - 0.6) / 0.4));
      const velTone = Math.max(0, Math.min(1, params['velTone'] ?? 0.5)) * libraryGap;
      let tone: BiquadFilterNode | null = null;
      if (velTone > 0.001) {
        const ceiling = Math.min(FILTER_CEILING_HZ, ctx.sampleRate * 0.45);
        tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.Q.value = BUTTERWORTH_Q;
        tone.frequency.value = ceiling * Math.pow(0.25 + 0.75 * note.velocity, 2.2 * velTone);
      }

      const amp = ctx.createGain();
      scheduleCurve(
        src.detune, note, { kind: 'pitchBend' }, when, durationSec,
        (val) => val * config.bendRangeSemitones * 100, 0,
      );
      const shaped = tone ? src.connect(tone) : src;
      (shaped as AudioNode).connect(pan).connect(amp).connect(destination);

      // The library's own volume, then velocity, then the instrument's level.
      const zoneGain = Math.pow(10, zone.volumeDb / 20);
      const peak = (params['level'] ?? 0.7) * zoneGain * (0.15 + 0.85 * note.velocity);
      const start = Math.max(0, when);
      const attack = Math.max(0.0005, params['attack'] ?? 0.001);
      // A library that states its own release gets it; otherwise the panel's.
      const release = zone.ampegRelease > 0
        ? zone.ampegRelease
        : Math.max(0.02, params['release'] ?? 0.4);
      const noteEnd = start + Math.max(0.02, durationSec);
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
      amp.gain.setValueAtTime(Math.max(0.0002, peak), Math.max(start + attack + 0.001, noteEnd));
      const releaseEnd = noteEnd + release;
      amp.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

      src.start(start);
      src.stop(releaseEnd + 0.02);
      return {
        stop: (at: number) => {
          try { src.stop(at); } catch { /* already stopped */ }
          try {
            src.disconnect(); tone?.disconnect(); pan.disconnect(); amp.disconnect();
          } catch { /* ignore */ }
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
