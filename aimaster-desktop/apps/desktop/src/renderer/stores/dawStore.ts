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
import { expandSelection } from '../daw/edit/edit-groups.js';
import type { ChannelSettings } from '../daw/edit/channel-ops.js';
import type { TimeFormat } from '../daw/model/spot-time.js';
import type { DawWindow } from '../daw/model/view-window.js';
import {
  linkedTimeline, recallZoom, storeZoom,
  type WindowLayout, type ZoomSlots, type ZoomView,
} from '../daw/model/workspace-view.js';
import { pushSnapshot, type MixSnapshot } from '../daw/model/mix-snapshot.js';
import type { EditClipboard } from '../daw/edit/clipboard.js';
import type { Groove } from '../daw/model/groove.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { autosaveDriver } from '../daw/engine/autosave-driver.js';
import { tempoMapOf } from '../daw/model/tempo-map.js';
import {
  cycleSnap, eventTimes, snapMove as snapMoveMode, snapTime as snapTimeMode,
  type SnapContext, type SnapMode,
} from '../daw/model/snap-modes.js';
import { clipBoundaries } from '../daw/edit/clip-edit.js';

export type EditMode = 'shuffle' | 'slip' | 'spot' | 'grid';

/**
 * What a batch rename is renaming.
 *
 * Tracks and clips go through the same dialog because the rules are the same;
 * only where the new name is written differs, and the `kind` is what says so.
 */
export interface RenameTarget {
  kind: 'track' | 'clip';
  items: { id: string; name: string; trackId?: TrackId }[];
}
// The window names live in model/view-window.ts so pure modules can name one
// without importing this store (and with it zustand and the audio runtime).
export type { DawWindow } from '../daw/model/view-window.js';

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
  /**
   * How a drag decides where to land.
   *
   * Independent of `editMode`: Shuffle/Slip/Spot/Grid say what a drag DOES to
   * its neighbours, snap says where it stops.  They used to be one setting,
   * which meant you could not have Slip's freedom with the grid's precision —
   * the combination most editing actually wants.
   */
  snapMode: SnapMode;
  setSnapMode: (m: SnapMode) => void;
  cycleSnapMode: () => void;
  nudgeSec: number;
  setNudgeSec: (s: number) => void;
  tabToTransient: boolean;
  toggleTabToTransient: () => void;

  /** Horizontal zoom, px per second. */
  pxPerSec: number;
  setPxPerSec: (v: number) => void;
  scrollSec: number;
  setScrollSec: (v: number) => void;
  /**
   * How wide the lane area is, in px.
   *
   * Measured by the Edit window and kept here because the KEYBOARD needs it:
   * "zoom to selection" is arithmetic on the window's width, and the shortcut
   * layer has no component to ask.
   */
  laneWidthPx: number;
  setLaneWidthPx: (v: number) => void;
  /** Scroll the view to keep the play head on screen while it plays. */
  followPlayhead: boolean;
  setFollowPlayhead: (v: boolean) => void;
  /** What the ruler counts in. */
  rulerFormat: TimeFormat;
  setRulerFormat: (f: TimeFormat) => void;

  /** Track whose Smart Controls are open, if any. */
  smartTrackId: TrackId | null;
  openSmartControls: (id: TrackId | null) => void;

  /**
   * The groove clipboard — one template, lifted off something and waiting.
   *
   * It sits beside the session rather than inside it because a groove is a
   * measurement of one thing being carried to another; it is not part of what
   * the project IS, and putting it in the undo stack would make lifting a feel
   * an edit.
   */
  groove: Groove | null;
  setGroove: (g: Groove | null) => void;

  /**
   * The clip the Spot dialog is open on, if any.
   *
   * In the store rather than in the Edit window because two things open it:
   * a click in Spot mode, and the keyboard.  A local `useState` would give
   * the shortcut nothing to talk to.
   */
  spotTarget: { trackId: TrackId; clipId: string } | null;
  setSpotTarget: (target: { trackId: TrackId; clipId: string } | null) => void;

  /**
   * The selection the Detect Silence dialog is looking at, or null.
   *
   * Here for the same reason as `spotTarget`: the keyboard opens it and the
   * Edit window draws it, and a local `useState` gives the shortcut nothing
   * to talk to.  The selection is CAPTURED when it opens rather than read
   * live, so the preview cannot change under the person reading it.
   */
  stripTarget: TimeSelection | null;
  setStripTarget: (target: TimeSelection | null) => void;

  /** The selection the audio-quantize dialog is looking at, or null. */
  quantizeTarget: TimeSelection | null;
  setQuantizeTarget: (target: TimeSelection | null) => void;

  /**
   * What the batch-rename dialog has open, or null.
   *
   * The ITEMS are captured when it opens, not read live: the dialog shows a
   * numbered preview, and having the list reorder underneath while somebody
   * reads line seven is how a rename goes wrong quietly.
   */
  renameTarget: RenameTarget | null;
  setRenameTarget: (target: RenameTarget | null) => void;

  /** Whether the undo-history list is on screen. */
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;

  /** Whether the file pool is on screen. */
  poolOpen: boolean;
  setPoolOpen: (open: boolean) => void;

  /** The selection the batch-fade dialog is looking at, or null. */
  fadeTarget: TimeSelection | null;
  setFadeTarget: (target: TimeSelection | null) => void;

  /**
   * Five saved views, by slot.
   *
   * Not in the session: where you were looking is a property of this machine
   * and this sitting, not of the project.  Somebody opening the session on
   * another screen should not inherit your zoom.
   */
  zoomSlots: ZoomSlots;
  storeZoomSlot: (slot: number) => void;
  recallZoomSlot: (slot: number) => boolean;

  /** Saved window layouts, same reasoning as the zoom slots. */
  layouts: WindowLayout[];
  setLayouts: (layouts: WindowLayout[]) => void;

  /**
   * Mixer snapshots for A/B.
   *
   * Beside the session rather than inside it: a snapshot is a comparison you
   * are making, not part of what the project IS, and putting them in the undo
   * stack would make taking one an edit.
   */
  snapshots: MixSnapshot[];
  addSnapshot: (snapshot: MixSnapshot) => void;
  setSnapshots: (snapshots: MixSnapshot[]) => void;

  /**
   * Whether the timeline selection follows the edit selection.
   *
   * Pro Tools makes this a toggle because the two are genuinely different
   * when spotting to picture: you keep looking at one place while editing
   * another.
   */
  linkSelection: boolean;
  setLinkSelection: (linked: boolean) => void;

  /** A copied channel's processing, waiting to be pasted onto another. */
  channelClipboard: ChannelSettings | null;
  setChannelClipboard: (settings: ChannelSettings | null) => void;

  /**
   * Write a crossfade whenever a drag leaves two clips overlapping.
   *
   * A preference rather than session data — it describes how this person
   * likes to edit, not what is in the song, so it belongs with the view
   * settings and not in the file.
   */
  autoCrossfade: boolean;
  setAutoCrossfade: (on: boolean) => void;

  /** Non-fatal engine notices (feedback loops, decode failures). */
  engineWarning: string | null;
  setEngineWarning: (w: string | null) => void;
}

const initialSession = createSession();

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
    const order: DawWindow[] = ['edit', 'mix', 'midi', 'chain', 'session', 'steps', 'warp', 'spectral', 'vocal', 'stems', 'restore', 'reference', 'intel'];
    const index = order.indexOf(s.window);
    return { window: order[(index + 1) % order.length] ?? 'edit' };
  }),

  selection: EMPTY_SELECTION,
  /**
   * Set the selection, widened to every member of any edit group it touches.
   *
   * Here rather than in each edit verb.  Thirty commands read the selection;
   * teaching all of them about groups is thirty chances to forget one, and a
   * group that works for Cut but not for Trim is worse than none.  Widening
   * where it is STORED also means the highlight covers the whole group, so
   * what will be edited is visible before anything is pressed.
   */
  setSelection: (sel) => set((state) => {
    const selection = expandSelection(state.session, {
      startSec: Math.max(0, Math.min(sel.startSec, sel.endSec)),
      endSec: Math.max(sel.startSec, sel.endSec),
      trackIds: sel.trackIds,
    });
    // The loop range follows the edit selection when the link is on.  Through
    // `linkedTimeline` rather than inline, so "nothing to do" returns null and
    // this stays a single set() with no extra keys — a write on every mouse
    // move of a drag is a re-render on every mouse move of a drag.
    const loop = linkedTimeline(
      state.linkSelection,
      { startSec: state.loopStartSec, endSec: state.loopEndSec },
      selection,
    );
    return loop
      ? { selection, loopStartSec: loop.startSec, loopEndSec: loop.endSec }
      : { selection };
  }),
  selectedTrackIds: [],
  setSelectedTracks: (ids) => set({ selectedTrackIds: ids }),
  focusedTrackId: null,
  setFocusedTrack: (id) => set({ focusedTrackId: id }),

  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard }),

  groove: null,
  setGroove: (groove) => set({ groove }),

  spotTarget: null,
  setSpotTarget: (spotTarget) => set({ spotTarget }),

  stripTarget: null,
  setStripTarget: (stripTarget) => set({ stripTarget }),

  quantizeTarget: null,
  renameTarget: null,
  setRenameTarget: (renameTarget) => set({ renameTarget }),
  historyOpen: false,
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  poolOpen: false,
  setPoolOpen: (poolOpen) => set({ poolOpen }),
  fadeTarget: null,
  setFadeTarget: (fadeTarget) => set({ fadeTarget }),

  zoomSlots: {},
  storeZoomSlot: (slot) => set((s) => ({
    zoomSlots: storeZoom(s.zoomSlots, slot, {
      pxPerSec: s.pxPerSec,
      scrollSec: s.scrollSec,
      trackHeights: Object.fromEntries(s.session.tracks.map((t) => [t.id, t.height])),
    }),
  })),
  recallZoomSlot: (slot) => {
    const state = get();
    const view: ZoomView | null = recallZoom(state.zoomSlots, slot);
    if (!view) return false;
    set({ pxPerSec: view.pxPerSec, scrollSec: view.scrollSec });
    // Track heights are restored through `apply`, because they live in the
    // session and so belong in the undo stack; the zoom does not.
    if (view.trackHeights) {
      const heights = view.trackHeights;
      state.apply((session) => ({
        ...session,
        tracks: session.tracks.map((t) => (
          heights[t.id] !== undefined && heights[t.id] !== t.height
            ? { ...t, height: heights[t.id] as number }
            : t)),
      }));
    }
    return true;
  },

  layouts: [],
  setLayouts: (layouts) => set({ layouts }),

  snapshots: [],
  addSnapshot: (snapshot) => set((s) => ({ snapshots: pushSnapshot(s.snapshots, snapshot) })),
  setSnapshots: (snapshots) => set({ snapshots }),

  linkSelection: false,
  setLinkSelection: (linkSelection) => set({ linkSelection }),
  setQuantizeTarget: (quantizeTarget) => set({ quantizeTarget }),

  channelClipboard: null,
  setChannelClipboard: (channelClipboard) => set({ channelClipboard }),

  autoCrossfade: true,
  setAutoCrossfade: (autoCrossfade) => set({ autoCrossfade }),

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
  // Grid is the default because it is the one mode that needs no explaining;
  // the other three are what you reach for once you know why.
  snapMode: 'grid',
  setSnapMode: (m) => set({ snapMode: m }),
  cycleSnapMode: () => set((s) => ({ snapMode: cycleSnap(s.snapMode) })),
  nudgeSec: 0.1,
  setNudgeSec: (s) => set({ nudgeSec: Math.max(0.001, s) }),
  tabToTransient: true,
  toggleTabToTransient: () => set((s) => ({ tabToTransient: !s.tabToTransient })),

  pxPerSec: 60,
  setPxPerSec: (v) => set({ pxPerSec: Math.max(4, Math.min(2000, v)) }),
  scrollSec: 0,
  setScrollSec: (v) => set({ scrollSec: Math.max(0, v) }),
  laneWidthPx: 900,
  setLaneWidthPx: (v) => set({ laneWidthPx: Math.max(120, v) }),
  followPlayhead: true,
  setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),
  rulerFormat: 'barsBeats',
  setRulerFormat: (rulerFormat) => set({ rulerFormat }),

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
 * The store's current snap settings, plus the times an Events snap can land on.
 *
 * The event list is built from the SELECTED tracks' clip edges plus the markers
 * and the play head — the things you can see.  Collecting every edge in a
 * fifty-track session would let a drag jump to a boundary on a track that is
 * not even on screen, which reads as the timeline having a mind of its own.
 *
 * It is only built in Events mode.  This runs on every mouse-move of a clip
 * drag, and walking a big session's clips sixty times a second to produce a
 * list the other four modes never read is a frame budget spent on nothing.
 */
export function snapContext(mode: SnapMode): SnapContext {
  const { session, gridDivision, pxPerSec, selectedTrackIds, focusedTrackId, playheadSec } =
    useDawStore.getState();
  const base = { tempoMap: tempoMapOf(session), gridDivision, pxPerSec };
  if (mode !== 'events') return base;

  const tracks = selectedTrackIds.length > 0
    ? selectedTrackIds
    : focusedTrackId ? [focusedTrackId] : session.tracks.map((t) => t.id);
  return {
    ...base,
    events: eventTimes(
      clipBoundaries(session, tracks),
      (session.markers ?? []).map((m) => m.timeSec),
      [playheadSec],
    ),
  };
}

/**
 * Snap a bare time — a ruler click, a play head drop, a new selection edge.
 *
 * Kept under its old name so the two dozen callers that already ask for it get
 * the new modes without each having to learn about them.  Grid mode rounds on
 * the BEAT axis and converts back, so a bar line stays a bar line through a
 * ritardando, which is the whole reason the tempo map exists.
 */
export function snapToGrid(sec: number): number {
  const { snapMode } = useDawStore.getState();
  return snapTimeMode(snapMode, snapContext(snapMode), sec);
}

/**
 * Snap a MOVE: the thing was at `fromSec`, the mouse says `toSec`.
 *
 * This is the call Relative Grid needs and `snapToGrid` cannot express — a
 * drag that keeps the clip's offset from the line has to know where the clip
 * started.  A drag that calls `snapToGrid` instead still works; it just cannot
 * do Relative, which is why every drag path should move to this one.
 */
export function snapMoveTo(fromSec: number, toSec: number): number {
  const { snapMode } = useDawStore.getState();
  return snapMoveMode(snapMode, snapContext(snapMode), fromSec, toSec);
}

/** The same move as a delta, for dragging several clips as one. */
export function snapMoveDelta(fromSec: number, toSec: number): number {
  return snapMoveTo(fromSec, toSec) - fromSec;
}

/** The tracks an edit command applies to: the selection, else the focus. */
export function targetTrackIds(): TrackId[] {
  const { selection, selectedTrackIds, focusedTrackId } = useDawStore.getState();
  if (selection.trackIds.length > 0) return selection.trackIds;
  if (selectedTrackIds.length > 0) return selectedTrackIds;
  return focusedTrackId ? [focusedTrackId] : [];
}
