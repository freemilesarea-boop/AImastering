// Which take is open in the vocal editor, and which notes are selected.
//
// Deliberately thin: the segments themselves live on the clip in the session,
// so every edit goes through `dawStore.apply` and is one undo step like
// everything else.  What is local to the editor is what cannot be undone
// because it was never a change — the selection, the zoom, the busy flag.

import { create } from 'zustand';
import type { ClipId, TrackId } from '../daw/model/types.js';

export interface OpenTake { trackId: TrackId; clipId: ClipId }

interface VocalEditorState {
  open: OpenTake | null;
  selected: Set<string>;
  /** Pixels per second in the blob view. */
  pxPerSec: number;
  /** Analysis or render in flight — the label is shown, not just a spinner. */
  busy: string | null;
  /**
   * Snap a drag to the semitone.  On by default because that is what a
   * correction usually is; held off with a modifier for the four-cent moves
   * that are the other half of this job.
   */
  snap: boolean;

  openTake: (take: OpenTake | null) => void;
  select: (ids: Iterable<string>) => void;
  toggle: (id: string) => void;
  clearSelection: () => void;
  setBusy: (busy: string | null) => void;
  setPxPerSec: (px: number) => void;
  setSnap: (snap: boolean) => void;
}

export const useVocalEditorStore = create<VocalEditorState>((set, get) => ({
  open: null,
  selected: new Set(),
  pxPerSec: 220,
  busy: null,
  snap: true,

  // Opening a different take drops the selection: segment ids are per-clip,
  // and a stale one would silently edit nothing.
  openTake: (open) => set({ open, selected: new Set() }),

  select: (ids) => set({ selected: new Set(ids) }),
  toggle: (id) => {
    const next = new Set(get().selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ selected: next });
  },
  clearSelection: () => set({ selected: new Set() }),
  setBusy: (busy) => set({ busy }),
  setPxPerSec: (pxPerSec) => set({ pxPerSec: Math.max(40, Math.min(1200, pxPerSec)) }),
  setSnap: (snap) => set({ snap }),
}));
