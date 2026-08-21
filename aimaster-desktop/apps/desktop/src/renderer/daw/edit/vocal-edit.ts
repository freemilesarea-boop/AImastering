// The vocal editor's model — what a blob on screen means.
//
// The analysis and the renderer already existed; what did not exist was any
// way to touch ONE note.  The shortcuts could tune a whole clip to a scale and
// tell you how many segments moved, which is the wrong granularity for the
// only job this feature has: the take is good and there are two bad notes in
// it.
//
// So everything here is per-segment and reversible.  A drag writes an
// `edit.pitchOffsetCents`; it never rewrites what was measured.  That split is
// what lets the editor draw the performance and the correction as two
// different lines, and what makes "이 노트만 원래대로" a one-liner.
//
// ── The bug this file exists to fix ───────────────────────────────────────────
//
// `renderClipPitch` re-points the clip at a newly rendered file and leaves the
// segments' edits in place.  Render once and the audio is correct.  Render
// AGAIN — which a UI makes trivial: fix one more note, press render — and
// every previous correction is applied a second time on top of audio that
// already has it.  A note pulled up 40 cents ends up 80 cents sharp.
//
// `bakeSegments` is the fix: after a render, what was an edit has become part
// of the recording, so it moves into `measured` and the edit resets.  The next
// render then starts from a clean slate, and pressing render twice with no
// changes in between does nothing the second time — which is the property the
// tests actually assert.

import {
  NEUTRAL_EDIT, curveCentsAt, targetPitchAt,
  type SegmentEdit, type VariSegment,
} from '../audio/pitch-analysis.js';
import { findTrack, trackClips, updateClip } from '../model/session-ops.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';

// ── Reading ───────────────────────────────────────────────────────────────────

/** The pitch a segment will SOUND at — measured plus the edit. */
export function editedPitch(segment: VariSegment): number {
  return segment.measured.medianPitch + segment.edit.pitchOffsetCents / 100;
}

/** How far the singer was from the nearest semitone, in cents.  Signed. */
export function tuningErrorCents(segment: VariSegment): number {
  const pitch = segment.measured.medianPitch;
  return (pitch - Math.round(pitch)) * 100;
}

export function isEdited(segment: VariSegment): boolean {
  const e = segment.edit;
  return e.pitchOffsetCents !== 0 || e.vibratoScale !== 1 || e.driftScale !== 1
    || e.curveScale !== 1 || e.formantSemitones !== 0 || e.timeOffsetSec !== 0;
}

/** Whether anything in this clip is waiting to be rendered. */
export function hasPendingEdits(clip: Clip): boolean {
  return clip.pitchSegments.some(isEdited);
}

export function findClipSegments(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): VariSegment[] {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  return clip?.pitchSegments ?? [];
}

/**
 * The pitch span to draw, with a little room above and below.
 *
 * Both the measured and the edited pitch are considered: a note dragged an
 * octave up must not vanish off the top of a view sized from the performance.
 */
export function pitchRange(
  segments: readonly VariSegment[], padSemitones = 2,
): { lowPitch: number; highPitch: number } {
  if (segments.length === 0) return { lowPitch: 55, highPitch: 79 };
  let low = Infinity;
  let high = -Infinity;
  for (const segment of segments) {
    for (const pitch of [segment.measured.medianPitch, editedPitch(segment)]) {
      low = Math.min(low, pitch);
      high = Math.max(high, pitch);
    }
  }
  // A one-note clip would otherwise draw a zero-height grid.
  if (high - low < 4) { const mid = (high + low) / 2; low = mid - 2; high = mid + 2; }
  return { lowPitch: Math.floor(low - padSemitones), highPitch: Math.ceil(high + padSemitones) };
}

/** The sung line inside one segment, as points the view can draw directly. */
export function performanceLine(
  segment: VariSegment, stepSec = 0.01,
): { timeSec: number; pitch: number }[] {
  const out: { timeSec: number; pitch: number }[] = [];
  const length = Math.max(stepSec, segment.endSec - segment.startSec);
  for (let t = 0; t <= length + 1e-9; t += stepSec) {
    out.push({
      timeSec: segment.startSec + t,
      pitch: segment.measured.medianPitch + curveCentsAt(segment.measured.curve, t) / 100,
    });
  }
  return out;
}

/** The corrected line — what the render will produce. */
export function correctedLine(
  segment: VariSegment, stepSec = 0.01,
): { timeSec: number; pitch: number }[] {
  const out: { timeSec: number; pitch: number }[] = [];
  const length = Math.max(stepSec, segment.endSec - segment.startSec);
  for (let t = 0; t <= length + 1e-9; t += stepSec) {
    out.push({
      timeSec: segment.startSec + t + segment.edit.timeOffsetSec,
      pitch: targetPitchAt(segment, t),
    });
  }
  return out;
}

// ── Editing one segment ───────────────────────────────────────────────────────

/**
 * Drag a blob to a pitch.
 *
 * `toPitch` is where the pointer is, in fractional MIDI.  Snapping to the
 * semitone is the caller's choice rather than this function's, because holding
 * a modifier to move a note four cents is a real thing singers' engineers do.
 */
export function moveToPitch(segment: VariSegment, toPitch: number): VariSegment {
  if (!Number.isFinite(toPitch)) return segment;
  return {
    ...segment,
    edit: {
      ...segment.edit,
      pitchOffsetCents: (toPitch - segment.measured.medianPitch) * 100,
    },
  };
}

export function nudgeCents(segment: VariSegment, cents: number): VariSegment {
  return {
    ...segment,
    edit: { ...segment.edit, pitchOffsetCents: segment.edit.pitchOffsetCents + cents },
  };
}

/** Back to what was sung.  The measurement is never touched, so this is exact. */
export function resetSegment(segment: VariSegment): VariSegment {
  return { ...segment, edit: { ...NEUTRAL_EDIT } };
}

export function patchSegment(segment: VariSegment, patch: Partial<SegmentEdit>): VariSegment {
  return { ...segment, edit: { ...segment.edit, ...patch } };
}

// ── Editing a selection ───────────────────────────────────────────────────────

export function mapSegments(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  ids: ReadonlySet<string>,
  fn: (segment: VariSegment) => VariSegment,
): DawSession {
  if (ids.size === 0) return session;
  return updateClip(session, trackId, clipId, (clip) => ({
    ...clip,
    pitchSegments: clip.pitchSegments.map((s) => (ids.has(s.id) ? fn(s) : s)),
  }));
}

/** Segments touching a time span — what a rubber-band selection picks up. */
export function segmentsInSpan(
  segments: readonly VariSegment[], startSec: number, endSec: number,
): VariSegment[] {
  const from = Math.min(startSec, endSec);
  const to = Math.max(startSec, endSec);
  return segments.filter((s) => s.endSec > from && s.startSec < to);
}

/** The segment under a moment, or null between phrases. */
export function segmentAt(
  segments: readonly VariSegment[], timeSec: number,
): VariSegment | null {
  return segments.find((s) => timeSec >= s.startSec && timeSec <= s.endSec) ?? null;
}

// ── Baking, after a render ────────────────────────────────────────────────────

/**
 * Fold a segment's edits into its measurement.
 *
 * Called immediately after the audio has been rendered, when the correction
 * has stopped being a pending change and become what the file contains.  Get
 * this wrong in either direction and the failure is silent:
 *
 *   not baking     → the next render applies every correction twice
 *   baking early   → the editor shows a correction the audio does not have
 *
 * The curve is rewritten rather than kept, because `vibratoScale` and
 * `curveScale` have already been printed into the audio: leaving the original
 * wobble in `measured` would make the editor draw a performance that no longer
 * exists, and scaling it again on the next render would flatten it twice.
 */
export function bakeSegment(segment: VariSegment): VariSegment {
  const { measured, edit } = segment;
  const driftAt = (t: number): number => measured.driftCentsPerSec * t;
  return {
    ...segment,
    startSec: segment.startSec + edit.timeOffsetSec,
    endSec: segment.endSec + edit.timeOffsetSec,
    measured: {
      ...measured,
      medianPitch: measured.medianPitch + edit.pitchOffsetCents / 100,
      driftCentsPerSec: measured.driftCentsPerSec * edit.driftScale,
      vibratoDepthCents: measured.vibratoDepthCents * edit.vibratoScale * edit.curveScale,
      curve: measured.curve.map((point) => {
        const drift = driftAt(point.timeSec);
        const detail = point.cents - drift;
        return {
          timeSec: point.timeSec,
          cents: drift * edit.driftScale + detail * edit.curveScale * edit.vibratoScale,
        };
      }),
    },
    // Formant is not folded in: it is a render parameter with no measured
    // counterpart, so it simply resets with the rest of the edit.
    edit: { ...NEUTRAL_EDIT },
  };
}

export function bakeSegments(segments: readonly VariSegment[]): VariSegment[] {
  return segments.map(bakeSegment);
}

// ── Describing ────────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function pitchName(pitch: number): string {
  const rounded = Math.round(pitch);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12] ?? 'C';
  return `${name}${Math.floor(rounded / 12) - 1}`;
}

/** `A3 −18¢ · 비브라토 5.2 Hz 34¢` — one segment, for the inspector. */
export function describeSegment(segment: VariSegment): string {
  const error = tuningErrorCents(segment);
  const parts = [`${pitchName(editedPitch(segment))} ${error >= 0 ? '+' : ''}${error.toFixed(0)}¢`];
  if (segment.measured.vibratoDepthCents > 8) {
    parts.push(`비브라토 ${segment.measured.vibratoRateHz.toFixed(1)} Hz`
      + ` ${segment.measured.vibratoDepthCents.toFixed(0)}¢`);
  }
  if (Math.abs(segment.measured.driftCentsPerSec) > 20) {
    parts.push(`드리프트 ${segment.measured.driftCentsPerSec.toFixed(0)}¢/s`);
  }
  if (isEdited(segment)) {
    parts.push(`이동 ${segment.edit.pitchOffsetCents >= 0 ? '+' : ''}`
      + `${segment.edit.pitchOffsetCents.toFixed(0)}¢`);
  }
  return parts.join(' · ');
}
