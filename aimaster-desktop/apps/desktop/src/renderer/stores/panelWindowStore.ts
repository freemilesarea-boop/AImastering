// Panels torn off the tab strip and left floating.
//
// The tab strip shows ONE panel at a time, which is the wrong shape for most
// of the work: you set a fader while watching the arrangement, you draw notes
// while watching the mixer, you compare a reference against the spectrum.
// Every one of those is two panels at once, and a strip of tabs can only ever
// answer "which one instead of the other".
//
// `pluginWindowStore` already made exactly this argument for plugins, in its
// own words — the compressor and the EQ both in front of you while the track
// plays.  This is the same idea aimed at the panels themselves, and it is
// deliberately built to the same shape so the two behave alike: cascade on
// open, click to focus, drag by the title bar.
//
// FLOATING IS INDEPENDENT OF THE TAB.  Floating MIX does not take it away
// from the strip and does not change which panel is docked.  A floated panel
// is a second copy of the same live view — it reads the same stores and
// writes through the same actions, so there is no second source of truth to
// fall out of sync, and nothing to reconcile when it closes.

import { create } from 'zustand';
import type { DawWindow } from '../daw/model/view-window.js';

export interface PanelWindowState {
  id: DawWindow;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stacking order; the focused window has the highest. */
  z: number;
}

/**
 * Big enough to be worth tearing off.
 *
 * A mixer squeezed into a tooltip is not a mixer, and the commonest reason a
 * floating panel gets closed again immediately is that it opened too small to
 * do the job it was opened for.
 */
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MIN_HEIGHT = 220;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 420;

interface PanelWindowStore {
  windows: PanelWindowState[];
  float: (id: DawWindow) => void;
  close: (id: DawWindow) => void;
  closeAll: () => void;
  focus: (id: DawWindow) => void;
  move: (id: DawWindow, x: number, y: number) => void;
  resize: (id: DawWindow, width: number, height: number) => void;
  isFloating: (id: DawWindow) => boolean;
}

/**
 * Where a newly torn-off panel lands.
 *
 * Cascaded, for the reason the plugin windows are: two windows opened one
 * after the other and placed identically look like one window, and the second
 * one appears not to have opened at all.
 */
export function nextPanelPosition(count: number): { x: number; y: number } {
  const step = 32;
  const wrap = 6;
  const index = count % wrap;
  return { x: 140 + index * step, y: 96 + index * step };
}

/** One above everything currently open — what focusing means. */
export function topZ(windows: readonly PanelWindowState[]): number {
  return windows.reduce((max, w) => Math.max(max, w.z), 0) + 1;
}

export const usePanelWindowStore = create<PanelWindowStore>((set, get) => ({
  windows: [],

  float: (id) => {
    const open = get().windows;
    // Tearing off a panel that is already torn off FOCUSES it rather than
    // opening a second one.  Two live copies of the mixer would both be
    // correct and one of them would always be redundant.
    if (open.some((w) => w.id === id)) { get().focus(id); return; }
    const { x, y } = nextPanelPosition(open.length);
    set({
      windows: [...open, {
        id, x, y, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, z: topZ(open),
      }],
    });
  },

  close: (id) => set((s) => ({ windows: s.windows.filter((w) => w.id !== id) })),
  closeAll: () => set({ windows: [] }),

  focus: (id) => set((s) => {
    const target = s.windows.find((w) => w.id === id);
    if (!target) return s;
    // Already on top: leave the array alone rather than writing an identical
    // one, so a click on the front window does not re-render every panel.
    if (target.z === topZ(s.windows) - 1) return s;
    const z = topZ(s.windows);
    return { windows: s.windows.map((w) => (w.id === id ? { ...w, z } : w)) };
  }),

  move: (id, x, y) => set((s) => ({
    // Never off the top or the left, where the title bar would be unreachable
    // and the window could not be dragged back.
    windows: s.windows.map((w) => (w.id === id
      ? { ...w, x: Math.max(0, x), y: Math.max(0, y) }
      : w)),
  })),

  resize: (id, width, height) => set((s) => ({
    windows: s.windows.map((w) => (w.id === id
      ? {
        ...w,
        width: Math.max(PANEL_MIN_WIDTH, width),
        height: Math.max(PANEL_MIN_HEIGHT, height),
      }
      : w)),
  })),

  isFloating: (id) => get().windows.some((w) => w.id === id),
}));
