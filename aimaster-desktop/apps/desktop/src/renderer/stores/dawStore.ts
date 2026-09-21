// dawStore — the Edit/Mix workspace state.
//
// One immutable `DawSession` plus the ephemeral editing state around it
// (selection, play head, grid, tools).  Every session mutation goes through
// `apply`, which pushes the previous snapshot onto the undo stack and re-syncs
// the audio graph — so undo, the Edit window and what you hear can never
// disagree.

import { create } from 'zustand';
import {
  initHistory, record as recordHistory, sameByReference,
  undo as undoHistory, redo as redoHistory,
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
  findLayout, linkedTimeline, recallZoom, removeLayout, saveLayout, storeZoom,
  type WindowLayout, type ZoomSlots, type ZoomView,
} from '../daw/model/workspace-view.js';
import { pushSnapshot, removeSnapshot, type MixSnapshot } from '../daw/model/mix-snapshot.js';
import {
  captureLayout, layoutDiff, type LayoutDiff, type WorkspaceShot,
} from '../daw/edit/layout-ops.js';
// Reading the workspace and the floating panels here is what lets a layout be
// the whole room rather than the DAW's half of it.  Neither store imports
// this one, so there is no cycle.
import { useWorkspaceStore, type PanelId } from './workspaceStore.js';
import { usePanelWindowStore } from './panelWindowStore.js';
import type { EditClipboard } from '../daw/edit/clipboard.js';
import type { Groove } from '../daw/model/groove.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { autosaveDriver } from '../daw/engine/autosave-driver.js';
import {
  clearAudioCache, forgetMissing, missingFileIds, missingFiles, onMissingFile,
} from '../daw/engine/audio-cache.js';
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
  /** Freeze the room under a name, replacing one already called that. */
  saveWindowLayout: (name: string) => void;
  /**
   * Walk into a saved room.  Returns what it changed, or null if there is no
   * layout by that name — a caller needs to tell "nothing to do" from
   * "nothing there", and those read the same if both return nothing.
   */
  recallWindowLayout: (name: string) => LayoutDiff | null;
  dropWindowLayout: (name: string) => void;
  /**
   * The layout last saved or recalled, for the cycle key and the menu tick.
   * Cleared when the screen is no longer that layout would be a lie the store
   * cannot tell honestly — every panel toggle would have to report here — so
   * the menu shows the live difference beside the name instead.
   */
  currentLayout: string | null;

  /** Whether the layout menu is on screen. */
  layoutsOpen: boolean;
  setLayoutsOpen: (open: boolean) => void;

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
  /** Throw one away.  The cap drops the oldest; this is the deliberate one. */
  dropSnapshot: (id: string) => void;

  /** Whether the snapshot list is on screen (the mixer's own panel). */
  snapshotsOpen: boolean;
  setSnapshotsOpen: (open: boolean) => void;

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

/**
 * The room as it is right now, read off the three stores that hold it.
 *
 * A function rather than inline, because save and the menu's live difference
 * must read the SAME thing: two readers that drift are how a preview comes to
 * describe a change that does not happen.
 */
function workspaceShot(state: DawState): WorkspaceShot {
  return {
    window: state.window,
    panels: useWorkspaceStore.getState().panels,
    view: {
      pxPerSec: state.pxPerSec,
      scrollSec: state.scrollSec,
      trackHeights: Object.fromEntries(state.session.tracks.map((t) => [t.id, t.height])),
    },
    // z is left out on purpose: stacking order is whatever the last click
    // made it, not something anybody chose to save.
    floating: usePanelWindowStore.getState().windows.map(
      ({ id, x, y, width, height }) => ({ id, x, y, width, height })),
  };
}

/**
 * Drop the record of a missing file once nothing plays it any more.
 *
 * The warning tells people to put the file back OR delete the clip, and
 * without this the second half of that sentence was a lie: the banner stayed
 * up after the clip went, naming audio the session no longer asked for.
 *
 * The test is the same one the offline render refuses on — referenced by a
 * non-muted clip — so the banner and the bounce cannot disagree about whether
 * a file still matters.
 */
function forgetUnreferencedFailures(session: DawSession): void {
  const missing = missingFileIds();
  if (missing.size === 0) return;
  const played = new Set<string>();
  for (const track of session.tracks) {
    if (track.mute) continue;
    for (const playlist of track.playlists) {
      for (const clip of playlist.clips) {
        if (clip.kind === 'audio' && !clip.muted) played.add(clip.fileId);
      }
    }
  }
  let dropped = false;
  for (const id of missing) {
    if (!played.has(id)) { forgetMissing(id); dropped = true; }
  }
  if (dropped && missingFileIds().size === 0) useDawStore.setState({ engineWarning: null });
}

const initialSession = createSession();

export const useDawStore = create<DawState>((set, get) => ({
  session: initialSession,
  history: initHistory(initialSession),

  apply: (fn) => {
    const current = get().session;
    const next = fn(current);
    if (next === current) return;
    set({ session: next, history: recordHistory(get().history, next, sameByReference) });
    forgetUnreferencedFailures(next);
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
    set({ history: recordHistory(history, session, sameByReference) });
  },

  loadSession: (session) => {
    set({
      session,
      history: initHistory(session),
      selection: EMPTY_SELECTION,
      selectedTrackIds: [],
      playheadSec: 0,
      // Another session's missing files are not this one's.  Left standing,
      // the banner would name a file the project on screen never referred to.
      engineWarning: null,
    });
    clearAudioCache();
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
  currentLayout: null,
  layoutsOpen: false,
  setLayoutsOpen: (layoutsOpen) => set({ layoutsOpen }),

  saveWindowLayout: (name) => {
    const layout = captureLayout(name, workspaceShot(get()));
    if (layout.name === '') return;
    set((s) => ({ layouts: saveLayout(s.layouts, layout), currentLayout: layout.name }));
  },

  recallWindowLayout: (name) => {
    const state = get();
    const layout = findLayout(state.layouts, name);
    if (!layout) return null;
    const diff = layoutDiff(workspaceShot(state), layout);

    useWorkspaceStore.getState().setPanels(layout.panels as Record<PanelId, boolean>);
    set({ window: layout.window, currentLayout: layout.name });

    // Floating panels are torn down and rebuilt rather than reconciled: the
    // set that should be open is known exactly, and a diff-and-patch here
    // would be three code paths where one does.
    const floats = usePanelWindowStore.getState();
    floats.closeAll();
    for (const place of layout.floating ?? []) {
      floats.float(place.id);
      floats.move(place.id, place.x, place.y);
      floats.resize(place.id, place.width, place.height);
    }

    // The zoom goes last, because restoring track heights runs through
    // `apply` and a re-render mid-way would otherwise measure the old window.
    if (layout.view) {
      set({ pxPerSec: layout.view.pxPerSec, scrollSec: layout.view.scrollSec });
      const heights = layout.view.trackHeights;
      if (heights) {
        get().apply((session) => ({
          ...session,
          tracks: session.tracks.map((t) => (
            heights[t.id] !== undefined && heights[t.id] !== t.height
              ? { ...t, height: heights[t.id] as number }
              : t)),
        }));
      }
    }
    return diff;
  },

  dropWindowLayout: (name) => set((s) => ({
    layouts: removeLayout(s.layouts, name),
    currentLayout: s.currentLayout === name ? null : s.currentLayout,
  })),

  snapshots: [],
  addSnapshot: (snapshot) => set((s) => ({ snapshots: pushSnapshot(s.snapshots, snapshot) })),
  setSnapshots: (snapshots) => set({ snapshots }),
  dropSnapshot: (id) => set((s) => ({ snapshots: removeSnapshot(s.snapshots, id) })),

  snapshotsOpen: false,
  setSnapshotsOpen: (snapshotsOpen) => set({ snapshotsOpen }),

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
 * Runtime → store: audio the session refers to and cannot be read.
 *
 * `engineWarning` has carried the words "decode failures" in its own comment
 * since it was written and nothing ever set it; this is the case it was for.
 * Named rather than counted when there are few of them: "kick.wav" is
 * something you can go and look for, "1개" is not.
 */
onMissingFile(() => {
  // Rebuilt from the whole set rather than from the one that just arrived:
  // failures trickle in one file at a time from four different places, and a
  // message that named only the newest would keep replacing itself.
  const { session } = useDawStore.getState();
  const all = missingFiles();
  if (all.length === 0) return;
  const named = all
    .map((f) => session.files.find((x) => x.id === f.id)?.name ?? f.path)
    .slice(0, 3);
  useDawStore.setState({
    engineWarning: `오디오 파일 ${all.length}개를 읽을 수 없습니다 — `
      + `${named.join(', ')}${all.length > named.length ? ' 외' : ''}`
      + ' · 해당 트랙은 무음으로 재생되고 내보내기는 멈춥니다',
  });
});

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

/** The tracks an edit command applies to: the selection, else the focus. */
export function targetTrackIds(): TrackId[] {
  const { selection, selectedTrackIds, focusedTrackId } = useDawStore.getState();
  if (selection.trackIds.length > 0) return selection.trackIds;
  if (selectedTrackIds.length > 0) return selectedTrackIds;
  return focusedTrackId ? [focusedTrackId] : [];
}
