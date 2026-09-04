// Control room store — the monitor path's settings, and the push to the graph.
//
// Deliberately NOT part of the session.  How loud this room is, which pair of
// speakers is plugged in and how much the alts need trimming are facts about
// a place, not about a song: carrying them in the project file would make
// opening a mix somewhere else set that studio's monitors to this one's
// level.  Every desk in the world keeps these on the desk.
//
// Which is also why nothing here is undoable.  Turning the speakers down is
// not an edit, and having it land in the undo history — between a fade and a
// comp — would push real work out of reach.

import { create } from 'zustand';
import {
  DEFAULT_CONTROL_ROOM, addCue, nudgeLevel, removeCue, setCue, setLevel,
  setSource, setTrim, toggleDim, toggleMono, toggleMute,
  type ControlRoomState, type CueSend, type MonitorSource,
} from '../daw/model/control-room.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';

interface ControlRoomStore {
  state: ControlRoomState;
  setLevelDb: (db: number) => void;
  nudge: (deltaDb: number) => void;
  dim: () => void;
  mono: () => void;
  mute: () => void;
  source: (source: MonitorSource) => void;
  trim: (source: MonitorSource, db: number) => void;
  cue: (id: string, patch: Partial<CueSend>) => void;
  addCue: () => void;
  removeCue: (id: string) => void;
  setReferenceSpl: (spl: number | null) => void;
}

export const useControlRoomStore = create<ControlRoomStore>((set, get) => {
  /**
   * One place that writes to the graph.
   *
   * Every verb goes through it, so a new control cannot be added that changes
   * the state and forgets to make a sound — which is the failure mode of a
   * monitor section that is "not working" and has no error to show for it.
   */
  const push = (next: ControlRoomState): void => {
    set({ state: next });
    dawRuntime.setControlRoom(next);
  };

  return {
    state: DEFAULT_CONTROL_ROOM,
    setLevelDb: (db) => push(setLevel(get().state, db)),
    nudge: (deltaDb) => push(nudgeLevel(get().state, deltaDb)),
    dim: () => push(toggleDim(get().state)),
    mono: () => push(toggleMono(get().state)),
    mute: () => push(toggleMute(get().state)),
    source: (source) => push(setSource(get().state, source)),
    trim: (source, db) => push(setTrim(get().state, source, db)),
    cue: (id, patch) => push(setCue(get().state, id, patch)),
    addCue: () => push(addCue(get().state)),
    removeCue: (id) => push(removeCue(get().state, id)),
    setReferenceSpl: (spl) => push({ ...get().state, referenceSpl: spl }),
  };
});
