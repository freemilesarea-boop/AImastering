// Step sequencer — the FL Studio channel rack.
//
// The reason to steal this and not just draw notes in a piano roll is SPEED.
// A drum part is a yes/no decision per step per instrument, and a grid of
// buttons answers that question about forty times faster than dragging
// rectangles does.  Everything else in this DAW already speaks MidiNote, so
// this module's real job is the conversion: a grid in, notes out.
//
// Four things separate a usable step sequencer from a toy, and all four live
// in that conversion:
//
//   Velocity per step.  A grid where every hit is the same is a drum machine
//   from 1981.  Each step carries its own velocity.
//
//   Swing.  Shifting every off-beat step late by a fraction of the step is the
//   difference between a pattern and a groove.
//
//   Nudge.  A per-step offset in fractions of a step, so one snare can sit
//   behind the beat without moving the grid.
//
//   Ratchet.  One step retriggering N times is how a step sequencer plays a
//   roll; without it every fill has to be drawn by hand.

import { createNote, from7bit, type MidiNote, type Unipolar } from './midi.js';
import { nextId } from './ids.js';
import { MIN_NOTE_BEATS } from '../edit/midi-edit.js';

export interface Step {
  on: boolean;
  velocity: Unipolar;
  /** Timing offset in fractions of ONE step: −0.5 … +0.5. */
  nudge: number;
  /** Retriggers within the step.  1 is a single hit. */
  ratchet: number;
  /** 0…1 — the step plays this often.  Deterministic per pattern seed. */
  probability: number;
}

export const DEFAULT_STEP: Step = {
  on: false, velocity: from7bit(100), nudge: 0, ratchet: 1, probability: 1,
};

export interface StepChannel {
  id: string;
  name: string;
  /** Pitch this channel triggers — a drum map slot, or a note for a synth. */
  pitch: number;
  /** How long each hit sounds, in fractions of a step. */
  gate: number;
  muted: boolean;
  steps: Step[];
}

export interface StepPattern {
  id: string;
  name: string;
  /** Grid length. */
  stepCount: number;
  /** Grid resolution: 4 = sixteenths in 4/4. */
  stepsPerBeat: number;
  /** 0 = straight, 0.66 ≈ triplet feel.  Applies to odd steps. */
  swing: number;
  channels: StepChannel[];
  /** Fixed seed, so probability is the same every time it plays. */
  seed: number;
}

export const GM_DRUM_MAP: readonly { name: string; pitch: number }[] = [
  { name: 'Kick', pitch: 36 },
  { name: 'Snare', pitch: 38 },
  { name: 'Clap', pitch: 39 },
  { name: 'Closed Hat', pitch: 42 },
  { name: 'Open Hat', pitch: 46 },
  { name: 'Low Tom', pitch: 45 },
  { name: 'Mid Tom', pitch: 47 },
  { name: 'Crash', pitch: 49 },
];

export function createSteps(count: number): Step[] {
  return Array.from({ length: count }, () => ({ ...DEFAULT_STEP }));
}

export function createChannel(name: string, pitch: number, stepCount: number): StepChannel {
  return { id: nextId('sch'), name, pitch, gate: 0.9, muted: false, steps: createSteps(stepCount) };
}

export function createPattern(name = 'Pattern', stepCount = 16, stepsPerBeat = 4): StepPattern {
  return {
    id: nextId('spat'),
    name,
    stepCount,
    stepsPerBeat,
    swing: 0,
    seed: 1,
    channels: GM_DRUM_MAP.slice(0, 4).map((d) => createChannel(d.name, d.pitch, stepCount)),
  };
}

// ── Grid editing ──────────────────────────────────────────────────────────────

function mapChannel(
  pattern: StepPattern, channelId: string, fn: (c: StepChannel) => StepChannel,
): StepPattern {
  let changed = false;
  const channels = pattern.channels.map((c) => {
    if (c.id !== channelId) return c;
    const next = fn(c);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...pattern, channels } : pattern;
}

function mapStep(
  pattern: StepPattern, channelId: string, index: number, fn: (s: Step) => Step,
): StepPattern {
  return mapChannel(pattern, channelId, (c) => {
    const step = c.steps[index];
    if (!step) return c;
    const next = fn(step);
    if (next === step) return c;
    return { ...c, steps: c.steps.map((s, i) => (i === index ? next : s)) };
  });
}

export function toggleStep(pattern: StepPattern, channelId: string, index: number): StepPattern {
  return mapStep(pattern, channelId, index, (s) => ({ ...s, on: !s.on }));
}

export function setStep(
  pattern: StepPattern, channelId: string, index: number, patch: Partial<Step>,
): StepPattern {
  return mapStep(pattern, channelId, index, (s) => ({ ...s, ...patch }));
}

export function clearChannel(pattern: StepPattern, channelId: string): StepPattern {
  return mapChannel(pattern, channelId, (c) =>
    (c.steps.some((s) => s.on) ? { ...c, steps: createSteps(c.steps.length) } : c));
}

export function addChannel(pattern: StepPattern, name: string, pitch: number): StepPattern {
  return { ...pattern, channels: [...pattern.channels, createChannel(name, pitch, pattern.stepCount)] };
}

export function removeChannel(pattern: StepPattern, channelId: string): StepPattern {
  const channels = pattern.channels.filter((c) => c.id !== channelId);
  return channels.length === pattern.channels.length ? pattern : { ...pattern, channels };
}

/** Grow or shrink the grid, keeping what fits. */
export function resizePattern(pattern: StepPattern, stepCount: number): StepPattern {
  const count = Math.max(1, Math.min(256, Math.round(stepCount)));
  if (count === pattern.stepCount) return pattern;
  return {
    ...pattern,
    stepCount: count,
    channels: pattern.channels.map((c) => ({
      ...c,
      steps: Array.from({ length: count }, (_, i) => c.steps[i] ?? { ...DEFAULT_STEP }),
    })),
  };
}

/** Rotate a channel's steps — the fastest way to find a groove. */
export function rotateChannel(pattern: StepPattern, channelId: string, by: number): StepPattern {
  return mapChannel(pattern, channelId, (c) => {
    const n = c.steps.length;
    if (n === 0 || by % n === 0) return c;
    const shift = ((by % n) + n) % n;
    return { ...c, steps: c.steps.map((_, i) => c.steps[(i - shift + n) % n] as Step) };
  });
}

/** Euclidean fill: spread `hits` as evenly as possible over the grid. */
export function euclidFill(
  pattern: StepPattern, channelId: string, hits: number, rotate = 0,
): StepPattern {
  return mapChannel(pattern, channelId, (c) => {
    const n = c.steps.length;
    const k = Math.max(0, Math.min(n, Math.round(hits)));
    const steps = createSteps(n);
    for (let i = 0; i < k; i++) {
      // Bresenham placement — the standard construction, and the one that
      // gives the tresillo, the son clave and the rest for free.
      const index = (Math.floor((i * n) / k) + rotate) % n;
      const slot = steps[index];
      if (slot) slot.on = true;
      if (slot) slot.velocity = c.steps[index]?.velocity ?? DEFAULT_STEP.velocity;
    }
    return { ...c, steps };
  });
}

// ── Timing ────────────────────────────────────────────────────────────────────

/**
 * One step, in beats.
 *
 * `stepsPerBeat` says it: no tempo needed, and a pattern therefore means the
 * same thing at every tempo and follows a tempo change without being redrawn.
 */
export function stepBeats(pattern: StepPattern): number {
  return 1 / Math.max(1, pattern.stepsPerBeat);
}

/** The whole grid, in beats. */
export function patternBeats(pattern: StepPattern): number {
  return pattern.stepCount * stepBeats(pattern);
}

/**
 * Where a step actually lands.  Swing pushes odd steps late by a fraction of
 * the step; nudge moves one step without moving the grid under it.
 */
export function stepTime(
  pattern: StepPattern, index: number, nudge = 0,
): number {
  const step = stepBeats(pattern);
  const swing = index % 2 === 1 ? pattern.swing * 0.5 * step : 0;
  return index * step + swing + nudge * step;
}

// ── Conversion ────────────────────────────────────────────────────────────────

/** Deterministic per (seed, channel, step) — a pattern plays the same twice. */
function stepChance(seed: number, channelIndex: number, stepIndex: number): number {
  let h = (seed * 374761393 + channelIndex * 668265263 + stepIndex * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface StepRenderOptions {
  /** Repeat the grid this many times. */
  repeats?: number;
  /** Skip probability entirely — used while editing so the grid is honest. */
  ignoreProbability?: boolean;
}

/**
 * The grid becomes notes.  This is the only bridge the rest of the DAW needs:
 * once it is a MidiNote[], the Key Editor, the instruments, quantize, humanize
 * and the offline renderer all already work on it.
 */
export function stepsToNotes(
  pattern: StepPattern, options: StepRenderOptions = {},
): MidiNote[] {
  const repeats = Math.max(1, Math.round(options.repeats ?? 1));
  const step = stepBeats(pattern);
  const cycle = patternBeats(pattern);
  const notes: MidiNote[] = [];

  pattern.channels.forEach((channel, channelIndex) => {
    if (channel.muted) return;
    channel.steps.forEach((slot, stepIndex) => {
      if (!slot.on) return;
      if (!options.ignoreProbability && slot.probability < 1) {
        if (stepChance(pattern.seed, channelIndex, stepIndex) >= slot.probability) return;
      }
      const ratchet = Math.max(1, Math.round(slot.ratchet));
      const base = stepTime(pattern, stepIndex, slot.nudge);
      // A ratchet divides the step, so a roll stays inside its own slot
      // instead of running over the next hit.
      const subStep = step / ratchet;
      const duration = Math.max(MIN_NOTE_BEATS, subStep * channel.gate);

      for (let r = 0; r < repeats; r++) {
        for (let k = 0; k < ratchet; k++) {
          notes.push(createNote({
            pitch: channel.pitch,
            startBeat: r * cycle + base + k * subStep,
            durationBeat: duration,
            velocity: slot.velocity,
            // A roll that does not taper sounds like a machine, so the
            // retriggers after the first come in slightly softer.
            ...(k > 0 ? { velocity: slot.velocity * (1 - 0.12 * k) } : {}),
          }));
        }
      }
    });
  });

  return notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

/** Round-trip the other way: fold notes onto the nearest grid slot. */
export function notesToSteps(
  pattern: StepPattern, notes: readonly MidiNote[],
): StepPattern {
  const step = stepBeats(pattern);
  const channels = pattern.channels.map((c) => ({ ...c, steps: createSteps(c.steps.length) }));
  for (const note of notes) {
    const channel = channels.find((c) => c.pitch === note.pitch);
    if (!channel) continue;
    const index = Math.round(note.startBeat / step);
    if (index < 0 || index >= channel.steps.length) continue;
    const slot = channel.steps[index];
    if (!slot) continue;
    slot.on = true;
    slot.velocity = note.velocity;
    // Whatever the grid could not represent becomes nudge, not silence.
    slot.nudge = Math.max(-0.5, Math.min(0.5, (note.startBeat - index * step) / step));
  }
  return { ...pattern, channels };
}

export function activeStepCount(pattern: StepPattern): number {
  return pattern.channels.reduce((sum, c) => sum + c.steps.filter((s) => s.on).length, 0);
}

export function describePattern(pattern: StepPattern): string {
  return `${pattern.name} · ${pattern.stepCount}스텝 · ${pattern.channels.length}채널`
    + ` · ${activeStepCount(pattern)}히트 · ${patternBeats(pattern).toFixed(2)}박`
    + (pattern.swing > 0 ? ` · 스윙 ${(pattern.swing * 100).toFixed(0)}%` : '');
}
