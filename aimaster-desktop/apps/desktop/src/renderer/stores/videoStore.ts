// The picture viewer's own state.
//
// The VIDEO REF lives in the session — it is part of the project and is saved
// with it.  What lives here is everything that is about looking at the picture
// rather than about the project: whether the window is up, how big, which
// timecode standard to display, and the follower that drives the element.
//
// The follower is a singleton because there is one picture and one transport.
// A second follower would be a second thing writing `currentTime`, and the two
// would fight in a way that looks exactly like a broken codec.

import { create } from 'zustand';
import { VideoFollower } from '../daw/engine/video-sync.js';

export const videoFollower = new VideoFollower();

interface VideoState {
  /** Whether the floating viewer is on screen. */
  open: boolean;
  /** Viewer width in px; height follows the picture's aspect. */
  width: number;
  /** Show drop-frame timecode.  Only meaningful at 29.97 and 59.94. */
  dropFrame: boolean;
  /** Show the sync read-out — off by default; it is a diagnostic, not a meter. */
  showDrift: boolean;
  probing: string | null;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
  setDropFrame: (on: boolean) => void;
  setShowDrift: (on: boolean) => void;
  setProbing: (label: string | null) => void;
}

export const useVideoStore = create<VideoState>((set, get) => ({
  open: false,
  width: 420,
  dropFrame: false,
  showDrift: false,
  probing: null,

  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
  setWidth: (width) => set({ width: Math.max(220, Math.min(1200, width)) }),
  setDropFrame: (dropFrame) => set({ dropFrame }),
  setShowDrift: (showDrift) => set({ showDrift }),
  setProbing: (probing) => set({ probing }),
}));
