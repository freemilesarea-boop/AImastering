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

/** Filtered noise, which is the other half of every kit. */
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
  air.Q.value = 0.7;
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
  tone.Q.value = 0.7;

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
        tone.Q.value = 0.7;
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
