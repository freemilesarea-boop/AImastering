// Groove — the timing a performance actually has, lifted off it.
//
// Quantising to a grid is the easy half of rhythm and the one that kills a
// take: it removes exactly the deviation that made the part feel played.  A
// groove template is the other half.  It says "the second sixteenth of every
// beat lands 18 ms late and a little softer", and it says it as MEASURED
// data, so the feel of one recording can be put onto notes that were typed
// in with a mouse.
//
// Two rules shape everything here:
//
//   A SLOT WITH NO ONSETS CARRIES NO INFORMATION.  A four-to-the-floor kick
//   says nothing about where the off-sixteenths sit.  Every slot therefore
//   carries the weight that built it, and `applyGroove` leaves notes on
//   empty slots exactly where they were rather than pulling them onto a
//   grid position that was never played.  This is the difference between a
//   groove template and a quantiser wearing one.
//
//   THE GRID HAS TO BE THE ONE THAT WAS PLAYED AGAINST.  A shuffled eighth
//   read on a sixteenth grid is not swing — it is a note on the third
//   sixteenth, slightly early, and applying it to straight eighths does
//   nothing.  `chooseGrid` picks the resolution by CONSISTENCY, not by
//   closeness: the right grid is the one where every onset assigned to a
//   slot agrees with the others in that slot, however far from the line
//   they all sit together.
//
// Everything is in BEATS, matching the MIDI model (see `model/midi.ts`);
// seconds enter only through `onsetsToBeats`.

import type { MidiNote } from './midi';
import { clamp01 } from './midi';
import type { WeightedOnset } from './tempo-detect';

/** An attack placed in musical time. */
export interface GrooveOnset {
  /** Beats from the start of the analysed material. */
  beat: number;
  /** Relative strength 0…1 — becomes the slot's velocity. */
  weight: number;
}

export interface Groove {
  name: string;
  /** 4 = sixteenths, 2 = eighths, 3 = eighth triplets. */
  slotsPerBeat: number;
  /** Length of the template in beats — 4 is one bar of 4/4. */
  beats: number;
  /** Timing deviation per slot, in beats.  Positive is late. */
  offsets: readonly number[];
  /** Measured velocity per slot, 0…1; null where nothing was played. */
  velocities: readonly (number | null)[];
  /** Onset weight that built each slot.  0 means: this slot knows nothing. */
  weights: readonly number[];
}

export interface GrooveExtraction {
  groove: Groove | null;
  /** Why there is no groove, when there is none. */
  reason: string | null;
}

export interface ExtractOptions {
  /** Grid resolution.  Omit to let `chooseGrid` decide from the material. */
  slotsPerBeat?: number;
  /** Template length in beats. */
  beats?: number;
  name?: string;
}

export interface ApplyOptions {
  /** 0…1 — how far notes move toward the template. */
  strength?: number;
  /** 0…1 — how far velocities move toward the template's.  0 leaves them. */
  velocityStrength?: number;
}

const DEFAULT_BEATS = 4;
/** Grids offered to `chooseGrid`, coarsest first — the coarsest that fits wins. */
export const GRID_CHOICES = [1, 2, 3, 4, 6, 8] as const;

// ── From seconds ──────────────────────────────────────────────────────────────

/**
 * Detected onsets become musical positions.
 *
 * `phaseSec` is where the first beat is — the second half of what
 * `detectTempo` returns, and the reason it returns it.
 */
export function onsetsToBeats(
  onsets: readonly WeightedOnset[], bpm: number, phaseSec: number,
): GrooveOnset[] {
  if (bpm <= 0) return [];
  return onsets.map((o) => ({
    beat: ((o.timeSec - phaseSec) * bpm) / 60,
    weight: o.weight,
  }));
}

/** MIDI notes are already musical time; their velocity is the weight. */
export function onsetsFromNotes(
  notes: readonly MidiNote[], ids?: ReadonlySet<string>,
): GrooveOnset[] {
  return notes
    .filter((n) => !n.muted && (!ids || ids.has(n.id)))
    .map((n) => ({ beat: n.startBeat, weight: Math.max(0.01, n.velocity) }));
}

// ── Choosing the grid ─────────────────────────────────────────────────────────

/** Slot index for a beat position, folded into the template. */
function slotOf(beat: number, slotsPerBeat: number, totalSlots: number): number {
  const slot = Math.round(beat * slotsPerBeat);
  return ((slot % totalSlots) + totalSlots) % totalSlots;
}

/**
 * How much the onsets in each slot AGREE with each other, 0…1.
 *
 * Not how close they are to the line — how close they are to EACH OTHER.
 * A grid that is too coarse smears unrelated notes into one slot and the
 * spread gives it away; a grid that matches what was played has every slot
 * tight, even when the whole slot sits a long way off the beat.  Slots with
 * a single onset are skipped: one measurement never disagrees with itself,
 * and counting it as agreement would hand the prize to the coarsest grid.
 */
export function gridConsistency(
  onsets: readonly GrooveOnset[], slotsPerBeat: number, beats: number,
): number {
  const totalSlots = Math.max(1, Math.round(slotsPerBeat * beats));
  const slotSize = 1 / slotsPerBeat;
  const groups: { offset: number; weight: number }[][] =
    Array.from({ length: totalSlots }, () => []);

  for (const onset of onsets) {
    if (onset.weight <= 0) continue;
    const index = slotOf(onset.beat, slotsPerBeat, totalSlots);
    const nearest = Math.round(onset.beat * slotsPerBeat) * slotSize;
    groups[index]?.push({ offset: onset.beat - nearest, weight: onset.weight });
  }

  let spread = 0;
  let counted = 0;
  for (const group of groups) {
    if (group.length < 2) continue;
    const weight = group.reduce((sum, g) => sum + g.weight, 0);
    if (weight <= 0) continue;
    const mean = group.reduce((sum, g) => sum + g.offset * g.weight, 0) / weight;
    spread += group.reduce((sum, g) => sum + Math.abs(g.offset - mean) * g.weight, 0);
    counted += weight;
  }
  if (counted <= 0) return 0;
  // Normalised against the half-slot: a deviation of half a slot means the
  // onset could belong to the neighbouring slot just as well.
  return Math.max(0, 1 - (spread / counted) / (slotSize / 2));
}

/**
 * The coarsest grid the material is consistent on.
 *
 * Coarsest, not best: a sixteenth grid can describe any eighth-note part, but
 * it does so with half its slots empty, and empty slots are how a groove
 * template quietly stops applying to anything.
 */
export function chooseGrid(
  onsets: readonly GrooveOnset[], beats: number, threshold = 0.7,
): number {
  let fallback = GRID_CHOICES[GRID_CHOICES.length - 1] ?? 4;
  let bestScore = -1;
  for (const slotsPerBeat of GRID_CHOICES) {
    const score = gridConsistency(onsets, slotsPerBeat, beats);
    if (score >= threshold) return slotsPerBeat;
    if (score > bestScore) { bestScore = score; fallback = slotsPerBeat; }
  }
  return fallback;
}

// ── Extraction ────────────────────────────────────────────────────────────────

export function extractGroove(
  onsets: readonly GrooveOnset[], options: ExtractOptions = {},
): GrooveExtraction {
  const beats = options.beats && options.beats > 0 ? options.beats : DEFAULT_BEATS;
  const usable = onsets.filter((o) => o.weight > 0 && Number.isFinite(o.beat));
  if (usable.length < 4) {
    return { groove: null, reason: '어택이 너무 적습니다 — 최소 4개가 필요합니다' };
  }

  const slotsPerBeat = options.slotsPerBeat && options.slotsPerBeat > 0
    ? Math.round(options.slotsPerBeat)
    : chooseGrid(usable, beats);
  const totalSlots = Math.max(1, Math.round(slotsPerBeat * beats));
  const slotSize = 1 / slotsPerBeat;

  const offsetSum = new Array<number>(totalSlots).fill(0);
  const velocitySum = new Array<number>(totalSlots).fill(0);
  const weights = new Array<number>(totalSlots).fill(0);

  for (const onset of usable) {
    const index = slotOf(onset.beat, slotsPerBeat, totalSlots);
    const nearest = Math.round(onset.beat * slotsPerBeat) * slotSize;
    offsetSum[index] = (offsetSum[index] ?? 0) + (onset.beat - nearest) * onset.weight;
    velocitySum[index] = (velocitySum[index] ?? 0) + onset.weight * onset.weight;
    weights[index] = (weights[index] ?? 0) + onset.weight;
  }

  const offsets: number[] = [];
  const velocities: (number | null)[] = [];
  let filled = 0;
  for (let i = 0; i < totalSlots; i++) {
    const weight = weights[i] ?? 0;
    if (weight <= 0) { offsets.push(0); velocities.push(null); continue; }
    filled++;
    offsets.push((offsetSum[i] ?? 0) / weight);
    velocities.push(clamp01((velocitySum[i] ?? 0) / weight));
  }

  if (filled < 2) {
    return { groove: null, reason: '어택이 한 자리에만 모여 있습니다 — 그루브를 만들 수 없습니다' };
  }

  return {
    groove: {
      name: options.name ?? `${slotsPerBeat * beats}슬롯 그루브`,
      slotsPerBeat, beats, offsets, velocities, weights,
    },
    reason: null,
  };
}

// ── Application ───────────────────────────────────────────────────────────────

/**
 * Put a groove onto notes.
 *
 * Notes on slots the template never saw are RETURNED UNTOUCHED — not snapped,
 * not nudged.  A kick-only groove applied to a hi-hat part should change the
 * kicks and leave the hats alone, and the alternative (treating an empty slot
 * as "offset 0") is a quantiser pretending to be a groove.
 */
export function applyGroove(
  notes: readonly MidiNote[], ids: ReadonlySet<string> | null, groove: Groove,
  options: ApplyOptions = {},
): MidiNote[] {
  const strength = clamp01(options.strength ?? 1);
  const velocityStrength = clamp01(options.velocityStrength ?? 0);
  const totalSlots = Math.max(1, Math.round(groove.slotsPerBeat * groove.beats));
  const slotSize = 1 / groove.slotsPerBeat;

  return notes.map((n) => {
    if (ids && !ids.has(n.id)) return n;
    const index = slotOf(n.startBeat, groove.slotsPerBeat, totalSlots);
    if ((groove.weights[index] ?? 0) <= 0) return n;

    const target = Math.round(n.startBeat * groove.slotsPerBeat) * slotSize
      + (groove.offsets[index] ?? 0);
    const startBeat = Math.max(0, n.startBeat + (target - n.startBeat) * strength);

    const slotVelocity = groove.velocities[index];
    const velocity = velocityStrength > 0 && slotVelocity != null
      ? clamp01(n.velocity + (slotVelocity - n.velocity) * velocityStrength)
      : n.velocity;

    return startBeat === n.startBeat && velocity === n.velocity
      ? n
      : { ...n, startBeat, velocity };
  }).sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

/**
 * Does the template have anything to say about a note at this beat?
 *
 * The question a caller has to be able to ask separately from "did the note
 * move".  A note that is already sitting where the groove wants it does not
 * move either, and reporting the two the same way tells the user their groove
 * missed half the part when it fitted it perfectly.
 */
export function grooveKnows(groove: Groove, beat: number): boolean {
  const totalSlots = Math.max(1, Math.round(groove.slotsPerBeat * groove.beats));
  return (groove.weights[slotOf(beat, groove.slotsPerBeat, totalSlots)] ?? 0) > 0;
}

// ── Reading a groove ──────────────────────────────────────────────────────────

/**
 * The swing of a groove on the familiar 50…75 scale.
 *
 * 50 is straight, 66.7 is a triplet shuffle, 75 is a dotted-eighth feel.
 * Returns null when the grid is odd-numbered (a triplet grid has no "off"
 * slot to be late) or when no off-slot was played.
 */
export function swingPercent(groove: Groove): number | null {
  if (groove.slotsPerBeat % 2 !== 0) return null;
  const totalSlots = Math.round(groove.slotsPerBeat * groove.beats);
  const slotSize = 1 / groove.slotsPerBeat;
  let sum = 0;
  let weight = 0;
  for (let i = 1; i < totalSlots; i += 2) {
    const w = groove.weights[i] ?? 0;
    if (w <= 0) continue;
    sum += (groove.offsets[i] ?? 0) * w;
    weight += w;
  }
  if (weight <= 0) return null;
  const mean = sum / weight;
  return Math.round(((slotSize + mean) / (2 * slotSize)) * 1000) / 10;
}

/** The widest timing deviation in the template, in beats. */
export function grooveDepth(groove: Groove): number {
  let depth = 0;
  for (let i = 0; i < groove.offsets.length; i++) {
    if ((groove.weights[i] ?? 0) <= 0) continue;
    depth = Math.max(depth, Math.abs(groove.offsets[i] ?? 0));
  }
  return depth;
}

const GRID_NAMES: Record<number, string> = {
  1: '4분음표', 2: '8분음표', 3: '8분셋잇단', 4: '16분음표',
  6: '16분셋잇단', 8: '32분음표',
};

export function describeGroove(groove: Groove): string {
  const totalSlots = Math.round(groove.slotsPerBeat * groove.beats);
  const filled = groove.weights.filter((w) => w > 0).length;
  const grid = GRID_NAMES[groove.slotsPerBeat] ?? `1/${groove.slotsPerBeat}박`;
  const swing = swingPercent(groove);
  const swingText = swing == null ? '' : `, 스윙 ${swing.toFixed(1)}%`;
  const depthMs = grooveDepth(groove);
  return `${grid} 격자 · ${filled}/${totalSlots}슬롯${swingText}`
    + `, 최대 편차 ${(depthMs * 1000).toFixed(0)}/1000박`;
}
