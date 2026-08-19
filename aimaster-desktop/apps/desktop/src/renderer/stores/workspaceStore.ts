// workspaceStore — DAW workspace state for the keyboard layer.
//
// Holds everything the Cubase-style shortcuts operate on that is NOT already
// in audioStore: the active tool, snap, loop / selection ranges, waveform
// zoom, panel visibility, transport mirror state, and the mastering-options
// undo history.
//
// The <audio> element itself lives outside the store (module-level registry).
// Keeping a DOM node in zustand state would make every timeupdate a store
// write; instead the element is registered by whichever page mounts a player
// and read imperatively by the transport commands.

import { create } from 'zustand';
import type { MasteringOptions } from './audioStore.js';
import {
  initHistory, record as recordHistory, undo as undoHistory, redo as redoHistory,
  canUndo, canRedo, type History,
} from '../audio/options-history.js';

// ── Tools ─────────────────────────────────────────────────────────────────────

export type ToolId =
  | 'select' | 'range' | 'split' | 'glue' | 'erase'
  | 'zoom' | 'mute' | 'draw' | 'scrub';

export const TOOL_LABELS: Record<ToolId, string> = {
  select: '선택', range: '범위 선택', split: '자르기', glue: '붙이기',
  erase: '삭제', zoom: '줌', mute: '뮤트', draw: '연필', scrub: '스크럽',
};

/** Tools that actually do something on the transport waveform. */
export const ACTIVE_TOOLS: ToolId[] = ['select', 'range', 'split', 'erase', 'zoom', 'mute', 'scrub'];

// ── Panels ────────────────────────────────────────────────────────────────────

export type PanelId =
  | 'transport' | 'mixConsole' | 'bottomZone' | 'inspector'
  | 'rightRack' | 'mediaBay' | 'vstEditor' | 'help';

export interface TimeRange { startSec: number; endSec: number }

export const ZOOM_H_MIN = 1;
export const ZOOM_H_MAX = 64;
export const ZOOM_V_MIN = 1;
export const ZOOM_V_MAX = 8;

export interface WorkspaceState {
  // Tool / snap
  tool: ToolId;
  setTool: (t: ToolId) => void;
  snapEnabled: boolean;
  snapGridSec: number;
  toggleSnap: () => void;
  /** Section boundaries (seconds) used as snap targets when available. */
  snapMarkers: number[];
  setSnapMarkers: (m: number[]) => void;

  // Loop / selection
  loopEnabled: boolean;
  loop: TimeRange;
  setLoop: (r: TimeRange) => void;
  toggleLoop: () => void;
  setLoopEnabled: (v: boolean) => void;
  selection: TimeRange | null;
  setSelection: (r: TimeRange | null) => void;

  // Zoom
  zoomH: number;
  zoomV: number;
  zoomInH: () => void;
  zoomOutH: () => void;
  zoomInV: () => void;
  zoomOutV: () => void;
  resetZoom: () => void;

  // Transport mirror (written by the registered <audio> element)
  /** True while a page has a preview player registered. */
  hasTransport: boolean;
  /** Media URL of the registered player — used for the waveform overlay. */
  transportSrc: string | null;
  setTransportSource: (v: { hasTransport: boolean; transportSrc: string | null }) => void;
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
  muted: boolean;
  setTransportState: (s: { isPlaying?: boolean; positionSec?: number; durationSec?: number }) => void;
  setMuted: (v: boolean) => void;

  // Panels
  panels: Record<PanelId, boolean>;
  togglePanel: (id: PanelId) => void;
  setPanel: (id: PanelId, v: boolean) => void;

  // Options undo history
  history: History<MasteringOptions> | null;
  /** Set true while a history entry is being applied so the recorder skips it. */
  applyingHistory: boolean;
  recordOptions: (o: MasteringOptions) => void;
  resetOptionsHistory: (o: MasteringOptions) => void;
  undoOptions: () => MasteringOptions | null;
  /** Clear the applying flag once the undone/redone snapshot is in audioStore. */
  endApplyHistory: () => void;
  redoOptions: () => MasteringOptions | null;
  canUndoOptions: () => boolean;
  canRedoOptions: () => boolean;

  // Settings clipboard (Mod+C / Mod+V)
  clipboard: MasteringOptions | null;
  setClipboard: (o: MasteringOptions | null) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  tool: 'select',
  setTool: (t) => set({ tool: t }),

  snapEnabled: false,
  snapGridSec: 1,
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  snapMarkers: [],
  setSnapMarkers: (m) => set({ snapMarkers: [...m].sort((a, b) => a - b) }),

  loopEnabled: false,
  loop: { startSec: 0, endSec: 0 },
  setLoop: (r) => set({
    loop: {
      startSec: Math.max(0, Math.min(r.startSec, r.endSec)),
      endSec:   Math.max(r.startSec, r.endSec),
    },
  }),
  toggleLoop: () => set((s) => ({ loopEnabled: !s.loopEnabled })),
  setLoopEnabled: (v) => set({ loopEnabled: v }),
  selection: null,
  setSelection: (r) => set({
    selection: r === null ? null : {
      startSec: Math.max(0, Math.min(r.startSec, r.endSec)),
      endSec:   Math.max(r.startSec, r.endSec),
    },
  }),

  zoomH: 1,
  zoomV: 1,
  zoomInH:  () => set((s) => ({ zoomH: clamp(s.zoomH * 2, ZOOM_H_MIN, ZOOM_H_MAX) })),
  zoomOutH: () => set((s) => ({ zoomH: clamp(s.zoomH / 2, ZOOM_H_MIN, ZOOM_H_MAX) })),
  zoomInV:  () => set((s) => ({ zoomV: clamp(s.zoomV * 1.5, ZOOM_V_MIN, ZOOM_V_MAX) })),
  zoomOutV: () => set((s) => ({ zoomV: clamp(s.zoomV / 1.5, ZOOM_V_MIN, ZOOM_V_MAX) })),
  resetZoom: () => set({ zoomH: 1, zoomV: 1 }),

  hasTransport: false,
  transportSrc: null,
  setTransportSource: (v) => set({ hasTransport: v.hasTransport, transportSrc: v.transportSrc }),
  isPlaying: false,
  positionSec: 0,
  durationSec: 0,
  muted: false,
  setTransportState: (s) => set((prev) => ({
    isPlaying:   s.isPlaying   ?? prev.isPlaying,
    positionSec: s.positionSec ?? prev.positionSec,
    durationSec: s.durationSec ?? prev.durationSec,
  })),
  setMuted: (v) => set({ muted: v }),

  panels: {
    transport:  true,
    mixConsole: false,
    bottomZone: true,
    inspector:  false,
    rightRack:  true,
    mediaBay:   false,
    vstEditor:  false,
    help:       false,
  },
  togglePanel: (id) => set((s) => ({ panels: { ...s.panels, [id]: !s.panels[id] } })),
  setPanel: (id, v) => set((s) => ({ panels: { ...s.panels, [id]: v } })),

  history: null,
  applyingHistory: false,
  recordOptions: (o) => set((s) => {
    if (s.applyingHistory) return {};
    if (!s.history) return { history: initHistory(o) };
    const next = recordHistory(s.history, o);
    return next === s.history ? {} : { history: next };
  }),
  resetOptionsHistory: (o) => set({ history: initHistory(o) }),
  undoOptions: () => {
    const h = get().history;
    if (!h || !canUndo(h)) return null;
    const next = undoHistory(h);
    set({ history: next, applyingHistory: true });
    return next.present;
  },
  redoOptions: () => {
    const h = get().history;
    if (!h || !canRedo(h)) return null;
    const next = redoHistory(h);
    set({ history: next, applyingHistory: true });
    return next.present;
  },
  endApplyHistory: () => set({ applyingHistory: false }),
  canUndoOptions: () => { const h = get().history; return h ? canUndo(h) : false; },
  canRedoOptions: () => { const h = get().history; return h ? canRedo(h) : false; },

  clipboard: null,
  setClipboard: (o) => set({ clipboard: o }),
}));

// ── Snap helper ───────────────────────────────────────────────────────────────

/**
 * Snap a time to the nearest marker (section boundary) or grid line when snap
 * is on.  Markers win when one is within half a grid step.
 */
export function snapTime(sec: number): number {
  const s = useWorkspaceStore.getState();
  if (!s.snapEnabled) return sec;
  const grid = s.snapGridSec > 0 ? s.snapGridSec : 1;
  let best = Math.round(sec / grid) * grid;
  let bestDist = Math.abs(best - sec);
  for (const m of s.snapMarkers) {
    const d = Math.abs(m - sec);
    if (d < bestDist && d <= grid) { best = m; bestDist = d; }
  }
  return Math.max(0, best);
}

// ── Transport element registry ────────────────────────────────────────────────

let transportEl: HTMLAudioElement | null = null;

export function registerTransportElement(el: HTMLAudioElement | null): void {
  transportEl = el;
  const store = useWorkspaceStore.getState();
  if (!el) {
    store.setTransportSource({ hasTransport: false, transportSrc: null });
    store.setTransportState({ isPlaying: false, positionSec: 0, durationSec: 0 });
    return;
  }
  store.setTransportSource({ hasTransport: true, transportSrc: el.currentSrc || el.src || null });
}

export function getTransportElement(): HTMLAudioElement | null {
  return transportEl;
}
