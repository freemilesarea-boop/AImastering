// Which cut piece is open in the region lab, and what chain is being built for
// it.
//
// The chain lives HERE rather than in the session, and that is deliberate: it
// is a draft.  Until you press 적용 nothing has been rendered and nothing has
// changed, so putting a half-built chain into the session would put it into
// the undo history and into the autosave as if it were an edit to the song.
// Re-opening a piece that HAS been applied loads its saved chain back into the
// draft, so "change one knob and apply again" works.

import { create } from 'zustand';
import type { ClipId, Insert, TailMode, TrackId } from '../daw/model/types.js';

export interface RegionLabTarget {
  trackId: TrackId;
  clipId: ClipId;
}

interface RegionLabStore {
  target: RegionLabTarget | null;
  /** The draft chain.  Slot order is the signal order. */
  chain: Insert[];
  tailMode: TailMode;
  /** Which slot's knobs are on screen. */
  activeSlot: number;
  /** Set while a render is in flight so the button cannot be pressed twice. */
  busy: boolean;

  openLab: (target: RegionLabTarget, chain: Insert[], tailMode: TailMode) => void;
  close: () => void;
  setChain: (chain: Insert[]) => void;
  setTailMode: (mode: TailMode) => void;
  setActiveSlot: (slot: number) => void;
  setBusy: (busy: boolean) => void;
}

export const useRegionLabStore = create<RegionLabStore>((set) => ({
  target: null,
  chain: [],
  tailMode: 'keep',
  activeSlot: 0,
  busy: false,

  openLab: (target, chain, tailMode) => set({
    target, chain, tailMode, activeSlot: chain[0]?.slot ?? 0, busy: false,
  }),
  close: () => set({ target: null, chain: [], busy: false }),
  setChain: (chain) => set({ chain }),
  setTailMode: (tailMode) => set({ tailMode }),
  setActiveSlot: (activeSlot) => set({ activeSlot }),
  setBusy: (busy) => set({ busy }),
}));
