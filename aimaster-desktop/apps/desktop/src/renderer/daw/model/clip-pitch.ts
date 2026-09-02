// Clip transpose — moving an audio clip's pitch without moving its length.
//
// The gap this fills: `daw.transposeUp` has always been MIDI-only, so an
// audio clip could be stretched to any tempo but could not be moved a single
// semitone.  For a session built out of generated audio that is the more
// common problem of the two — the take is in the right tempo and the wrong
// key, and the only fix was to go and generate it again.
//
// Pitch and length come apart because the render does two passes that undo
// each other in time: stretch by the ratio, then read back at the ratio.
// What survives is the frequency shift.  That is why this cannot be
// `playbackRate`, which moves both at once.
//
// Everything here is pure so the value can be reasoned about without an
// audio device; the rendering is in audio/pitch-clip.ts.

import type { Clip } from './types.js';

/**
 * One octave either way.
 *
 * Not a limit of the algorithm — WSOLA will happily be asked for two — but of
 * what survives it.  Past an octave the window is being asked to invent more
 * signal than it was given, and the result is recognisably a machine rather
 * than the take a semitone up.  A control that stops where the quality does
 * is more honest than one that lets you find the cliff yourself.
 */
export const MAX_CLIP_SEMITONES = 12;

/** Below this a transpose is not audible and is treated as none at all. */
export const PITCH_EPS = 1e-3;

/**
 * A clip's transpose: absent, NaN and out-of-range all read as none.
 *
 * Clamped rather than refused, because the value can arrive from a saved
 * session, an import or a drag, and none of those has anywhere to put an
 * error.
 */
export function clipPitch(clip: Clip): number {
  const raw = clip.pitchSemitones;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const held = Math.max(-MAX_CLIP_SEMITONES, Math.min(MAX_CLIP_SEMITONES, raw));
  return Math.abs(held) < PITCH_EPS ? 0 : held;
}

/** True when this clip needs the pitch renderer at all. */
export function hasPitch(clip: Clip): boolean {
  return clipPitch(clip) !== 0;
}

/** Set a clip's transpose, held inside the range that survives the render. */
export function withClipPitch(clip: Clip, semitones: number): Clip {
  const held = Number.isFinite(semitones)
    ? Math.max(-MAX_CLIP_SEMITONES, Math.min(MAX_CLIP_SEMITONES, semitones))
    : 0;
  // Zero is stored as zero, not deleted: a clip that has been transposed back
  // to unity is a different thing from one that never was, and the field
  // being present is what tells the render key they are the same audio.
  return { ...clip, pitchSemitones: Math.abs(held) < PITCH_EPS ? 0 : held };
}

/** Frequency ratio of a transpose — 12 semitones is exactly 2. */
export function semitoneRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/** `+3 반음` / `−2.5 반음` / `원음` — for the clip label and the toast. */
export function describePitch(semitones: number): string {
  if (Math.abs(semitones) < PITCH_EPS) return '원음';
  const rounded = Math.round(semitones * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return `${rounded > 0 ? '+' : '−'}${text.replace('-', '')} 반음`;
}
