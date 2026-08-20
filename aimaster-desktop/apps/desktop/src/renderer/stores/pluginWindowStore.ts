// Open plugin windows.
//
// Floating, several at once, and independent of which DAW view is on screen:
// the point is to have the compressor and the EQ both in front of you while
// the track plays, and to move one out of the way of the other.  A panel
// docked into a tab cannot do that, which is why every DAW that people mix on
// has floating plugin windows.
//
// A window is identified by the insert it edits, so clicking the same slot
// twice focuses the window that is already open instead of stacking a
// duplicate on top of it.

import { create } from 'zustand';
import type { TrackId } from '../daw/model/types.js';

export interface PluginWindowState {
  /** `${trackId}:${slot}` — the insert this window edits. */
  id: string;
  trackId: TrackId;
  slot: number;
  x: number;
  y: number;
  /** Stacking order; the focused window has the highest. */
  z: number;
}

interface PluginWindowStore {
  windows: PluginWindowState[];
  /** Track whose insert rack is open, or null. */
  rackTrackId: TrackId | null;

  open: (trackId: TrackId, slot: number) => void;
  close: (id: string) => void;
  closeTrack: (trackId: TrackId) => void;
  closeAll: () => void;
  focus: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  toggleRack: (trackId: TrackId | null) => void;
}

const windowId = (trackId: TrackId, slot: number): string => `${trackId}:${slot}`;

/**
 * Where a new window lands.
 *
 * Cascaded down and right from the last one so a second window never lands
 * exactly on top of the first — the commonest way to open two plugins is one
 * after the other, and two perfectly stacked windows look like one.
 */
function nextPosition(existing: readonly PluginWindowState[]): { x: number; y: number } {
  const step = 28;
  const wrap = 8;
  const index = existing.length % wrap;
  return { x: 180 + index * step, y: 120 + index * step };
}

export const usePluginWindowStore = create<PluginWindowStore>((set, get) => ({
  windows: [],
  rackTrackId: null,

  open: (trackId, slot) => {
    const id = windowId(trackId, slot);
    const existing = get().windows.find((w) => w.id === id);
    if (existing) { get().focus(id); return; }

    const { x, y } = nextPosition(get().windows);
    const z = Math.max(0, ...get().windows.map((w) => w.z)) + 1;
    set((s) => ({ windows: [...s.windows, { id, trackId, slot, x, y, z }] }));
  },

  close: (id) => set((s) => ({ windows: s.windows.filter((w) => w.id !== id) })),

  /** A deleted track must not leave its plugin windows behind. */
  closeTrack: (trackId) => set((s) => ({
    windows: s.windows.filter((w) => w.trackId !== trackId),
  })),

  closeAll: () => set({ windows: [] }),

  focus: (id) => set((s) => {
    const top = Math.max(0, ...s.windows.map((w) => w.z));
    const target = s.windows.find((w) => w.id === id);
    if (!target || target.z === top) return s;
    return { windows: s.windows.map((w) => (w.id === id ? { ...w, z: top + 1 } : w)) };
  }),

  move: (id, x, y) => set((s) => ({
    windows: s.windows.map((w) => (w.id === id ? { ...w, x, y } : w)),
  })),

  toggleRack: (trackId) => set((s) => ({
    rackTrackId: s.rackTrackId === trackId ? null : trackId,
  })),
}));
