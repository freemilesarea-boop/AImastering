// The tempo map — where a beat lands in seconds, and back.
//
// A session used to have one number for its tempo.  That number is fine right
// up until the music does anything: a ritardando at the end, a bridge in 6/8,
// a live take that breathes.  From that moment the grid is wrong everywhere,
// and everything built on the grid — snapping, warp, the metronome, the step
// sequencer — is wrong with it.
//
// ── Beats, not seconds ─────────────────────────────────────────────────────
//
// Every event here is positioned in QUARTER-NOTE BEATS from the session start,
// never in seconds.  The reason is the same one the warp markers have: an event
// written in seconds has to be rewritten every time an EARLIER tempo changes,
// and two representations of the same truth is how a tempo map rots.  A beat
// position is invariant under every edit except its own.
//
// ── Two ways to get from one tempo to the next ────────────────────────────
//
//   jump   the tempo holds, then changes at the next event.  A section break.
//   ramp   the tempo moves linearly IN BPM across the beats between them.
//          A ritardando, an accelerando.
//
// A linear-in-BPM ramp does not integrate to a linear time.  Seconds per beat
// is 60/T, so the elapsed time across a ramp is
//
//     ∫ 60/(t₀ + k·u) du  =  (60/k)·ln(T(b)/t₀)          k = ΔBPM / Δbeats
//
// which is exact and closed form — no numerical integration, no drift, and it
// inverts exactly too.  Stepping a ramp in small slices would accumulate error
// over a four-minute song, and the error is audible as the click drifting off
// the downbeat.
//
// ── Time signatures ────────────────────────────────────────────────────────
//
// Anchored to BAR numbers rather than beats, because that is how they are
// written and how they are read: "6/8 from bar 33".  A bar in 6/8 is three
// quarter notes, so the beat axis stays quarter notes throughout and the meter
// only decides where the bar lines fall on it.

import { nextId } from './ids.js';
import type {
  DawSession, MeterEvent, TempoCurve, TempoEvent, TempoMap,
} from './types.js';

export type { MeterEvent, TempoCurve, TempoEvent, TempoMap };

export const MIN_BPM = 5;
export const MAX_BPM = 999;

export const clampBpm = (bpm: number): number =>
  Math.max(MIN_BPM, Math.min(MAX_BPM, Number.isFinite(bpm) ? bpm : 120));

/** Quarter notes in one bar of this signature.  6/8 is three, not six. */
export function beatsPerBar(meter: Pick<MeterEvent, 'numerator' | 'denominator'>): number {
  return Math.max(0.25, meter.numerator * (4 / Math.max(1, meter.denominator)));
}

export function defaultTempoMap(bpm = 120, signature: [number, number] = [4, 4]): TempoMap {
  return {
    tempos: [{ id: nextId('tempo'), beat: 0, bpm: clampBpm(bpm), curve: 'jump' }],
    meters: [{
      id: nextId('meter'), bar: 1,
      numerator: Math.max(1, signature[0]),
      denominator: Math.max(1, signature[1]),
    }],
  };
}

/**
 * Put a map into the shape everything else assumes.
 *
 * Sorted, no two events at the same position, and an event at the very start —
 * because "what is the tempo at bar 1" must always have an answer, and a map
 * whose first event is at bar 9 has no answer for bars 1 to 8.
 */
export function normaliseTempoMap(map: TempoMap): TempoMap {
  const tempos = [...map.tempos]
    .filter((e) => Number.isFinite(e.beat) && Number.isFinite(e.bpm))
    .map((e) => ({ ...e, beat: Math.max(0, e.beat), bpm: clampBpm(e.bpm) }))
    .sort((a, b) => a.beat - b.beat);

  // Later wins at the same position: that is what dragging one event onto
  // another means.
  const dedupedTempos: TempoEvent[] = [];
  for (const event of tempos) {
    const last = dedupedTempos[dedupedTempos.length - 1];
    if (last && Math.abs(last.beat - event.beat) < 1e-6) dedupedTempos[dedupedTempos.length - 1] = event;
    else dedupedTempos.push(event);
  }
  if (dedupedTempos.length === 0 || (dedupedTempos[0]?.beat ?? 0) > 1e-6) {
    dedupedTempos.unshift({
      id: nextId('tempo'), beat: 0,
      bpm: dedupedTempos[0]?.bpm ?? 120,
      curve: 'jump',
    });
  }

  const meters = [...map.meters]
    .filter((m) => Number.isFinite(m.bar))
    .map((m) => ({
      ...m,
      bar: Math.max(1, Math.round(m.bar)),
      numerator: Math.max(1, Math.round(m.numerator)),
      denominator: Math.max(1, Math.round(m.denominator)),
    }))
    .sort((a, b) => a.bar - b.bar);

  const dedupedMeters: MeterEvent[] = [];
  for (const meter of meters) {
    const last = dedupedMeters[dedupedMeters.length - 1];
    if (last && last.bar === meter.bar) dedupedMeters[dedupedMeters.length - 1] = meter;
    else dedupedMeters.push(meter);
  }
  if (dedupedMeters.length === 0 || (dedupedMeters[0]?.bar ?? 1) > 1) {
    dedupedMeters.unshift({
      id: nextId('meter'), bar: 1,
      numerator: dedupedMeters[0]?.numerator ?? 4,
      denominator: dedupedMeters[0]?.denominator ?? 4,
    });
  }

  return { tempos: dedupedTempos, meters: dedupedMeters };
}

// ── Compiled form ───────────────────────────────────────────────────────────
//
// Converting a beat to seconds means summing every segment before it.  Doing
// that from scratch on every call is fine for a handful of events and not fine
// when the ruler asks for four hundred bar lines per frame, so the running
// totals are computed once and cached against the map object itself.

export interface CompiledTempo {
  map: TempoMap;
  /** Beat of each tempo event. */
  beats: number[];
  /** Seconds at each tempo event. */
  secs: number[];
  bpms: number[];
  curves: TempoCurve[];
  /** Beat at which each meter's bar starts, parallel to `map.meters`. */
  meterStartBeats: number[];
}

const cache = new WeakMap<TempoMap, CompiledTempo>();

export function compileTempoMap(raw: TempoMap): CompiledTempo {
  const hit = cache.get(raw);
  if (hit) return hit;

  const map = normaliseTempoMap(raw);
  const beats = map.tempos.map((e) => e.beat);
  const bpms = map.tempos.map((e) => e.bpm);
  const curves = map.tempos.map((e) => e.curve);
  const secs: number[] = new Array<number>(beats.length).fill(0);

  for (let i = 0; i + 1 < beats.length; i++) {
    secs[i + 1] = (secs[i] ?? 0) + segmentSeconds(
      beats[i]!, bpms[i]!, curves[i]!, beats[i + 1]!, bpms[i + 1]!, beats[i + 1]!,
    );
  }

  // Where each meter change's bar begins, on the beat axis.
  const meterStartBeats: number[] = [];
  let beat = 0;
  let bar = 1;
  for (let i = 0; i < map.meters.length; i++) {
    const meter = map.meters[i]!;
    beat += (meter.bar - bar) * beatsPerBar(map.meters[i - 1] ?? meter);
    bar = meter.bar;
    meterStartBeats.push(beat);
  }

  const compiled: CompiledTempo = { map, beats, secs, bpms, curves, meterStartBeats };
  cache.set(raw, compiled);
  cache.set(map, compiled);
  return compiled;
}

/** Seconds from `fromBeat` to `toBeat` inside one segment. */
function segmentSeconds(
  fromBeat: number, fromBpm: number, curve: TempoCurve,
  nextBeat: number, nextBpm: number, toBeat: number,
): number {
  const span = toBeat - fromBeat;
  if (span <= 0) return 0;
  const segment = nextBeat - fromBeat;
  if (curve !== 'ramp' || segment <= 1e-9 || Math.abs(nextBpm - fromBpm) < 1e-9) {
    return (span * 60) / fromBpm;
  }
  // Linear in BPM: exact integral of 60/T db, never a stepped approximation.
  const k = (nextBpm - fromBpm) / segment;
  const tempoHere = fromBpm + k * span;
  return (60 / k) * Math.log(tempoHere / fromBpm);
}

// ── Beats ↔ seconds ─────────────────────────────────────────────────────────

export function beatToSec(map: TempoMap, beat: number): number {
  const c = compileTempoMap(map);
  const target = Math.max(0, beat);
  const i = segmentIndexByBeat(c, target);
  const isLast = i === c.beats.length - 1;
  return (c.secs[i] ?? 0) + segmentSeconds(
    c.beats[i]!, c.bpms[i]!, isLast ? 'jump' : c.curves[i]!,
    isLast ? c.beats[i]! + 1 : c.beats[i + 1]!,
    isLast ? c.bpms[i]! : c.bpms[i + 1]!,
    target,
  );
}

export function secToBeat(map: TempoMap, sec: number): number {
  const c = compileTempoMap(map);
  const target = Math.max(0, sec);
  const i = segmentIndexBySec(c, target);
  const elapsed = target - (c.secs[i] ?? 0);
  const isLast = i === c.beats.length - 1;
  const fromBpm = c.bpms[i]!;

  if (isLast || c.curves[i] !== 'ramp') {
    return (c.beats[i] ?? 0) + (elapsed * fromBpm) / 60;
  }
  const segment = c.beats[i + 1]! - c.beats[i]!;
  const nextBpm = c.bpms[i + 1]!;
  if (segment <= 1e-9 || Math.abs(nextBpm - fromBpm) < 1e-9) {
    return (c.beats[i] ?? 0) + (elapsed * fromBpm) / 60;
  }
  // The exact inverse of the ramp integral above.
  const k = (nextBpm - fromBpm) / segment;
  const tempoHere = fromBpm * Math.exp((k * elapsed) / 60);
  return (c.beats[i] ?? 0) + (tempoHere - fromBpm) / k;
}

function segmentIndexByBeat(c: CompiledTempo, beat: number): number {
  let lo = 0;
  for (let i = 1; i < c.beats.length; i++) {
    if ((c.beats[i] ?? 0) <= beat + 1e-9) lo = i; else break;
  }
  return lo;
}

function segmentIndexBySec(c: CompiledTempo, sec: number): number {
  let lo = 0;
  for (let i = 1; i < c.secs.length; i++) {
    if ((c.secs[i] ?? 0) <= sec + 1e-9) lo = i; else break;
  }
  return lo;
}

/** The tempo in force at a beat — inside a ramp, the interpolated value. */
export function tempoAtBeat(map: TempoMap, beat: number): number {
  const c = compileTempoMap(map);
  const i = segmentIndexByBeat(c, Math.max(0, beat));
  const isLast = i === c.beats.length - 1;
  if (isLast || c.curves[i] !== 'ramp') return c.bpms[i]!;
  const segment = c.beats[i + 1]! - c.beats[i]!;
  if (segment <= 1e-9) return c.bpms[i]!;
  const t = Math.min(1, Math.max(0, (beat - c.beats[i]!) / segment));
  return c.bpms[i]! + t * (c.bpms[i + 1]! - c.bpms[i]!);
}

export function tempoAtSec(map: TempoMap, sec: number): number {
  return tempoAtBeat(map, secToBeat(map, sec));
}

/** Seconds one quarter note takes at a moment — the metronome's interval. */
export function beatSecondsAt(map: TempoMap, sec: number): number {
  return 60 / clampBpm(tempoAtSec(map, sec));
}

// ── Bars and beats ──────────────────────────────────────────────────────────

/** The signature in force at a bar. */
export function meterAtBar(map: TempoMap, bar: number): MeterEvent {
  const c = compileTempoMap(map);
  let found = c.map.meters[0]!;
  for (const meter of c.map.meters) {
    if (meter.bar <= bar) found = meter; else break;
  }
  return found;
}

/** The signature in force at a beat position. */
export function meterAtBeat(map: TempoMap, beat: number): MeterEvent {
  const c = compileTempoMap(map);
  let found = c.map.meters[0]!;
  for (let i = 0; i < c.map.meters.length; i++) {
    if ((c.meterStartBeats[i] ?? 0) <= beat + 1e-9) found = c.map.meters[i]!; else break;
  }
  return found;
}

/** Absolute beat where a bar begins. */
export function barStartBeat(map: TempoMap, bar: number): number {
  const c = compileTempoMap(map);
  const target = Math.max(1, Math.floor(bar));
  let beat = 0;
  let at = 1;
  for (let i = 0; i < c.map.meters.length; i++) {
    const meter = c.map.meters[i]!;
    const next = c.map.meters[i + 1];
    const until = next ? Math.min(next.bar, target) : target;
    if (until > at) {
      beat += (until - at) * beatsPerBar(meter);
      at = until;
    }
    if (at >= target) break;
  }
  return beat;
}

export interface BarBeat {
  /** 1-based. */
  bar: number;
  /** 1-based, within the bar, in the signature's own beat unit. */
  beat: number;
  /** 0…959, the classic 960-per-beat subdivision. */
  tick: number;
}

export const TICKS_PER_BEAT = 960;

/** Where a beat position sits, as a musician would say it. */
export function barBeatAt(map: TempoMap, beat: number): BarBeat {
  const c = compileTempoMap(map);
  const target = Math.max(0, beat);

  let bar = 1;
  let cursor = 0;
  for (let i = 0; i < c.map.meters.length; i++) {
    const meter = c.map.meters[i]!;
    const start = c.meterStartBeats[i] ?? 0;
    const next = c.map.meters[i + 1];
    const end = next ? (c.meterStartBeats[i + 1] ?? Infinity) : Infinity;
    if (target < start - 1e-9) break;
    const per = beatsPerBar(meter);
    const within = Math.min(target, end) - start;
    const barsHere = Math.floor(within / per + 1e-9);
    bar = meter.bar + barsHere;
    cursor = start + barsHere * per;
    if (target < end - 1e-9) break;
  }

  const meter = meterAtBeat(map, target);
  // Inside the bar the count is in the signature's unit: 6/8 counts eight
  // notes, not quarter notes.
  const unit = 4 / Math.max(1, meter.denominator);
  const intoBar = Math.max(0, target - cursor);
  const beatsIn = intoBar / unit;
  const whole = Math.floor(beatsIn + 1e-9);
  const frac = beatsIn - whole;
  return {
    bar,
    beat: whole + 1,
    tick: Math.round(frac * TICKS_PER_BEAT) % TICKS_PER_BEAT,
  };
}

/** `12|3|240` — the transport readout. */
export function formatBarBeat(map: TempoMap, sec: number, withTicks = true): string {
  const { bar, beat, tick } = barBeatAt(map, secToBeat(map, sec));
  return withTicks ? `${bar}|${beat}|${String(tick).padStart(3, '0')}` : `${bar}|${beat}`;
}

export interface GridLine {
  sec: number;
  bar: number;
  beat: number;
  /** True on a downbeat — drawn brighter. */
  isBar: boolean;
}

/**
 * Bar and beat lines across a window of time.
 *
 * Walks bars rather than stepping seconds, because with a tempo map the two
 * are not the same thing: a ritardando makes the last bar of a window twice as
 * wide as the first, and a grid drawn at a fixed second interval would sit
 * next to the music instead of on it.
 *
 * `maxLines` is a guard, not a feature: zoomed all the way out, a five-minute
 * song is a thousand bars, and drawing beats inside them would be a grey wash.
 */
export function gridLines(
  map: TempoMap, fromSec: number, toSec: number,
  options: { beats?: boolean; maxLines?: number } = {},
): GridLine[] {
  const maxLines = options.maxLines ?? 600;
  const out: GridLine[] = [];
  if (!(toSec > fromSec)) return out;

  const startBar = Math.max(1, barBeatAt(map, secToBeat(map, Math.max(0, fromSec))).bar);
  let bar = startBar;
  let guard = 0;

  while (guard++ < maxLines) {
    const beatOfBar = barStartBeat(map, bar);
    const sec = beatToSec(map, beatOfBar);
    if (sec > toSec) break;
    if (sec >= fromSec) out.push({ sec, bar, beat: 1, isBar: true });

    if (options.beats) {
      const meter = meterAtBar(map, bar);
      const unit = 4 / Math.max(1, meter.denominator);
      for (let b = 1; b < meter.numerator; b++) {
        const at = beatToSec(map, beatOfBar + b * unit);
        if (at > toSec) break;
        if (at >= fromSec) out.push({ sec: at, bar, beat: b + 1, isBar: false });
        if (out.length >= maxLines) return out;
      }
    }
    if (out.length >= maxLines) break;
    bar += 1;
  }
  return out;
}

// ── Snapping ────────────────────────────────────────────────────────────────

/**
 * Snap a time to a musical division.
 *
 * `division` is in quarter notes: 1 is a beat, 0.25 a sixteenth, 4 a bar of
 * 4/4.  Rounding happens on the BEAT axis and is converted back, which is the
 * whole point — rounding in seconds would snap to a grid that no longer
 * exists once the tempo moves.
 */
export function snapSecToBeats(map: TempoMap, sec: number, division: number): number {
  if (!(division > 0)) return Math.max(0, sec);
  const beat = secToBeat(map, Math.max(0, sec));
  return beatToSec(map, Math.round(beat / division) * division);
}

/** Snap to the nearest bar line. */
export function snapSecToBar(map: TempoMap, sec: number): number {
  const here = barBeatAt(map, secToBeat(map, Math.max(0, sec)));
  const thisBar = beatToSec(map, barStartBeat(map, here.bar));
  const nextBar = beatToSec(map, barStartBeat(map, here.bar + 1));
  return sec - thisBar <= nextBar - sec ? thisBar : nextBar;
}

// ── Editing ─────────────────────────────────────────────────────────────────

export function addTempoEvent(
  map: TempoMap, beat: number, bpm: number, curve: TempoCurve = 'jump',
): TempoMap {
  return normaliseTempoMap({
    ...map,
    tempos: [...map.tempos, { id: nextId('tempo'), beat: Math.max(0, beat), bpm: clampBpm(bpm), curve }],
  });
}

export function updateTempoEvent(
  map: TempoMap, id: string, patch: Partial<Omit<TempoEvent, 'id'>>,
): TempoMap {
  return normaliseTempoMap({
    ...map,
    tempos: map.tempos.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  });
}

/**
 * Remove a tempo event.
 *
 * The one at beat 0 cannot go: something has to say what the tempo is at the
 * start, and a map without it has no answer for the first bar.  Editing its
 * value is how you change the opening tempo.
 */
export function removeTempoEvent(map: TempoMap, id: string): TempoMap {
  const target = map.tempos.find((e) => e.id === id);
  if (!target || target.beat <= 1e-9) return map;
  return normaliseTempoMap({ ...map, tempos: map.tempos.filter((e) => e.id !== id) });
}

export function addMeterEvent(
  map: TempoMap, bar: number, numerator: number, denominator: number,
): TempoMap {
  return normaliseTempoMap({
    ...map,
    meters: [...map.meters, {
      id: nextId('meter'),
      bar: Math.max(1, Math.round(bar)),
      numerator: Math.max(1, Math.round(numerator)),
      denominator: Math.max(1, Math.round(denominator)),
    }],
  });
}

export function updateMeterEvent(
  map: TempoMap, id: string, patch: Partial<Omit<MeterEvent, 'id'>>,
): TempoMap {
  return normaliseTempoMap({
    ...map,
    meters: map.meters.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  });
}

/** Remove a signature change.  The one at bar 1 stays, for the same reason. */
export function removeMeterEvent(map: TempoMap, id: string): TempoMap {
  const target = map.meters.find((m) => m.id === id);
  if (!target || target.bar <= 1) return map;
  return normaliseTempoMap({ ...map, meters: map.meters.filter((m) => m.id !== id) });
}

// ── Describing ──────────────────────────────────────────────────────────────

/**
 * A short string that changes whenever the map does.
 *
 * Used as part of a render cache key: two clips at the same nominal tempo can
 * stretch differently under a map, so a cache keyed on BPM alone would hand
 * one of them the other's audio.
 */
export function tempoMapKey(map: TempoMap): string {
  const c = compileTempoMap(map);
  const tempos = c.map.tempos
    .map((e) => `${e.beat.toFixed(4)}@${e.bpm.toFixed(3)}${e.curve === 'ramp' ? 'r' : ''}`)
    .join(',');
  const meters = c.map.meters.map((m) => `${m.bar}:${m.numerator}/${m.denominator}`).join(',');
  return `${tempos};${meters}`;
}

export function isConstantTempo(map: TempoMap): boolean {
  const c = compileTempoMap(map);
  return c.map.tempos.length === 1 && c.map.meters.length === 1;
}

/** One line for the transport: `120 BPM` or `76 → 132 BPM · 3 변화`. */
export function describeTempoMap(map: TempoMap): string {
  const c = compileTempoMap(map);
  const bpms = c.bpms;
  const first = bpms[0] ?? 120;
  if (c.map.tempos.length === 1) return `${round(first)} BPM`;
  const lo = Math.min(...bpms);
  const hi = Math.max(...bpms);
  const changes = c.map.tempos.length - 1 + (c.map.meters.length - 1);
  return `${round(lo)}–${round(hi)} BPM · 변화 ${changes}`;
}

const round = (v: number): string => (Math.abs(v - Math.round(v)) < 0.05
  ? String(Math.round(v)) : v.toFixed(1));

/**
 * The single tempo that best stands in for the map.
 *
 * Sessions still carry `tempoBpm`, and features that have not been taught the
 * map yet read it.  Rather than leave it stale it is kept as the tempo at the
 * start, which is what a musician means by "the tempo of the song" and what a
 * map with no changes in it says anyway.
 */
export function representativeBpm(map: TempoMap): number {
  return clampBpm(compileTempoMap(map).bpms[0] ?? 120);
}

// ── The session's map ───────────────────────────────────────────────────────

/**
 * The map a session actually has.
 *
 * Sessions saved before the tempo track existed have only `tempoBpm` and
 * `timeSignature`, and a session that has never had a change in it is
 * indistinguishable from those — so the fallback is not a migration step run
 * once, it is what every reader goes through.  Nothing else in the app reads
 * `session.tempoMap` directly.
 */
export function tempoMapOf(session: DawSession): TempoMap {
  const stored = session.tempoMap;
  if (stored && stored.tempos.length > 0) return compileTempoMap(stored).map;
  return defaultTempoMap(session.tempoBpm, session.timeSignature);
}

/**
 * Put a map back on a session, keeping the two old fields honest.
 *
 * `tempoBpm` and `timeSignature` stay as the song's opening values.  Leaving
 * them stale would mean a session whose transport says 120 and whose first bar
 * is 76, and the half of the app that has not been taught the map yet would
 * read the wrong one.
 */
export function withTempoMap(session: DawSession, map: TempoMap): DawSession {
  const normalised = normaliseTempoMap(map);
  const opening = normalised.meters[0]!;
  return {
    ...session,
    tempoMap: normalised,
    tempoBpm: representativeBpm(normalised),
    timeSignature: [opening.numerator, opening.denominator],
  };
}
