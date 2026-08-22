// Typing a position in, in whatever units the job is being talked about in.
//
// Spot mode has been a selectable edit mode since the toolbar was written
// and has never done anything: `snapToGrid` handles 'grid', ripple handles
// 'shuffle', and 'spot' fell through to the same free drag as 'slip'.  A
// button that draws and does nothing is worse than a missing feature,
// because the user believes it worked.
//
// What Spot means is: stop dragging, say where it goes.  And "where" is said
// in four different languages depending on who is asking —
//
//   TIMECODE     what a spotting note says, and what the picture's burn-in
//                reads.  Against the FILM's clock, not the session's, which
//                is why a reel starting at 01:00:00:00 spots correctly.
//   BARS|BEATS   what a composer says.  Through the tempo map, so it stays
//                right across a tempo change.
//   MIN:SEC      what everyone says out loud.
//   SAMPLES      what an engineer says when the other three are not exact
//                enough — and it is the only one of the four that is.
//
// All four convert to seconds, which is the one thing the timeline actually
// stores.  Parsing is deliberately forgiving about separators and strict
// about nonsense: `1|3`, `1.3.480` and `1|3|480` all mean something, and
// `banana` returns null rather than zero.

import { formatTimecode, parseTimecode } from './video.js';
import {
  TICKS_PER_BEAT, barBeatAt, barStartBeat, beatToSec, beatsPerBar, meterAtBar,
  secToBeat,
} from './tempo-map.js';
import type { TempoMap } from './tempo-map.js';

export type TimeFormat = 'timecode' | 'barsBeats' | 'minSec' | 'samples';

export const TIME_FORMATS: readonly TimeFormat[] = ['timecode', 'barsBeats', 'minSec', 'samples'];

export function formatLabel(format: TimeFormat): string {
  switch (format) {
    case 'timecode':  return '타임코드';
    case 'barsBeats': return '마디|박';
    case 'minSec':    return '분:초';
    default:          return '샘플';
  }
}

export function formatHint(format: TimeFormat): string {
  switch (format) {
    case 'timecode':  return '01:02:14:07';
    case 'barsBeats': return '17|3|000';
    case 'minSec':    return '1:23.456';
    default:          return '4032000';
  }
}

/** Everything the four formats need to mean anything. */
export interface SpotContext {
  sampleRate: number;
  tempoMap: TempoMap;
  /** The picture's rate, when there is a picture.  25 is a stated fallback. */
  fps: number;
  dropFrame: boolean;
  /**
   * Seconds of timecode at timeline zero.
   *
   * A reel delivered starting at 01:00:00:00 makes every spotting note an
   * hour off unless this is honoured, and being an hour off is the kind of
   * wrong that looks like a bug in the file rather than in the maths.
   */
  timecodeOffsetSec: number;
}

export const DEFAULT_FPS = 25;

// ── Bars and beats ────────────────────────────────────────────────────────────

/**
 * `bar|beat|tick` back to a beat position.
 *
 * The inverse of `barBeatAt`, and the reason it is not a one-liner: `beat`
 * is counted in the SIGNATURE's unit, and a beat in this codebase is a
 * quarter note.  In 6/8 the bar holds six beats and three quarter notes, so
 * converting without the meter puts every position in a compound signature
 * in the wrong place.
 */
export function barBeatToBeat(
  map: TempoMap, bar: number, beat: number, tick: number,
): number {
  const safeBar = Math.max(1, Math.round(bar));
  const meter = meterAtBar(map, safeBar);
  // One of the signature's beats, in quarter notes.
  const unit = 4 / meter.denominator;
  const within = (Math.max(1, beat) - 1) * unit + (Math.max(0, tick) / TICKS_PER_BEAT) * unit;
  const perBar = beatsPerBar(meter);
  return barStartBeat(map, safeBar) + Math.min(within, perBar);
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatPosition(sec: number, format: TimeFormat, ctx: SpotContext): string {
  const safe = Number.isFinite(sec) ? sec : 0;
  switch (format) {
    case 'timecode':
      return formatTimecode(safe + ctx.timecodeOffsetSec, ctx.fps || DEFAULT_FPS, ctx.dropFrame);
    case 'barsBeats': {
      const at = barBeatAt(ctx.tempoMap, secToBeat(ctx.tempoMap, Math.max(0, safe)));
      return `${at.bar}|${at.beat}|${String(at.tick).padStart(3, '0')}`;
    }
    case 'minSec': {
      const total = Math.max(0, safe);
      const m = Math.floor(total / 60);
      const s = total - m * 60;
      return `${m}:${s.toFixed(3).padStart(6, '0')}`;
    }
    default:
      return String(Math.round(Math.max(0, safe) * ctx.sampleRate));
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/** Split on any of the separators a person might actually type. */
const parts = (text: string): string[] =>
  text.trim().split(/[|:.\s]+/).filter((p) => p.length > 0);

const allDigits = (list: readonly string[]): boolean =>
  list.every((p) => /^\d+$/.test(p));

/**
 * A typed position, in seconds — or null when it is not a position.
 *
 * Null rather than zero, always.  A mistyped timecode that silently becomes
 * the top of the reel is the worst possible answer: it is a legal position,
 * so nothing looks wrong until the cue is played.
 */
export function parsePosition(
  text: string, format: TimeFormat, ctx: SpotContext,
): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  switch (format) {
    case 'timecode': {
      const parsed = parseTimecode(trimmed, ctx.fps || DEFAULT_FPS);
      if (parsed === null) return null;
      return parsed - ctx.timecodeOffsetSec;
    }
    case 'barsBeats': {
      const list = parts(trimmed);
      if (list.length === 0 || list.length > 3 || !allDigits(list)) return null;
      const bar = Number(list[0]);
      const beat = list.length > 1 ? Number(list[1]) : 1;
      // "17|3|48" means 48 ticks, not 480 — a tick is a number, not a
      // fraction, and guessing the user meant tenths would move the note.
      const tick = list.length > 2 ? Number(list[2]) : 0;
      if (bar < 1 || beat < 1 || tick >= TICKS_PER_BEAT) return null;
      return beatToSec(ctx.tempoMap, barBeatToBeat(ctx.tempoMap, bar, beat, tick));
    }
    case 'minSec': {
      const list = trimmed.split(':').map((p) => p.trim());
      if (list.length > 3 || list.some((p) => p.length === 0)) return null;
      const numbers = list.map(Number);
      if (numbers.some((n) => !Number.isFinite(n) || n < 0)) return null;
      // 90 → a minute and a half; 1:30 → the same; 0:01:30 → also the same.
      const seconds = numbers.reduce((acc, n) => acc * 60 + n, 0);
      return Number.isFinite(seconds) ? seconds : null;
    }
    default: {
      if (!/^\d+$/.test(trimmed.replace(/[\s,]/g, ''))) return null;
      const samples = Number(trimmed.replace(/[\s,]/g, ''));
      if (!Number.isFinite(samples) || ctx.sampleRate <= 0) return null;
      return samples / ctx.sampleRate;
    }
  }
}

/** The same position in every format — what the dialog shows underneath. */
export function describeAllFormats(sec: number, ctx: SpotContext): string {
  return TIME_FORMATS.map((f) => `${formatLabel(f)} ${formatPosition(sec, f, ctx)}`).join('  ·  ');
}
