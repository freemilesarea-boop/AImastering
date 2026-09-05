// Where do dropped files go?
//
// The answer used to be "the mastering queue, always" — dropping anything
// anywhere took you back to the home screen.  In the DAW that is exactly
// wrong: you are three clicks into a session, you drag a stem in, and the app
// throws you out to a file list.  The window you are looking at decides what a
// drop means.
//
// Pure, so the routing rule is tested without a DataTransfer or a store.

import { AUDIO_IMPORT_EXTENSIONS, MIDI_IMPORT_EXTENSIONS } from '@aimaster/shared-types';

/**
 * Extensions the mastering queue and the DAW both accept as audio.
 *
 * From the SHARED list, because the Open dialog in the main process builds
 * its filter from the same one.  These two used to be written out separately
 * and drifted: a file you could drop was greyed out in the dialog.
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(
  AUDIO_IMPORT_EXTENSIONS.map((e) => `.${e}`));

/** Extensions the DAW imports as MIDI parts.  The queue has no use for them. */
export const MIDI_EXTENSIONS: ReadonlySet<string> = new Set(
  MIDI_IMPORT_EXTENSIONS.map((e) => `.${e}`));

export type DropDestination = 'daw' | 'queue';

export interface DropPlan {
  /** 'daw' keeps you where you are; 'queue' is the mastering list on home. */
  destination: DropDestination;
  audio: string[];
  /** Always empty for the queue — mastering has nothing to do with MIDI. */
  midi: string[];
  /** Recognised by neither, kept so the user can be told what was skipped. */
  ignored: string[];
}

function extensionOf(p: string): string {
  const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Sort dropped paths by what the current page can do with them.
 *
 * In the DAW every audio file becomes a track and every .mid becomes parts —
 * no cap, because the session is the workspace and the user asked for these.
 * On any other page the drop feeds the mastering queue, which has a hard limit
 * and no notion of MIDI.
 */
export function planDrop(
  paths: readonly string[], page: string, queueSlots: number,
): DropPlan {
  const inDaw = page === 'daw';
  const audio: string[] = [];
  const midi: string[] = [];
  const ignored: string[] = [];

  for (const path of paths) {
    if (!path) continue;
    const ext = extensionOf(path);
    if (AUDIO_EXTENSIONS.has(ext)) audio.push(path);
    else if (inDaw && MIDI_EXTENSIONS.has(ext)) midi.push(path);
    else ignored.push(path);
  }

  return {
    destination: inDaw ? 'daw' : 'queue',
    audio: inDaw ? audio : audio.slice(0, Math.max(0, queueSlots)),
    midi,
    ignored: inDaw
      ? ignored
      // Files past the queue's limit were not skipped for being the wrong
      // kind — say so by listing them too.
      : [...ignored, ...audio.slice(Math.max(0, queueSlots))],
  };
}

/** True when there is nothing for the app to do with this drop. */
export function isEmptyPlan(plan: DropPlan): boolean {
  return plan.audio.length === 0 && plan.midi.length === 0;
}
