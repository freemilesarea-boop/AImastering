// Audio quantize — moving the hits onto the grid, as much as you actually want.
//
// Auto-Warp already put a marker on every transient and snapped it hard to a
// sixteenth.  That is the easy 20 % of quantize and the part nobody uses on a
// real take, because a 100 % snap is what makes a drummer sound like a
// machine: the microtiming that reads as "feel" is exactly what it deletes.
//
// The four numbers that make it usable, and what each one is for:
//
//   GRID       what counts as "on the beat".  Taken from the session's own
//              grid selector, not hardcoded — a shuffle at 1/8 and a hi-hat
//              part at 1/32 are not the same job.
//   STRENGTH   how far towards the grid to move.  50 % halves the error and
//              keeps the player; 100 % is the machine.  This is the control
//              that gets touched on every single pass.
//   SWING      where the off-beats live.  A straight grid quantised onto a
//              swung part destroys the swing, which is the most common way
//              audio quantize ruins a take.
//   TOLERANCE  hits already this close are not touched at all.  Without it,
//              quantize "fixes" the ninety hits that were right in order to
//              reach the ten that were not, and every one of those ninety is
//              a warp seam that can only make things worse.
//
// Pure: transients in, a warp config out.  The stretching is the same WSOLA
// the warp editor already uses, so a quantised take can be opened, seen, and
// dragged by hand afterwards.

import { beatSeconds, DEFAULT_WARP, type WarpConfig, type WarpMarker } from '../model/warp.js';
import { nextId } from '../model/ids.js';

const EPS = 1e-9;

export interface QuantizeOptions {
  /** Grid in quarter-note beats.  0.25 = sixteenths. */
  gridBeats: number;
  /** 0 = leave it alone, 1 = hard onto the grid. */
  strength: number;
  /**
   * How far the off-beats sit past their straight position, as a fraction of
   * the grid.  1/3 on an eighth grid is the classic triplet shuffle.
   */
  swing: number;
  /** A hit already this close to its target is left where it is. */
  toleranceMs: number;
  /** Cap, so a busy take does not produce a thousand seams. */
  maxMarkers: number;
}

export const DEFAULT_QUANTIZE: QuantizeOptions = {
  gridBeats: 0.25,
  strength: 1,
  swing: 0,
  toleranceMs: 5,
  maxMarkers: 256,
};

export interface QuantizeLimit {
  min: number;
  max: number;
  step: number;
  unit: string;
  label: string;
}

/**
 * Swing stops at half a grid division on purpose: past that the off-beat
 * would pass the next on-beat, and a quantize that reorders the hits is not
 * a quantize.
 */
export const QUANTIZE_LIMITS: Record<'strength' | 'swing' | 'toleranceMs', QuantizeLimit> = {
  strength:    { min: 0, max: 1,   step: 0.01, unit: '%',  label: '강도' },
  swing:       { min: 0, max: 0.5, step: 0.01, unit: '%',  label: '스윙' },
  toleranceMs: { min: 0, max: 120, step: 1,    unit: 'ms', label: '허용 오차' },
};

export const GRID_CHOICES: ReadonlyArray<{ beats: number; label: string }> = [
  { beats: 1,      label: '1/4' },
  { beats: 0.5,    label: '1/8' },
  { beats: 1 / 3,  label: '1/8T' },
  { beats: 0.25,   label: '1/16' },
  { beats: 1 / 6,  label: '1/16T' },
  { beats: 0.125,  label: '1/32' },
];

export function clampQuantize(options: QuantizeOptions): QuantizeOptions {
  const hold = (key: 'strength' | 'swing' | 'toleranceMs'): number => {
    const limit = QUANTIZE_LIMITS[key];
    const raw = options[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_QUANTIZE[key];
    return Math.max(limit.min, Math.min(limit.max, raw));
  };
  const grid = Number.isFinite(options.gridBeats) && options.gridBeats > 0
    ? options.gridBeats : DEFAULT_QUANTIZE.gridBeats;
  return {
    gridBeats: grid,
    strength: hold('strength'),
    swing: hold('swing'),
    toleranceMs: hold('toleranceMs'),
    maxMarkers: Math.max(2, Math.floor(options.maxMarkers) || DEFAULT_QUANTIZE.maxMarkers),
  };
}

/**
 * The grid position a beat belongs to, with swing.
 *
 * Every OTHER division is pushed late by `swing` of a division, so the grid
 * reads on-off-on-off with the off-beats behind — which is what swing is.
 * The candidate is chosen by distance rather than by rounding, because a hit
 * sitting between a straight on-beat and a swung off-beat is nearer whichever
 * it is nearer, and rounding the nominal index would always claim otherwise.
 */
export function swungTarget(beat: number, gridBeats: number, swing: number): number {
  if (!(gridBeats > 0)) return beat;
  const held = Math.max(0, Math.min(0.5, swing));
  const at = (index: number): number => index * gridBeats + (index % 2 === 0 ? 0 : held * gridBeats);
  const nominal = Math.round(beat / gridBeats);
  let best = at(nominal);
  for (const index of [nominal - 1, nominal + 1]) {
    const candidate = at(index);
    if (Math.abs(candidate - beat) < Math.abs(best - beat)) best = candidate;
  }
  return best;
}

/** One transient and what quantize would do with it. */
export interface QuantizeHit {
  /** Position in the source file, seconds. */
  sourceSec: number;
  /** Beat it plays at now, from the clip's start. */
  fromBeat: number;
  /** Beat it would play at. */
  toBeat: number;
  /** How far it moves, in ms — signed, positive is later. */
  moveMs: number;
  /**
   * True when this hit will actually change position.
   *
   * False both for a hit inside the tolerance and for any hit at zero
   * strength — what the preview counts has to be what the edit does.
   */
  moved: boolean;
  /**
   * True when the tolerance judged the hit wrong, whatever the strength then
   * does about it.  The two differ only at zero strength, which is exactly
   * the case the preview has to describe correctly: "nothing moves" because
   * the take is tight is a different message from "nothing moves" because
   * the strength is down.
   */
  outside: boolean;
}

/**
 * What quantize would do to each hit, without doing it.
 *
 * Strength is applied to the DISTANCE, not to the destination: at 50 % a hit
 * 20 ms early ends up 10 ms early rather than halfway to some absolute
 * position, which is the only reading that keeps a ritardando a ritardando.
 */
export function quantizeHits(
  transients: readonly number[],
  bpm: number,
  sourceStartSec: number,
  sourceDurationSec: number,
  options: QuantizeOptions = DEFAULT_QUANTIZE,
): QuantizeHit[] {
  const held = clampQuantize(options);
  const beat = beatSeconds(bpm);
  const endSec = sourceStartSec + sourceDurationSec;
  const out: QuantizeHit[] = [];

  for (const onset of transients) {
    if (onset <= sourceStartSec + 1e-3 || onset >= endSec - 1e-3) continue;
    if (out.length >= held.maxMarkers) break;
    const fromBeat = (onset - sourceStartSec) / beat;
    const target = swungTarget(fromBeat, held.gridBeats, held.swing);
    const pulled = fromBeat + (target - fromBeat) * held.strength;
    const moveMs = (pulled - fromBeat) * beat * 1000;
    // The tolerance is measured against the FULL correction, not the one
    // strength scaled down — "this hit was close enough" is a judgement about
    // the performance, and it must not change when the strength slider does.
    const fullMs = (target - fromBeat) * beat * 1000;
    const outside = Math.abs(fullMs) > held.toleranceMs;
    // Two different questions, and conflating them is a preview that lies.
    // OUTSIDE asks "was this hit wrong", judged on the full correction so it
    // does not change meaning when the strength slider moves.  MOVED asks
    // "will it actually go anywhere", which at zero strength is no — and a
    // dialog reporting "17 hits move" before applying nothing is worse than
    // one that reports nothing at all.
    const moved = outside && Math.abs(moveMs) > 1e-9;
    out.push({
      sourceSec: onset,
      fromBeat,
      toBeat: outside ? pulled : fromBeat,
      moveMs: outside ? moveMs : 0,
      moved,
      outside,
    });
  }
  return out;
}

/**
 * The warp config those hits describe.
 *
 * Both axes have to increase strictly — buildWarpMap divides by the gaps —
 * and quantize can break that in a way auto-warp could not: two hits that
 * land on one grid slot, or a strong correction that carries a late hit past
 * the next one.  Anything that would invert is dropped rather than nudged,
 * because a marker nudged to keep the order is a marker in a place the
 * analysis never found a transient.
 */
export function quantizeWarp(
  hits: readonly QuantizeHit[],
  bpm: number,
  sourceStartSec: number,
  sourceDurationSec: number,
  gridBeats: number,
): WarpConfig {
  const beat = beatSeconds(bpm);
  const markers: WarpMarker[] = [{ id: nextId('warp'), sourceSec: sourceStartSec, beat: 0 }];
  for (const hit of hits) {
    const prev = markers[markers.length - 1]!;
    if (hit.sourceSec <= prev.sourceSec + EPS) continue;
    if (hit.toBeat <= prev.beat + EPS) continue;
    markers.push({ id: nextId('warp'), sourceSec: hit.sourceSec, beat: hit.toBeat });
  }
  const last = markers[markers.length - 1]!;
  const endSec = sourceStartSec + sourceDurationSec;
  const endBeat = Math.max(
    last.beat + gridBeats,
    Math.round((sourceDurationSec / beat) / gridBeats) * gridBeats,
  );
  if (endSec > last.sourceSec + EPS) {
    markers.push({ id: nextId('warp'), sourceSec: endSec, beat: endBeat });
  }
  return { ...DEFAULT_WARP, enabled: true, baseBpm: bpm, markers };
}

export interface QuantizeSummary {
  /** Hits the analysis found inside the clip. */
  total: number;
  /** Hits that will actually move. */
  moved: number;
  /** Hits the tolerance judged wrong, whether or not the strength moves them. */
  outside: number;
  /** Mean and worst correction, in ms, over the ones that move. */
  meanMs: number;
  maxMs: number;
}

export function summariseQuantize(hits: readonly QuantizeHit[]): QuantizeSummary {
  const moving = hits.filter((h) => h.moved);
  // A hit whose target is not where it is, whether or not the strength lets
  // it get there.  The two counts differ only at zero strength, and that is
  // exactly the case the message has to tell apart.
  const outside = hits.filter((h) => h.outside).length;
  let sum = 0;
  let max = 0;
  for (const h of moving) {
    const d = Math.abs(h.moveMs);
    sum += d;
    if (d > max) max = d;
  }
  return {
    total: hits.length,
    moved: moving.length,
    outside,
    meanMs: moving.length > 0 ? sum / moving.length : 0,
    maxMs: max,
  };
}

/** `히트 42개 중 17개 이동 · 평균 12ms / 최대 38ms` — the preview line. */
export function describeQuantize(summary: QuantizeSummary): string {
  if (summary.total === 0) return '트랜지언트를 찾지 못했습니다';
  // "Nothing moves" has two causes and they need different fixes: raise the
  // strength, or lower the tolerance.  One message for both sends people to
  // the wrong slider.
  if (summary.moved === 0 && summary.outside > 0) {
    return `히트 ${summary.total}개 중 ${summary.outside}개가 그리드에서 벗어나 있지만 강도가 0입니다`;
  }
  if (summary.moved === 0) return `히트 ${summary.total}개 — 모두 허용 오차 안입니다`;
  return `히트 ${summary.total}개 중 ${summary.moved}개 이동 · `
    + `평균 ${summary.meanMs.toFixed(0)}ms / 최대 ${summary.maxMs.toFixed(0)}ms`;
}
