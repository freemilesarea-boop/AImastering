// The passes currently being recorded.
//
// A gesture outlives the component that started it — you grab a fader in the
// mixer, and what finishes the pass is the transport stopping, which happens
// somewhere else entirely.  So the in-flight gestures live here, keyed by the
// lane they are writing.
//
// ── One pass is one undo step ──────────────────────────────────────────────
//
// Everything during the pass goes through `applyTransient`, which changes the
// session without touching history: creating the lane, and then the control
// following your hand, sample after sample.  `commitEdit` is called once, when
// the pass ends.  Undo after a four-bar fader ride puts back the mix you had
// before it, not the two hundred intermediate positions.
//
// ── Why this store subscribes to the transport ─────────────────────────────
//
// Latch, write and trim do not end when you let go; they end when the
// transport stops.  Something has to notice that.  This store subscribes to
// `dawStore` rather than `dawStore` calling into here, because the dependency
// has to point one way: the transport does not know automation exists, and
// making it know would put a second reason to stop inside `stop()`.

import { create } from 'zustand';
import { useDawStore } from './dawStore.js';
import { findLane, isWritingMode, laneKey, pointValueAt } from '../daw/model/automation.js';
import {
  ensureLane, isPlayable, laneRange, setStaticValue, staticValue,
} from '../daw/edit/automation-lanes.js';
import {
  beginGesture, commitGesture, demoteWriteModes, isFinished, releaseGesture,
  sampleGesture, type AutomationGesture,
} from '../daw/edit/automation-record.js';
import { setLiveAutomation } from '../daw/engine/automation-live.js';
import type {
  AutomationMode, AutomationTarget, DawSession, TrackId,
} from '../daw/model/types.js';

interface AutomationState {
  /** In-flight passes, keyed by `laneKey(trackId, target)`. */
  gestures: Record<string, AutomationGesture>;
  /** Bumped on every sample so the lane redraws while it is being written. */
  tick: number;

  /**
   * Take hold of a control.  Returns true when a pass started — the caller
   * then feeds it samples instead of editing the value directly.
   */
  grab: (trackId: TrackId, target: AutomationTarget) => boolean;
  /** The control moved.  Writes the value through and records it. */
  move: (trackId: TrackId, target: AutomationTarget, value: number) => void;
  /** Let go.  Touch commits here; the others wait for the transport. */
  release: (trackId: TrackId, target: AutomationTarget) => void;

  /** True while this lane is being written — the UI shows it differently. */
  isRecording: (trackId: TrackId, target: AutomationTarget) => boolean;
  recordingCount: () => number;
}

/** Push the live set into the module the scheduler reads. */
function publishLive(gestures: Record<string, AutomationGesture>): void {
  setLiveAutomation(Object.keys(gestures));
}

/** The mode a target is in on this track, or 'read' when it has no lane yet. */
function modeOf(
  session: DawSession, trackId: TrackId, target: AutomationTarget,
): AutomationMode {
  const track = session.tracks.find((t) => t.id === trackId);
  const lane = track ? findLane(track.automation, target) : undefined;
  return lane?.mode ?? 'read';
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  gestures: {},
  tick: 0,

  grab: (trackId, target) => {
    const daw = useDawStore.getState();
    if (!daw.isPlaying) return false;
    if (!isPlayable(target)) return false;

    const mode = modeOf(daw.session, trackId, target);
    if (!isWritingMode(mode)) return false;

    const key = laneKey(trackId, target);
    if (get().gestures[key]) return true;

    const track = daw.session.tracks.find((t) => t.id === trackId);
    if (!track) return false;
    const value = staticValue(track, target);

    // The lane is created BEFORE the hand moves anything, so its first point
    // holds the pre-pass value.  That point is what `writeRange` anchors the
    // edges of the pass against; without it a first pass on a fresh lane
    // would have nothing to return to.
    let baseValue = value;
    daw.applyTransient((session) => {
      const existing = session.tracks.find((t) => t.id === trackId);
      const lane = existing ? findLane(existing.automation, target) : undefined;
      baseValue = lane ? pointValueAt(lane.points, daw.playheadSec, value) : value;
      return ensureLane(session, trackId, target, mode).session;
    });

    const gesture = beginGesture(trackId, target, mode, daw.playheadSec, value, baseValue);
    const gestures = { ...get().gestures, [key]: gesture };
    publishLive(gestures);
    set({ gestures, tick: get().tick + 1 });
    return true;
  },

  move: (trackId, target, value) => {
    const key = laneKey(trackId, target);
    const gesture = get().gestures[key];
    const daw = useDawStore.getState();

    // Always move the control itself — recording or not, this is what you are
    // listening to.
    daw.applyTransient((session) => setStaticValue(session, trackId, target, value));
    if (!gesture) return;

    const next = sampleGesture(gesture, daw.playheadSec, value);
    set({ gestures: { ...get().gestures, [key]: next }, tick: get().tick + 1 });
  },

  release: (trackId, target) => {
    const key = laneKey(trackId, target);
    const gesture = get().gestures[key];
    if (!gesture) {
      // Not recording — the move was an ordinary edit, and it becomes one
      // undo step now that the pointer is up.
      useDawStore.getState().commitEdit();
      return;
    }

    const daw = useDawStore.getState();
    const released = releaseGesture(gesture, daw.playheadSec);
    if (!isFinished(released)) {
      // Latch, write and trim keep writing until the transport stops.
      set({ gestures: { ...get().gestures, [key]: released }, tick: get().tick + 1 });
      return;
    }

    daw.applyTransient((session) => commitGesture(session, released, released.lastSec));
    daw.commitEdit();
    const gestures = { ...get().gestures };
    delete gestures[key];
    publishLive(gestures);
    set({ gestures, tick: get().tick + 1 });
  },

  isRecording: (trackId, target) => get().gestures[laneKey(trackId, target)] !== undefined,
  recordingCount: () => Object.keys(get().gestures).length,
}));

/**
 * End every open pass.
 *
 * Called when the transport stops, and also when a pass is abandoned (loading
 * another session, closing the workspace).  Latch and write are written out to
 * `endSec`; write then steps down to touch so a forgotten selector cannot
 * erase the next pass too.
 */
export function endAutomationPass(endSec: number): void {
  const { gestures } = useAutomationStore.getState();
  const open = Object.values(gestures);
  if (open.length === 0) return;

  const daw = useDawStore.getState();
  daw.applyTransient((session) => {
    let next = session;
    for (const gesture of open) next = commitGesture(next, gesture, endSec);
    return demoteWriteModes(next, open.map((g) => g.trackId));
  });
  daw.commitEdit();

  publishLive({});
  useAutomationStore.setState({ gestures: {}, tick: useAutomationStore.getState().tick + 1 });
}

/**
 * Arm every lane sitting in write mode.
 *
 * Write does not wait to be touched — it overwrites the pass from the moment
 * the transport rolls, which is exactly why it is the mode that gets people
 * into trouble and exactly what it is for.
 */
export function armWriteLanes(atSec: number): void {
  const daw = useDawStore.getState();
  const gestures: Record<string, AutomationGesture> = { ...useAutomationStore.getState().gestures };
  let added = false;

  for (const track of daw.session.tracks) {
    for (const lane of track.automation) {
      if (lane.mode !== 'write' || !isPlayable(lane.target)) continue;
      const key = laneKey(track.id, lane.target);
      if (gestures[key]) continue;
      const value = staticValue(track, lane.target);
      gestures[key] = beginGesture(track.id, lane.target, 'write', atSec, value, value);
      added = true;
    }
  }
  if (!added) return;
  publishLive(gestures);
  useAutomationStore.setState({ gestures, tick: useAutomationStore.getState().tick + 1 });
}

// ── Transport wiring ────────────────────────────────────────────────────────
//
// Installed once, when this module is first imported.  Reading the flag on
// every store change is cheap and means the transport needs to know nothing
// about automation.

let wasPlaying = useDawStore.getState().isPlaying;
useDawStore.subscribe((state) => {
  if (state.isPlaying === wasPlaying) return;
  wasPlaying = state.isPlaying;
  if (state.isPlaying) armWriteLanes(state.playheadSec);
  else endAutomationPass(state.playheadSec);
});

/** Range of a target on a track — re-exported so the UI has one import. */
export { laneRange };
