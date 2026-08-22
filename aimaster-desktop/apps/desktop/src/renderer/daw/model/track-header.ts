// The three things about a track that everyone changes and nobody could.
//
// Name, colour and height were all in the model already — `Track.name` is
// drawn on every header, `Track.color` colours every clip, `Track.height`
// decides how tall the lane is — and not one of them could be edited.  The
// track you recorded eleventh was called "Audio 11" forever, in the same grey
// as the other ten, at the same height whether it was the lead vocal or a
// tambourine overdub.
//
// All three are pure edits, so they are here rather than in a component: the
// header draws them, the shortcut layer sets them, and a future track template
// will read them from the same place.

import { updateTrack } from './session-ops.js';
import type { DawSession, Track, TrackId } from './types.js';

// ── Name ──────────────────────────────────────────────────────────────────────

/** Longer than this stops being a name and starts being a sentence. */
export const MAX_TRACK_NAME = 32;

export function cleanTrackName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_TRACK_NAME);
}

/**
 * Rename a track.
 *
 * An empty name is refused: a nameless track is a blank header, and the mixer,
 * the routing menus and the intelligence layer's role guesser all read the
 * name.  Refusing is much kinder than accepting and quietly breaking three
 * things that are nowhere near the box you typed in.
 */
export function renameTrack(session: DawSession, trackId: TrackId, name: string): DawSession {
  const clean = cleanTrackName(name);
  if (clean.length === 0) return session;
  return updateTrack(session, trackId, (t) => ({ ...t, name: clean }));
}

/**
 * A name not already used, `Vox`, `Vox 2`, `Vox 3`.
 *
 * Duplicate track names are legal and sometimes wanted, so this is offered
 * rather than enforced — it is what the "duplicate track" path should call,
 * not a rule imposed on typing.
 */
export function uniqueTrackName(base: string, tracks: readonly Track[]): string {
  const clean = cleanTrackName(base) || '트랙';
  const taken = new Set(tracks.map((t) => t.name));
  if (!taken.has(clean)) return clean;
  // A trailing number is a COUNTER, not part of the name: the track after
  // "Audio 1" is "Audio 2", not "Audio 1 2".
  const stem = cleanTrackName(clean.replace(/\s+\d+$/, '')) || clean;
  for (let n = 2; n < 999; n++) {
    const candidate = cleanTrackName(`${stem} ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  return clean;
}

// ── Colour ────────────────────────────────────────────────────────────────────

/**
 * The palette.
 *
 * Twelve, spaced around the wheel, all at a similar lightness and saturation
 * so no track shouts louder than another just by being coloured.  A free
 * colour picker was the alternative and it is worse: it produces sessions
 * where two tracks are almost the same blue, and it makes the header a
 * colour-picking exercise instead of one click.
 *
 * They are read at the same lightness as the app's own surfaces, so a clip
 * fill at 20 % alpha stays legible on the dark ground.
 */
export const TRACK_COLORS: readonly { id: string; hex: string; label: string }[] = [
  { id: 'slate',   hex: '#6E7A8A', label: '슬레이트' },
  { id: 'blue',    hex: '#5B7C99', label: '블루' },
  { id: 'teal',    hex: '#4F8A8A', label: '틸' },
  { id: 'green',   hex: '#4F8A6B', label: '그린' },
  { id: 'olive',   hex: '#7A8A4F', label: '올리브' },
  { id: 'brass',   hex: '#C6A768', label: '브라스' },
  { id: 'amber',   hex: '#B8874F', label: '앰버' },
  { id: 'rust',    hex: '#A8746B', label: '러스트' },
  { id: 'red',     hex: '#B85C5C', label: '레드' },
  { id: 'plum',    hex: '#8A6BA8', label: '플럼' },
  { id: 'indigo',  hex: '#6B6BA8', label: '인디고' },
  { id: 'grey',    hex: '#7A7A7A', label: '그레이' },
];

export function setTrackColor(session: DawSession, trackId: TrackId, hex: string): DawSession {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return session;
  return updateTrack(session, trackId, (t) => ({ ...t, color: hex }));
}

/**
 * A colour for a new track, chosen so neighbours differ.
 *
 * Walks the palette by how many tracks there are rather than at random: two
 * tracks added in a row should never come out the same colour, and random
 * choice does that about one time in twelve.
 */
export function nextTrackColor(tracks: readonly Track[]): string {
  const index = tracks.length % TRACK_COLORS.length;
  return TRACK_COLORS[index]?.hex ?? '#7A7A7A';
}

/** Give every track in a group the same colour — what a stack usually wants. */
export function colorTracks(
  session: DawSession, trackIds: readonly TrackId[], hex: string,
): DawSession {
  let out = session;
  for (const id of trackIds) out = setTrackColor(out, id, hex);
  return out;
}

// ── Height ────────────────────────────────────────────────────────────────────

/** Below this the waveform is a line and the buttons do not fit. */
export const MIN_TRACK_HEIGHT = 28;
/** Above this one track fills the window and the arrangement is gone. */
export const MAX_TRACK_HEIGHT = 400;
export const DEFAULT_TRACK_HEIGHT = 72;

/**
 * The named sizes, for the keyboard and the context menu.
 *
 * Fixed steps as well as a free drag, because "make this one big enough to
 * edit" is a repeated action and hunting for the same pixel height by hand
 * every time is not editing.
 */
export const TRACK_HEIGHT_PRESETS: readonly { id: string; px: number; label: string }[] = [
  { id: 'mini',   px: 28,  label: '아주 작게' },
  { id: 'small',  px: 48,  label: '작게' },
  { id: 'medium', px: 72,  label: '보통' },
  { id: 'large',  px: 120, label: '크게' },
  { id: 'jumbo',  px: 200, label: '아주 크게' },
];

export function clampTrackHeight(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_TRACK_HEIGHT;
  return Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(px)));
}

export function setTrackHeight(session: DawSession, trackId: TrackId, px: number): DawSession {
  return updateTrack(session, trackId, (t) => ({ ...t, height: clampTrackHeight(px) }));
}

export function setHeights(
  session: DawSession, trackIds: readonly TrackId[], px: number,
): DawSession {
  let out = session;
  for (const id of trackIds) out = setTrackHeight(out, id, px);
  return out;
}

/**
 * Step to the next or previous preset from wherever a track is now.
 *
 * "Next size up" is the gesture; the current height may be a dragged number
 * that matches no preset, so the nearest one decides where the step starts.
 */
export function stepTrackHeight(current: number, direction: 1 | -1): number {
  const sizes = TRACK_HEIGHT_PRESETS.map((p) => p.px);
  let nearest = 0;
  let best = Infinity;
  sizes.forEach((px, i) => {
    const gap = Math.abs(px - current);
    if (gap < best) { best = gap; nearest = i; }
  });
  const next = Math.max(0, Math.min(sizes.length - 1, nearest + direction));
  return sizes[next] ?? DEFAULT_TRACK_HEIGHT;
}

/** `보통 (72px)` — for the menu. */
export function describeHeight(px: number): string {
  const preset = TRACK_HEIGHT_PRESETS.find((p) => p.px === px);
  return preset ? `${preset.label} (${px}px)` : `${px}px`;
}
