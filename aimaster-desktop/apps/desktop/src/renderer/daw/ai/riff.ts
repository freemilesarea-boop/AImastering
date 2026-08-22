// Riff Machine, as an Intelligence Layer feature.
//
// The generator in ./compose.ts is pure — constraints in, notes out.  This is
// the part that makes it behave like everything else in this layer: the notes
// arrive as a `Suggestion`, so they are previewed before they land, they go
// through the same `apply()` as every other action, and one generation is one
// undo step.
//
// The harmony comes from the session's chord track, translated into the
// target part's own clock.  A riff written against the actual progression is
// the whole point; a riff that only knows the key is a scale exercise.

import { chordAt, formatChord, type ChordEvent } from '../model/chords.js';
import { findTrack, trackClips } from '../model/session-ops.js';
import { clipNotes } from '../model/patterns.js';
import {
  DEFAULT_RIFF, describeRiff, generateRiff, varyRiff, type RiffChord,
  type RiffOptions, type VariationKind,
} from './compose.js';
import type { Suggestion } from './actions.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';
import { partClock, secToBeatsAt } from '../model/note-time.js';
import { tempoMapOf } from '../model/tempo-map.js';

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
export function resetRiffIds(): void { counter = 0; }

/**
 * The session's chords, moved into a clip's own time base.
 *
 * The chord track is on the timeline; the riff is written from the part's
 * start.  Chords that begin before the part are carried in at time 0, so a
 * part that starts mid-bar still knows what it is sitting on.
 */
export function chordsForClip(session: DawSession, clip: Clip): ChordEvent[] {
  const events = session.chordTrack;
  if (events.length === 0) return [];
  const end = clip.startSec + clip.durationSec;

  const inside = events
    .filter((e) => e.timeSec >= clip.startSec && e.timeSec < end)
    .map((e) => ({ ...e, timeSec: e.timeSec - clip.startSec }));

  // Whatever was already sounding when the part began.
  const before = chordAt(events, clip.startSec);
  if (before && !inside.some((e) => Math.abs(e.timeSec) < 1e-9)) {
    inside.unshift({ ...before, timeSec: 0 });
  }
  return inside.sort((a, b) => a.timeSec - b.timeSec);
}

export interface RiffRequest {
  trackId: TrackId;
  clipId: ClipId;
  options: Partial<RiffOptions>;
  /** Keep what is already in the part. */
  add?: boolean;
}

export interface RiffResult {
  suggestion: Suggestion | null;
  /** Empty when the part could not be found. */
  reason: string;
}

/** Generate a riff for a MIDI part, as a previewable suggestion. */
export function riffSuggestion(session: DawSession, request: RiffRequest): RiffResult {
  const track = findTrack(session, request.trackId);
  const clip = track ? trackClips(track).find((c) => c.id === request.clipId) : undefined;
  if (!clip || clip.kind !== 'midi') {
    return { suggestion: null, reason: 'MIDI 파트를 먼저 여세요' };
  }

  const clock = partClock(tempoMapOf(session), clip.startSec);
  // The chord track is on the timeline in seconds; the riff is written in
  // the part's beats, so the harmony crosses over once, here.
  const chords: RiffChord[] = chordsForClip(session, clip).map((e) => ({
    beat: secToBeatsAt(clock, e.timeSec),
    chord: e.chord,
  }));
  const beatsPerBar = session.timeSignature[0];
  // The riff fills the part, not an arbitrary length — measured in beats,
  // so a part over a tempo change still comes out the right number of bars.
  const bars = Math.max(1, Math.round(
    secToBeatsAt(clock, clip.durationSec) / Math.max(1, beatsPerBar)));

  const options: Partial<RiffOptions> = {
    beatsPerBar,
    bars,
    chords,
    ...request.options,
  };
  const notes = generateRiff(options);
  if (notes.length === 0) {
    return { suggestion: null, reason: '조건이 너무 좁아 노트를 만들지 못했습니다' };
  }

  const merged = { ...DEFAULT_RIFF, ...options };
  const harmony = chords.length > 0
    ? chords.slice(0, 4).map((c) => formatChord(c.chord)).join(' → ')
      + (chords.length > 4 ? ' …' : '')
    : '코드 트랙이 비어 있어 스케일만 참고했습니다';

  return {
    suggestion: {
      id: nextId('riff'),
      title: describeRiff(options, notes.length),
      reason: `${harmony}. 강박은 코드 톤, 약박은 경과음으로 놓고,`
        + ' 도약 뒤에는 반대 방향 순차진행으로 해소합니다.',
      // A generator is a starting point, never an answer — it arrives
      // unticked so nothing is written by accident.
      confidence: 0.45,
      actions: [{
        kind: 'writeNotes',
        trackId: request.trackId,
        clipId: request.clipId,
        notes,
        ...(request.add ? { mode: 'add' as const } : {}),
      }],
    },
    reason: `${merged.bars}마디 · 노트 ${notes.length}개`,
  };
}

export interface VariationRequest {
  trackId: TrackId;
  clipId: ClipId;
  kind: VariationKind;
  options: Partial<RiffOptions>;
  seed?: number;
}

const VARIATION_LABELS: Record<VariationKind, string> = {
  transpose: '다이어토닉 이조',
  invert: '반전 — 오르내림을 뒤집습니다',
  retrograde: '역행 — 리듬은 두고 음정만 거꾸로',
  displace: '엇박 이동',
  thin: '솎아내기 — 뼈대만 남깁니다',
  densify: '조밀하게 — 긴 노트를 쪼갭니다',
};

/** Vary what is already in the part. */
export function variationSuggestion(
  session: DawSession, request: VariationRequest,
): RiffResult {
  const track = findTrack(session, request.trackId);
  const clip = track ? trackClips(track).find((c) => c.id === request.clipId) : undefined;
  if (!clip || clip.kind !== 'midi') {
    return { suggestion: null, reason: 'MIDI 파트를 먼저 여세요' };
  }
  const source = clipNotes(session, clip);
  if (source.length === 0) {
    return { suggestion: null, reason: '변형할 노트가 없습니다 — 먼저 리프를 만드세요' };
  }

  const merged = { ...DEFAULT_RIFF, ...request.options };
  const stepBeat = 1 / Math.max(1, merged.stepsPerBeat ?? 4);
  const varied = varyRiff(source, {
    kind: request.kind,
    scale: merged.scale,
    degrees: 2,
    shiftBeat: stepBeat,
    lowPitch: merged.lowPitch,
    highPitch: merged.highPitch,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
  });

  return {
    suggestion: {
      id: nextId('vary'),
      title: `${VARIATION_LABELS[request.kind]} · 노트 ${varied.length}개`,
      reason: '스케일 안에 머무는 변형입니다 — 조성을 벗어나면 변형이 아니라 다른 아이디어입니다.',
      confidence: 0.45,
      actions: [{
        kind: 'writeNotes',
        trackId: request.trackId,
        clipId: request.clipId,
        notes: varied,
      }],
    },
    reason: `${source.length} → ${varied.length} 노트`,
  };
}

export const variationLabel = (kind: VariationKind): string => VARIATION_LABELS[kind];
