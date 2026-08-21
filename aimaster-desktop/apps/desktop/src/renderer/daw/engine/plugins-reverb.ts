// The reverb family.
//
// Four devices, and they are genuinely different machines rather than four
// preset banks over one algorithm:
//
//   Space Reverb    convolution with a synthesised room — 31 places, each one
//                   an image-source model plus a three-band diffuse tail
//   Plate Reverb    a feedback delay network — no room, no early reflections,
//                   dense from the first millisecond, the way a steel sheet is
//   Spring Reverb   a dispersive delay loop — the chirp is the point
//   Shimmer         a reverb whose feedback is pitched up an octave
//
// All of it native Web Audio, so a bounce is the same graph as the monitor.
// That constraint is what shapes the plate and the spring: a feedback delay
// network is legal in this engine because every loop contains a DelayNode, and
// an allpass built from a delay, two gains and a sum is a real allpass rather
// than an approximation of one.
//
// ── The one thing to know about delay loops here ───────────────────────────
//
// A cycle in a Web Audio graph must contain a DelayNode, and the delay is
// clamped to at least one render quantum — 128 samples, 2.67 ms at 48 kHz.
// Every delay in a loop below is longer than that on purpose.  A textbook
// Schroeder allpass at 1.7 ms would be silently stretched to 2.67, and the
// device would not be the device that was designed.

import {
  dbToGain, withBypass, type PluginDescriptor,
} from './plugin-kit.js';
import {
  SPACES, irBuffer, spaceAt, spaceChoices, spaceIndex, spaceNotes, type Space,
} from './reverb-spaces.js';

const p = (params: Record<string, number>, id: string, fallback: number): number => {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Butterworth, and why it is not zero.
 *
 * Web Audio reads `Q` on a lowpass or highpass in DECIBELS, not as a Q factor:
 * alpha = sin(w0) / (2 · 10^(Q/20)).  The default of 1 is therefore 1 dB of
 * resonance — a small peak just under the cutoff, and harmless anywhere except
 * inside a feedback loop, where it multiplies the loop gain at exactly one
 * frequency.  A plate with a per-pass gain of 0.99 and a 1 dB peak has a loop
 * gain of 1.11 there, which is not a reverb: it is an oscillator.  This is the
 * value that gives a maximally flat response and no peak at all.
 */
const BUTTERWORTH_Q = -3.0103;

/** Round to a step, so a knob drag does not synthesise a hundred rooms. */
const quantise = (v: number, step: number): number => Math.round(v / step) * step;

// ── Building blocks ─────────────────────────────────────────────────────────

/**
 * Mid/side width on a stereo signal.
 *
 * The room's own stereo image is baked into its impulse response; this widens
 * or narrows what comes out, which is a live control and costs nothing.  Doing
 * it by re-synthesising the IR would mean rebuilding a million samples on every
 * pointer move.
 */
interface WidthStage { input: GainNode; output: GainNode; set: (width: number) => void }

function widthStage(ctx: BaseAudioContext): WidthStage {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  input.connect(splitter);

  const mid = ctx.createGain();
  const side = ctx.createGain();
  const lToMid = ctx.createGain(); lToMid.gain.value = 0.5;
  const rToMid = ctx.createGain(); rToMid.gain.value = 0.5;
  const lToSide = ctx.createGain(); lToSide.gain.value = 0.5;
  const rToSide = ctx.createGain(); rToSide.gain.value = -0.5;
  splitter.connect(lToMid, 0); splitter.connect(rToMid, 1);
  splitter.connect(lToSide, 0); splitter.connect(rToSide, 1);
  lToMid.connect(mid); rToMid.connect(mid);
  lToSide.connect(side); rToSide.connect(side);

  const mToL = ctx.createGain();
  const sToL = ctx.createGain();
  const mToR = ctx.createGain();
  const sToR = ctx.createGain(); sToR.gain.value = -1;
  mid.connect(mToL); side.connect(sToL);
  mid.connect(mToR); side.connect(sToR);
  mToL.connect(merger, 0, 0); sToL.connect(merger, 0, 0);
  mToR.connect(merger, 0, 1); sToR.connect(merger, 0, 1);
  merger.connect(output);

  return {
    input, output,
    set: (width) => {
      // Constant-ish power: pulling the side up must not make the middle
      // disappear, or "wider" becomes "thinner and louder".
      const w = clamp(width, 0, 2);
      side.gain.value = w;
      mid.gain.value = w > 1 ? 1 / Math.sqrt(w) : 1;
    },
  };
}

/**
 * A Schroeder allpass: flat magnitude, and a delay that depends on frequency.
 *
 *   v[n] = x[n] + g·v[n−D]
 *   y[n] = v[n−D] − g·v[n]
 *
 * Four nodes and one legal cycle.  This is the unit that turns a delay line
 * into diffusion, and a chain of them into the dispersive chirp a spring makes.
 */
interface Allpass { input: GainNode; output: GainNode; setG: (g: number) => void }

function allpass(ctx: BaseAudioContext, delaySec: number, g: number): Allpass {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const sum = ctx.createGain();
  const delay = ctx.createDelay(Math.max(0.2, delaySec * 2));
  delay.delayTime.value = delaySec;
  const feedback = ctx.createGain(); feedback.gain.value = g;
  const feedforward = ctx.createGain(); feedforward.gain.value = -g;

  input.connect(sum);
  sum.connect(delay);
  delay.connect(feedback).connect(sum);   // the cycle — it contains the delay
  delay.connect(output);
  sum.connect(feedforward).connect(output);

  return {
    input, output,
    setG: (value) => {
      const v = clamp(value, -0.95, 0.95);
      feedback.gain.value = v;
      feedforward.gain.value = -v;
    },
  };
}

/**
 * A constant signal, for offsetting a modulator into positive territory.
 *
 * A looping buffer of ones rather than `ConstantSourceNode`: the buffer source
 * exists in every implementation this engine renders in, including the one the
 * self-tests use.
 */
interface Dc { out: GainNode; stop: () => void }

function dcSource(ctx: BaseAudioContext, value: number): Dc {
  const buffer = ctx.createBuffer(1, 128, ctx.sampleRate);
  buffer.getChannelData(0).fill(1);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = value;
  source.connect(gain);
  source.start(0);
  return { out: gain, stop: () => source.stop() };
}

/**
 * Pitch shift up one octave, with two crossfaded delay lines.
 *
 * A delay line whose delay shrinks at one second per second plays its input at
 * twice the rate — an octave up.  It can only do that for as long as the
 * window lasts, so two of them run half a period apart and are crossfaded with
 * a raised cosine that is exactly zero where each line resets.
 *
 * ── Where the phases come from ─────────────────────────────────────────────
 *
 * `OscillatorNode` has no phase control, and `PeriodicWave` cannot be used to
 * fake one here: `disableNormalization` is honoured by Chromium and ignored by
 * the renderer the self-tests use, so a hand-built wave would have a different
 * amplitude in each — and this modulator's amplitude IS the pitch ratio.  The
 * built-in shapes are specified exactly, so everything is built from one
 * sawtooth and one sine, phase-shifted by running them through delay lines.
 *
 * The sawtooth's discontinuity sits at the half period (measured, and what the
 * spec's formula gives).  So:
 *
 *   line A   saw as it is                 jumps at T/2
 *   line B   saw delayed by T/2           jumps at T
 *   window   sine delayed by ¾T, ±½, +½   −1 at T/2 for A, +1 at T for B
 *
 * The two windows are 0.5 ± the same signal, so they sum to exactly one at
 * every sample — including during the first ¾ of a period, before the delayed
 * control signals have arrived.  Nothing is shifted yet in that window, but
 * nothing jumps either.
 *
 * It is not a phase vocoder and does not pretend to be: on a sustained tone it
 * is clean, on a transient it smears.  In a shimmer that is the whole point —
 * what gets pitched up is the reverb tail, which is a sustained tone by the
 * time it arrives.
 */
export interface PitchShifter { input: GainNode; output: GainNode; dispose: () => void }

export function octaveUp(ctx: BaseAudioContext, windowSec = 0.09): PitchShifter {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const period = windowSec;
  const rate = 1 / period;
  const stops: Array<() => void> = [];

  // One sawtooth for both lines.  Range ±1 over one period, so a depth of
  // −W/2 sweeps the delay across the whole window once per period: the delay
  // shrinks by W seconds in W seconds, which is exactly one octave.
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = rate;
  const sawShift = ctx.createDelay(period);
  sawShift.delayTime.value = period / 2;
  saw.connect(sawShift);

  // One sine, delayed three quarters of a period: −1 exactly where line A's
  // sawtooth jumps, +1 exactly where line B's does.
  const shape = ctx.createOscillator();
  shape.type = 'sine';
  shape.frequency.value = rate;
  const shapeShift = ctx.createDelay(period);
  shapeShift.delayTime.value = period * 0.75;
  shape.connect(shapeShift);

  const bias = dcSource(ctx, 0.5);
  stops.push(() => saw.stop(), () => shape.stop(), bias.stop);

  for (const half of [false, true]) {
    const delay = ctx.createDelay(windowSec * 2);
    delay.delayTime.value = period / 2;
    const depth = ctx.createGain();
    depth.gain.value = -period / 2;
    (half ? sawShift : saw).connect(depth).connect(delay.delayTime);

    const window = ctx.createGain();
    window.gain.value = 0;
    const windowDepth = ctx.createGain();
    windowDepth.gain.value = half ? -0.5 : 0.5;
    shapeShift.connect(windowDepth).connect(window.gain);
    bias.out.connect(window.gain);

    input.connect(delay).connect(window).connect(output);
  }

  saw.start(0);
  shape.start(0);

  return {
    input, output,
    dispose: () => { for (const stop of stops) { try { stop(); } catch { /* never started */ } } },
  };
}

// ── Space Reverb ────────────────────────────────────────────────────────────

const SPACE_CHOICES = spaceChoices();
const SPACE_NOTES = spaceNotes();

/**
 * Two convolvers, not one.
 *
 * The early reflections and the diffuse tail are separate impulse responses so
 * their balance can be a real fader.  One IR with an "ER level" knob would be a
 * tone control that pretends: you cannot lift the first 60 ms of a rendered
 * convolution after the fact.
 */
interface SpaceEngine {
  setSpace: () => void;
  dispose: () => void;
}

function buildSpaceReverb(
  ctx: BaseAudioContext, params: Record<string, number>,
  input: GainNode, output: GainNode,
): SpaceEngine & { setParam: (id: string, v: number) => void } {
  const pre = ctx.createDelay(0.5);
  const early = ctx.createConvolver();
  const tail = ctx.createConvolver();
  // Our own normalisation is already energy-matched across every space; the
  // browser's would undo it and put the level jumps back.
  early.normalize = false;
  tail.normalize = false;

  const erGain = ctx.createGain();
  const tailGain = ctx.createGain();
  const lowCut = ctx.createBiquadFilter(); lowCut.type = 'highpass';
  const highCut = ctx.createBiquadFilter(); highCut.type = 'lowpass';
  const width = widthStage(ctx);
  const wet = ctx.createGain();
  const dry = ctx.createGain();

  input.connect(pre);
  pre.connect(early).connect(erGain).connect(lowCut);
  pre.connect(tail).connect(tailGain).connect(lowCut);
  lowCut.connect(highCut).connect(width.input);
  width.output.connect(wet).connect(output);
  input.connect(dry).connect(output);

  const rebuild = (): void => {
    const space = spaceAt(p(params, 'space', 0));
    const opts = {
      sampleRate: ctx.sampleRate,
      sizeScale: quantise(clamp(p(params, 'sizePct', 100) / 100, 0.25, 2), 0.05),
      decayScale: quantise(clamp(p(params, 'decayPct', 100) / 100, 0.25, 3), 0.05),
      damping: clamp(space.damping * (p(params, 'dampingPct', 100) / 100), 0, 1),
      holdMs: quantise(p(params, 'holdMs', 260), 10),
    };
    early.buffer = irBuffer(ctx, space, { ...opts, part: 'early' });
    tail.buffer = irBuffer(ctx, space, { ...opts, part: 'tail' });
  };

  const applyMix = (): void => {
    const mix = clamp(p(params, 'mixPct', 30) / 100, 0, 1);
    wet.gain.value = mix;
    dry.gain.value = 1 - mix;
  };

  const applyLevels = (): void => {
    erGain.gain.value = dbToGain(p(params, 'erDb', 0));
    tailGain.gain.value = dbToGain(p(params, 'tailDb', 0));
  };

  rebuild();
  applyMix();
  applyLevels();
  pre.delayTime.value = p(params, 'preDelayMs', 20) / 1000;
  lowCut.frequency.value = p(params, 'lowCutHz', 90);
  highCut.frequency.value = p(params, 'highCutHz', 12000);
  width.set(p(params, 'widthPct', 100) / 100);

  return {
    setSpace: rebuild,
    dispose: () => { /* convolvers hold only buffers */ },
    setParam: (id, v) => {
      params[id] = v;
      if (id === 'space' || id === 'sizePct' || id === 'decayPct'
        || id === 'dampingPct' || id === 'holdMs') rebuild();
      else if (id === 'mixPct') applyMix();
      else if (id === 'erDb' || id === 'tailDb') applyLevels();
      else if (id === 'preDelayMs') pre.delayTime.value = v / 1000;
      else if (id === 'lowCutHz') lowCut.frequency.value = v;
      else if (id === 'highCutHz') highCut.frequency.value = v;
      else if (id === 'widthPct') width.set(v / 100);
    },
  };
}

// ── Plate ───────────────────────────────────────────────────────────────────

/**
 * A feedback delay network, which is what a plate actually is.
 *
 * Four delay lines feeding each other through a Householder matrix — an
 * orthogonal mixer, so energy is redistributed rather than created, which is
 * what keeps it stable at long decay times.  The matrix is
 *
 *     out_i = in_i − ½·Σ in
 *
 * and that shape is why it costs six nodes instead of sixteen: every line gets
 * itself plus one shared sum.
 *
 * No early reflections, because a plate has no walls.  A vocal on a plate
 * sounds close and enormous at the same time for exactly that reason.
 */
// Short, and deliberately so.  A plate has no walls, so there must be no gap
// between the hit and the reverb: the diffusers total 16 ms and the shortest
// tank line is 17, which puts the first dense output about 20 ms behind the
// transient.  They are all comfortably above the 2.67 ms render quantum that a
// delay inside a cycle is clamped to.
const PLATE_DELAYS_MS = [17.3, 23.7, 29.1, 37.9];
const PLATE_DIFFUSE_MS = [2.9, 3.7, 4.3, 5.1];

function buildPlate(
  ctx: BaseAudioContext, params: Record<string, number>,
  input: GainNode, output: GainNode,
): { setParam: (id: string, v: number) => void; dispose: () => void } {
  const drive = ctx.createGain(); drive.gain.value = 0.4;
  const pre = ctx.createDelay(0.5);
  const width = widthStage(ctx);
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  const lowCut = ctx.createBiquadFilter(); lowCut.type = 'highpass';
  const highCut = ctx.createBiquadFilter(); highCut.type = 'lowpass';

  input.connect(pre).connect(drive);

  // Input diffusion: four allpasses in series turn a click into a cloud
  // before it ever reaches the network.
  const diffusers = PLATE_DIFFUSE_MS.map((ms) => allpass(ctx, ms / 1000, 0.68));
  let node: AudioNode = drive;
  for (const ap of diffusers) { node.connect(ap.input); node = ap.output; }
  const diffused = node;

  // The network.
  const sum = ctx.createGain();
  const share = ctx.createGain(); share.gain.value = -0.5;
  sum.connect(share);

  const merger = ctx.createChannelMerger(2);
  const lines = PLATE_DELAYS_MS.map((ms, i) => {
    const into = ctx.createGain();
    const delay = ctx.createDelay(1.2);
    delay.delayTime.value = ms / 1000;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 8000;
    damp.Q.value = BUTTERWORTH_Q;      // in a loop; see BUTTERWORTH_Q
    const feedback = ctx.createGain();

    diffused.connect(into);
    into.connect(delay).connect(damp).connect(feedback);
    feedback.connect(sum);        // into the shared sum
    feedback.connect(into);       // identity term of the matrix
    share.connect(into);          // −½·Σ
    // Two lines to each side, so the plate is stereo without being two plates.
    feedback.connect(merger, 0, i % 2);
    return { delay, damp, feedback, ms };
  });

  // The diffusers are part of the sound, not just a way in.  An allpass has an
  // instantaneous path, so this tap is what makes the plate dense immediately
  // instead of arriving one delay line late.
  const diffuseTap = ctx.createGain();
  diffuseTap.gain.value = 0.35;
  diffused.connect(diffuseTap);
  diffuseTap.connect(merger, 0, 0);
  diffuseTap.connect(merger, 0, 1);

  merger.connect(lowCut).connect(highCut).connect(width.input);
  width.output.connect(wet).connect(output);
  input.connect(dry).connect(output);

  const applyDecay = (): void => {
    const rt60 = clamp(p(params, 'decaySec', 2.4), 0.2, 12);
    for (const line of lines) {
      // −60 dB after rt60 for a loop of this length is exactly what the
      // per-pass gain has to be.
      const g = Math.pow(10, -3 * (line.ms / 1000) / rt60);
      line.feedback.gain.value = clamp(g, 0, 0.995);
    }
  };
  const applyDamp = (): void => {
    const hz = clamp(p(params, 'dampHz', 7500), 500, 20000);
    for (const line of lines) line.damp.frequency.value = hz;
  };
  const applyMix = (): void => {
    const mix = clamp(p(params, 'mixPct', 30) / 100, 0, 1);
    wet.gain.value = mix;
    dry.gain.value = 1 - mix;
  };

  applyDecay(); applyDamp(); applyMix();
  pre.delayTime.value = p(params, 'preDelayMs', 0) / 1000;
  lowCut.frequency.value = p(params, 'lowCutHz', 200);
  highCut.frequency.value = p(params, 'highCutHz', 14000);
  width.set(p(params, 'widthPct', 110) / 100);
  for (const ap of diffusers) ap.setG(clamp(p(params, 'diffusion', 0.7), 0, 0.92));

  return {
    dispose: () => { /* nothing started */ },
    setParam: (id, v) => {
      params[id] = v;
      if (id === 'decaySec') applyDecay();
      else if (id === 'dampHz') applyDamp();
      else if (id === 'mixPct') applyMix();
      else if (id === 'preDelayMs') pre.delayTime.value = v / 1000;
      else if (id === 'lowCutHz') lowCut.frequency.value = v;
      else if (id === 'highCutHz') highCut.frequency.value = v;
      else if (id === 'widthPct') width.set(v / 100);
      else if (id === 'diffusion') for (const ap of diffusers) ap.setG(clamp(v, 0, 0.92));
    },
  };
}

// ── Spring ──────────────────────────────────────────────────────────────────

/**
 * A spring is a delay line that is slower at the bottom than at the top.
 *
 * That is the whole character: hit it and the high end arrives first, the low
 * end trails, and the result is the chirp everyone recognises from a guitar
 * amp.  A chain of allpasses inside the feedback loop does exactly this — each
 * one delays low frequencies more than high ones, and eight of them make it
 * unmistakable.
 *
 * Bandlimited on the way in, because a real spring is: there is no bass and no
 * air in a tank, and leaving them in is what makes an imitation sound wrong.
 */
const SPRING_ALLPASS_MS = [3.1, 4.7, 5.3, 6.9, 8.1, 9.7, 11.3, 12.9];

function buildSpring(
  ctx: BaseAudioContext, params: Record<string, number>,
  input: GainNode, output: GainNode,
): { setParam: (id: string, v: number) => void; dispose: () => void } {
  const band = ctx.createBiquadFilter(); band.type = 'bandpass';
  band.frequency.value = 1400; band.Q.value = 0.55;
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  const merger = ctx.createChannelMerger(2);

  input.connect(band);
  input.connect(dry).connect(output);

  // Two tanks at slightly different lengths — real units have two or three
  // springs of different gauges, which is why they are not mono.
  const tanks = [0, 1].map((side) => {
    const into = ctx.createGain();
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = (0.032 + side * 0.0047);
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 4200;
    damp.Q.value = BUTTERWORTH_Q;      // in a loop; see BUTTERWORTH_Q
    const feedback = ctx.createGain();
    feedback.gain.value = 0.72;

    band.connect(into);
    let node: AudioNode = into;
    const lengths = SPRING_ALLPASS_MS.map((ms) => (ms + side * 0.6) / 1000);
    const chain = lengths.map((seconds, i) => allpass(ctx, seconds, i % 2 === 0 ? 0.62 : -0.62));
    for (const ap of chain) { node.connect(ap.input); node = ap.output; }
    node.connect(delay).connect(damp).connect(feedback);
    feedback.connect(into);            // the loop, with the delay inside it
    feedback.connect(merger, 0, side);

    // How long one trip round actually takes.  An allpass is not free: its
    // group delay averages its own delay length across the spectrum, so eight
    // of them add 60-odd milliseconds to a 32 ms line.  Computing the feedback
    // gain from the 32 alone makes every decay setting about three times too
    // long, which is exactly what it did before this was measured.
    const loopSec = (0.032 + side * 0.0047) + lengths.reduce((a, b) => a + b, 0);
    return { delay, damp, feedback, chain, loopSec };
  });

  merger.connect(wet).connect(output);

  const applyDecay = (): void => {
    const seconds = clamp(p(params, 'decaySec', 2.2), 0.2, 8);
    for (const tank of tanks) {
      const g = Math.pow(10, -3 * tank.loopSec / seconds);
      tank.feedback.gain.value = clamp(g, 0, 0.99);
    }
  };
  const applyMix = (): void => {
    const mix = clamp(p(params, 'mixPct', 30) / 100, 0, 1);
    wet.gain.value = mix;
    dry.gain.value = 1 - mix;
  };

  applyDecay(); applyMix();
  band.frequency.value = p(params, 'toneHz', 1400);
  for (const tank of tanks) tank.damp.frequency.value = p(params, 'dampHz', 4200);
  const applyBoing = (amount: number): void => {
    // Alternating signs: same dispersion, but the chain does not accumulate a
    // single-sided ring that turns the chirp into a whistle.
    const g = clamp(amount, 0, 0.9);
    for (const tank of tanks) tank.chain.forEach((ap, i) => ap.setG(i % 2 === 0 ? g : -g));
  };
  applyBoing(p(params, 'boing', 0.62));

  return {
    dispose: () => { /* nothing started */ },
    setParam: (id, v) => {
      params[id] = v;
      if (id === 'decaySec') applyDecay();
      else if (id === 'mixPct') applyMix();
      else if (id === 'toneHz') band.frequency.value = v;
      else if (id === 'dampHz') for (const tank of tanks) tank.damp.frequency.value = v;
      else if (id === 'boing') applyBoing(v);
    },
  };
}

// ── Shimmer ─────────────────────────────────────────────────────────────────

/**
 * A reverb whose own tail is fed back an octave up.
 *
 * The loop is: room → pitch shifter → back into the room.  Each trip up the
 * loop is another octave, so what starts as a note becomes a chord and then a
 * pad, and the reason it does not simply run away is that the feedback gain is
 * below unity and the shifter's window costs a little on every pass.
 *
 * Marked free-running: the shifter's crossfade phase follows the audio context
 * rather than the song, so a bounce does not start in the same place in the
 * window as the monitor did.  Nothing else in the device drifts.
 */
function buildShimmer(
  ctx: BaseAudioContext, params: Record<string, number>,
  input: GainNode, output: GainNode,
): { setParam: (id: string, v: number) => void; dispose: () => void } {
  const pre = ctx.createDelay(0.5);
  const conv = ctx.createConvolver();
  conv.normalize = false;
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  const width = widthStage(ctx);
  const lowCut = ctx.createBiquadFilter(); lowCut.type = 'highpass';
  const highCut = ctx.createBiquadFilter(); highCut.type = 'lowpass';

  const shifter = octaveUp(ctx);
  const shiftGain = ctx.createGain();
  // A short delay in the pitch loop: the cycle needs one, and it also stops
  // the octave from arriving on top of the note that made it.
  const loopDelay = ctx.createDelay(2);
  const loopDamp = ctx.createBiquadFilter();
  loopDamp.type = 'lowpass';
  loopDamp.frequency.value = 6000;
  loopDamp.Q.value = BUTTERWORTH_Q;    // in a loop; see BUTTERWORTH_Q
  // Without this the octave stack builds a bass mound that swallows the mix.
  const loopCut = ctx.createBiquadFilter();
  loopCut.type = 'highpass';
  loopCut.frequency.value = 300;
  loopCut.Q.value = BUTTERWORTH_Q;

  input.connect(pre).connect(conv);
  conv.connect(lowCut).connect(highCut).connect(width.input);
  width.output.connect(wet).connect(output);
  input.connect(dry).connect(output);

  // The loop: tail → shift → delay → back to the convolver's input.
  conv.connect(shifter.input);
  shifter.output.connect(shiftGain)
    .connect(loopCut).connect(loopDamp).connect(loopDelay);
  loopDelay.connect(conv);

  const rebuild = (): void => {
    const space = spaceAt(p(params, 'space', spaceIndex('hall-cathedral')));
    conv.buffer = irBuffer(ctx, space, {
      sampleRate: ctx.sampleRate,
      decayScale: quantise(clamp(p(params, 'decayPct', 100) / 100, 0.25, 3), 0.05),
      part: 'tail',
    });
  };
  const applyMix = (): void => {
    const mix = clamp(p(params, 'mixPct', 35) / 100, 0, 1);
    wet.gain.value = mix;
    dry.gain.value = 1 - mix;
  };

  rebuild();
  applyMix();
  pre.delayTime.value = p(params, 'preDelayMs', 40) / 1000;
  loopDelay.delayTime.value = clamp(p(params, 'loopMs', 180), 20, 800) / 1000;
  shiftGain.gain.value = clamp(p(params, 'shimmer', 0.45), 0, 0.85);
  lowCut.frequency.value = p(params, 'lowCutHz', 180);
  highCut.frequency.value = p(params, 'highCutHz', 11000);
  width.set(p(params, 'widthPct', 120) / 100);

  return {
    dispose: () => shifter.dispose(),
    setParam: (id, v) => {
      params[id] = v;
      if (id === 'space' || id === 'decayPct') rebuild();
      else if (id === 'mixPct') applyMix();
      else if (id === 'preDelayMs') pre.delayTime.value = v / 1000;
      else if (id === 'loopMs') loopDelay.delayTime.value = clamp(v, 20, 800) / 1000;
      else if (id === 'shimmer') shiftGain.gain.value = clamp(v, 0, 0.85);
      else if (id === 'lowCutHz') lowCut.frequency.value = v;
      else if (id === 'highCutHz') highCut.frequency.value = v;
      else if (id === 'widthPct') width.set(v / 100);
    },
  };
}

// ── The devices ─────────────────────────────────────────────────────────────

export const REVERB_PLUGINS: PluginDescriptor[] = [
  {
    id: 'spacereverb',
    name: 'Space Reverb',
    category: 'reverb',
    hasSidechain: false,
    params: [
      { id: 'space',      name: 'Space',     min: 0,    max: SPACES.length - 1, default: spaceIndex('live-house'), unit: '', choices: SPACE_CHOICES, choiceNotes: SPACE_NOTES },
      { id: 'sizePct',    name: 'Size',      min: 25,   max: 200,   default: 100, unit: '%' },
      { id: 'decayPct',   name: 'Decay',     min: 25,   max: 300,   default: 100, unit: '%' },
      { id: 'preDelayMs', name: 'Pre-delay', min: 0,    max: 200,   default: 20,  unit: 'ms' },
      { id: 'dampingPct', name: 'Damping',   min: 0,    max: 200,   default: 100, unit: '%' },
      { id: 'erDb',       name: 'Early',     min: -24,  max: 12,    default: 0,   unit: 'dB' },
      { id: 'tailDb',     name: 'Tail',      min: -24,  max: 12,    default: 0,   unit: 'dB' },
      { id: 'lowCutHz',   name: 'Low Cut',   min: 20,   max: 800,   default: 90,  unit: 'Hz' },
      { id: 'highCutHz',  name: 'High Cut',  min: 1000, max: 20000, default: 12000, unit: 'Hz' },
      { id: 'widthPct',   name: 'Width',     min: 0,    max: 150,   default: 100, unit: '%' },
      { id: 'holdMs',     name: 'Hold',      min: 40,   max: 1200,  default: 260, unit: 'ms' },
      { id: 'mixPct',     name: 'Mix',       min: 0,    max: 100,   default: 30,  unit: '%' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const engine = buildSpaceReverb(ctx, params, input, output);
      return { setParam: engine.setParam, dispose: engine.dispose };
    }),
  },

  {
    id: 'plate',
    name: 'Plate Reverb',
    category: 'reverb',
    hasSidechain: false,
    params: [
      { id: 'decaySec',   name: 'Decay',     min: 0.2,  max: 12,    default: 2.4,  unit: 's' },
      { id: 'preDelayMs', name: 'Pre-delay', min: 0,    max: 200,   default: 0,    unit: 'ms' },
      { id: 'dampHz',     name: 'Damping',   min: 500,  max: 20000, default: 7500, unit: 'Hz' },
      { id: 'diffusion',  name: 'Diffusion', min: 0,    max: 0.92,  default: 0.7,  unit: '' },
      { id: 'lowCutHz',   name: 'Low Cut',   min: 20,   max: 800,   default: 200,  unit: 'Hz' },
      { id: 'highCutHz',  name: 'High Cut',  min: 1000, max: 20000, default: 14000, unit: 'Hz' },
      { id: 'widthPct',   name: 'Width',     min: 0,    max: 150,   default: 110,  unit: '%' },
      { id: 'mixPct',     name: 'Mix',       min: 0,    max: 100,   default: 30,   unit: '%' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => buildPlate(ctx, params, input, output)),
  },

  {
    id: 'spring',
    name: 'Spring Reverb',
    category: 'reverb',
    hasSidechain: false,
    params: [
      { id: 'decaySec', name: 'Decay',  min: 0.2,  max: 8,     default: 2.2,  unit: 's' },
      { id: 'toneHz',   name: 'Tone',   min: 400,  max: 4000,  default: 1400, unit: 'Hz' },
      { id: 'dampHz',   name: 'Damping', min: 800, max: 12000, default: 4200, unit: 'Hz' },
      { id: 'boing',    name: 'Boing',  min: 0,    max: 0.9,   default: 0.62, unit: '' },
      { id: 'mixPct',   name: 'Mix',    min: 0,    max: 100,   default: 30,   unit: '%' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => buildSpring(ctx, params, input, output)),
  },

  {
    id: 'shimmer',
    name: 'Shimmer Reverb',
    category: 'reverb',
    freeRunning: true,
    hasSidechain: false,
    params: [
      { id: 'space',      name: 'Space',     min: 0,    max: SPACES.length - 1, default: spaceIndex('hall-cathedral'), unit: '', choices: SPACE_CHOICES, choiceNotes: SPACE_NOTES },
      { id: 'decayPct',   name: 'Decay',     min: 25,   max: 300,   default: 100, unit: '%' },
      { id: 'shimmer',    name: 'Shimmer',   min: 0,    max: 0.85,  default: 0.45, unit: '' },
      { id: 'loopMs',     name: 'Loop',      min: 20,   max: 800,   default: 180, unit: 'ms' },
      { id: 'preDelayMs', name: 'Pre-delay', min: 0,    max: 200,   default: 40,  unit: 'ms' },
      { id: 'lowCutHz',   name: 'Low Cut',   min: 20,   max: 800,   default: 180, unit: 'Hz' },
      { id: 'highCutHz',  name: 'High Cut',  min: 1000, max: 20000, default: 11000, unit: 'Hz' },
      { id: 'widthPct',   name: 'Width',     min: 0,    max: 150,   default: 120, unit: '%' },
      { id: 'mixPct',     name: 'Mix',       min: 0,    max: 100,   default: 35,  unit: '%' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => buildShimmer(ctx, params, input, output)),
  },
];

/** Exported for the tests and the display, which both need the space list. */
export { SPACES, spaceAt, spaceIndex, type Space };
