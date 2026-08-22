// dawStore — the Edit/Mix workspace state.
//
// One immutable `DawSession` plus the ephemeral editing state around it
// (selection, play head, grid, tools).  Every session mutation goes through
// `apply`, which pushes the previous snapshot onto the undo stack and re-syncs
// the audio graph — so undo, the Edit window and what you hear can never
// disagree.

import { create } from 'zustand';
import {
  initHistory, record as recordHistory, undo as undoHistory, redo as redoHistory,
  canUndo, canRedo, type History,
} from '../audio/options-history.js';
import { createSession, sessionEndSec } from '../daw/model/session-ops.js';
import type { DawSession, TrackId } from '../daw/model/types.js';
import { EMPTY_SELECTION, type TimeSelection } from '../daw/edit/clip-edit.js';
import type { EditClipboard } from '../daw/edit/clipboard.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { autosaveDriver } from '../daw/engine/autosave-driver.js';
import { snapSecToBeats, tempoMapOf } from '../daw/model/tempo-map.js';

export type EditMode = 'shuffle' | 'slip' | 'spot' | 'grid';
export type DawWindow = 'edit' | 'mix' | 'midi' | 'chain' | 'session' | 'spectral' | 'reference' | 'warp' | 'restore' | 'steps' | 'vocal' | 'intel';

/** Grid values, in seconds — musical values come from the session tempo. */
export const GRID_PRESETS = [0.01, 0.1, 0.25, 0.5, 1, 2, 4] as const;

export interface DawState {
  session: DawSession;
  history: History<DawSession>;
  /** Session mutation + undo push + graph re-sync in one call. */
  apply: (fn: (s: DawSession) => DawSession) => void;
  /**
   * Mutate WITHOUT touching the undo stack — for the middle of a drag, where
   * one gesture must land as a single undo step.  Finish with `commitEdit`.
   */
  applyTransient: (fn: (s: DawSession) => DawSession) => void;
  /** Push the current session onto the undo stack (end of a drag). */
  commitEdit: () => void;
  /** Replace the whole session (open / import), resetting history. */
  loadSession: (session: DawSession) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  window: DawWindow;
  setWindow: (w: DawWindow) => void;
  toggleWindow: () => void;

  selection: TimeSelection;
  setSelection: (sel: TimeSelection) => void;

  /**
   * The timeline clipboard.
   *
   * Lives here rather than in the OS clipboard because what is copied is a
   * structure — cropped clips, their file references, one lane per source
   * track — and flattening it to text to hand to the system would lose all
   * three.  It survives switching windows and loading another session, which
   * is what makes copy-here-paste-there work.
   */
  clipboard: EditClipboard | null;
  setClipboard: (board: EditClipboard | null) => void;

  /** The click.  Off by default — a metronome nobody asked for is noise. */
  metronomeOn: boolean;
  toggleMetronome: () => void;
  selectedTrackIds: TrackId[];
  setSelectedTracks: (ids: TrackId[]) => void;
  /** Track the keyboard acts on when the selection spans none. */
  focusedTrackId: TrackId | null;
  setFocusedTrack: (id: TrackId | null) => void;

  playheadSec: number;
  setPlayhead: (sec: number) => void;
  isPlaying: boolean;
  play: () => void;
  stop: () => void;
  togglePlay: () => void;
  seek: (sec: number) => void;

  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
  setLoop: (startSec: number, endSec: number) => void;
  toggleLoop: () => void;

  editMode: EditMode;
  setEditMode: (m: EditMode) => void;
  /**
   * The snap grid, in quarter notes — 4 is a bar of 4/4, 1 a beat, 0.25 a
   * sixteenth.  Musical rather than in seconds because with a tempo map the
   * two are not the same thing: a grid fixed at 0.5 s stops being the beat the
   * moment the tempo moves.
   */
  gridDivision: number;
  setGridDivision: (beats: number) => void;
  nudgeSec: number;
  setNudgeSec: (s: number) => void;
  tabToTransient: boolean;
  toggleTabToTransient: () => void;

  /** Horizontal zoom, px per second. */
  pxPerSec: number;
  setPxPerSec: (v: number) => void;
  scrollSec: number;
  setScrollSec: (v: number) => void;

  /** Track whose Smart Controls are open, if any. */
  smartTrackId: TrackId | null;
  openSmartControls: (id: TrackId | null) => void;

  /** Non-fatal engine notices (feedback loops, decode failures). */
  engineWarning: string | null;
  setEngineWarning: (w: string | null) => void;
}

const initialSession = createSession('Untitled Session');

export const useDawStore = create<DawState>((set, get) => ({
  session: initialSession,
  history: initHistory(initialSession),

  apply: (fn) => {
    const current = get().session;
    const next = fn(current);
    if (next === current) return;
    set({ session: next, history: recordHistory(get().history, next) });
    dawRuntime.sync(next);
    // The ONE place a real edit goes through.  Watching store emissions
    // instead would count playback and scrolling as changes — see
    // engine/autosave-driver.ts.
    autosaveDriver.noteEdit(next);
  },

  applyTransient: (fn) => {
    const current = get().session;
    const next = fn(current);
    if (next === current) return;
    set({ session: next });
    dawRuntime.sync(next);
  },

  commitEdit: () => {
    const { session, history } = get();
    if (history.present === session) return;
    set({ history: recordHistory(history, session) });
  },

  loadSession: (session) => {
    set({
      session,
      history: initHistory(session),
      selection: EMPTY_SELECTION,
      selectedTrackIds: [],
      playheadSec: 0,
    });
    dawRuntime.sync(session);
  },

  undo: () => {
    const h = get().history;
    if (!canUndo(h)) return;
    const next = undoHistory(h);
    set({ history: next, session: next.present });
    dawRuntime.sync(next.present);
  },

  redo: () => {
    const h = get().history;
    if (!canRedo(h)) return;
    const next = redoHistory(h);
    set({ history: next, session: next.present });
    dawRuntime.sync(next.present);
  },

  canUndo: () => canUndo(get().history),
  canRedo: () => canRedo(get().history),

  window: 'edit',
  setWindow: (w) => set({ window: w }),
  // Cycles every view, so one key reaches all of them.
  toggleWindow: () => set((s) => {
    const order: DawWindow[] = ['edit', 'mix', 'midi', 'chain', 'session', 'steps', 'warp', 'spectral', 'vocal', 'restore', 'reference', 'intel'];
    const index = order.indexOf(s.window);
    return { window: order[(index + 1) % order.length] ?? 'edit' };
  }),

  selection: EMPTY_SELECTION,
  setSelection: (sel) => set({
    selection: {
      startSec: Math.max(0, Math.min(sel.startSec, sel.endSec)),
      endSec: Math.max(sel.startSec, sel.endSec),
      trackIds: sel.trackIds,
    },
  }),
  selectedTrackIds: [],
  setSelectedTracks: (ids) => set({ selectedTrackIds: ids }),
  focusedTrackId: null,
  setFocusedTrack: (id) => set({ focusedTrackId: id }),

  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard }),

  metronomeOn: false,
  toggleMetronome: () => {
    const on = !get().metronomeOn;
    dawRuntime.ensure(get().session.sampleRate);
    dawRuntime.setMetronome(on);
    set({ metronomeOn: on });
  },

  playheadSec: 0,
  setPlayhead: (sec) => set({ playheadSec: Math.max(0, sec) }),
  isPlaying: false,

  play: () => {
    const { session, playheadSec } = get();
    set({ isPlaying: true });
    void dawRuntime.play(session, playheadSec);
  },

  stop: () => {
    dawRuntime.stop();
    set({ isPlaying: false });
  },

  togglePlay: () => { if (get().isPlaying) get().stop(); else get().play(); },

  seek: (sec) => {
    const target = Math.max(0, sec);
    set({ playheadSec: target });
    dawRuntime.seek(get().session, target);
  },

  loopEnabled: false,
  loopStartSec: 0,
  loopEndSec: 0,
  setLoop: (startSec, endSec) => {
    const lo = Math.max(0, Math.min(startSec, endSec));
    const hi = Math.max(startSec, endSec);
    set({ loopStartSec: lo, loopEndSec: hi });
    dawRuntime.setLoop({ enabled: get().loopEnabled, startSec: lo, endSec: hi });
  },
  toggleLoop: () => {
    const enabled = !get().loopEnabled;
    const { loopStartSec, loopEndSec, selection, session } = get();
    let lo = loopStartSec;
    let hi = loopEndSec;
    if (enabled && hi <= lo) {
      // Arm the selection, or the whole session when nothing is selected.
      if (selection.endSec > selection.startSec) { lo = selection.startSec; hi = selection.endSec; }
      else { lo = 0; hi = sessionEndSec(session); }
    }
    set({ loopEnabled: enabled, loopStartSec: lo, loopEndSec: hi });
    dawRuntime.setLoop({ enabled, startSec: lo, endSec: hi });
  },

  editMode: 'slip',
  setEditMode: (m) => set({ editMode: m }),
  gridDivision: 1,
  setGridDivision: (beats) => set({ gridDivision: Math.max(1 / 32, beats) }),
  nudgeSec: 0.1,
  setNudgeSec: (s) => set({ nudgeSec: Math.max(0.001, s) }),
  tabToTransient: true,
  toggleTabToTransient: () => set((s) => ({ tabToTransient: !s.tabToTransient })),

  pxPerSec: 60,
  setPxPerSec: (v) => set({ pxPerSec: Math.max(4, Math.min(2000, v)) }),
  scrollSec: 0,
  setScrollSec: (v) => set({ scrollSec: Math.max(0, v) }),

  smartTrackId: null,
  openSmartControls: (id) => set({ smartTrackId: id }),

  engineWarning: null,
  setEngineWarning: (w) => set({ engineWarning: w }),
}));

// Runtime → store: the transport reports its own position.
dawRuntime.onPosition = (sec) => {
  useDawStore.setState({ playheadSec: sec });
};
dawRuntime.onStopped = () => {
  useDawStore.setState({ isPlaying: false });
};

/**
 * Snap a time to the grid when the session is in Grid mode.
 *
 * Rounds on the BEAT axis and converts back, so the grid follows the tempo
 * map: a bar line stays a bar line through a ritardando, which is the whole
 * reason the map exists.
 */
export function snapToGrid(sec: number): number {
  const { editMode, gridDivision, session } = useDawStore.getState();
  if (editMode !== 'grid' || gridDivision <= 0) return Math.max(0, sec);
  return snapSecToBeats(tempoMapOf(session), sec, gridDivision);
}

/** The tracks an edit command applies to: the selection, else the focus. */
export function targetTrackIds(): TrackId[] {
  const { selection, selectedTrackIds, focusedTrackId } = useDawStore.getState();
  if (selection.trackIds.length > 0) return selection.trackIds;
  if (selectedTrackIds.length > 0) return selectedTrackIds;
  return focusedTrackId ? [focusedTrackId] : [];
}
