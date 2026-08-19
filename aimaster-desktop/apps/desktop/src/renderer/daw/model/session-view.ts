// Session View — clips in a grid, launched live, then printed to the timeline.
//
//            Scene A   Scene B   Scene C
//   Drum        ●         ●         ●
//   Bass        ●         ●
//   Piano       ●                   ●
//   Synth                 ●         ●
//   Vocal       ●
//
// Two halves, and the second one is what makes it more than a toy:
//
//   1. LAUNCHING — a slot is queued and starts on the next quantised
//      boundary, so anything you fire lands in time.  One clip per track
//      plays at a time; launching a scene fires its whole row.
//   2. CONVERT TO ARRANGEMENT — an ordered list of scenes becomes real clips
//      on the timeline.  The jam becomes an arrangement you can then edit
//      with everything else in this app.
//
// All pure: the launcher state is a value, not a class with hidden timers.

import { nextId } from './ids.js';
import type { Clip, DawSession, TrackId } from './types.js';
import { findTrack, updateTrack } from './session-ops.js';

export interface Scene {
  id: string;
  name: string;
  color: string;
  /** Optional tempo the scene switches to when launched. */
  tempoBpm: number | null;
}

export type LaunchQuantize = 0 | 0.25 | 0.5 | 1 | 2 | 4 | 8;

export interface SessionSlot {
  id: string;
  trackId: TrackId;
  sceneIndex: number;
  /** The material.  Audio clip or MIDI part — the same Clip the timeline uses. */
  clip: Clip | null;
  loop: boolean;
  /** Bars to wait for before starting; 0 launches immediately. */
  quantizeBars: LaunchQuantize;
}

export interface SessionGrid {
  scenes: Scene[];
  slots: SessionSlot[];
  /** Default launch quantisation for new slots. */
  defaultQuantizeBars: LaunchQuantize;
}

export function emptyGrid(): SessionGrid {
  return { scenes: [], slots: [], defaultQuantizeBars: 1 };
}

export function createScene(name: string, color = '#4f7fd6'): Scene {
  return { id: nextId('scene'), name, color, tempoBpm: null };
}

// ── Grid access ───────────────────────────────────────────────────────────────

export function slotAt(grid: SessionGrid, trackId: TrackId, sceneIndex: number): SessionSlot | undefined {
  return grid.slots.find((s) => s.trackId === trackId && s.sceneIndex === sceneIndex);
}

export function sceneSlots(grid: SessionGrid, sceneIndex: number): SessionSlot[] {
  return grid.slots.filter((s) => s.sceneIndex === sceneIndex && s.clip !== null);
}

export function trackSlots(grid: SessionGrid, trackId: TrackId): SessionSlot[] {
  return grid.slots.filter((s) => s.trackId === trackId);
}

export function addScene(grid: SessionGrid, name?: string): SessionGrid {
  const scene = createScene(name ?? `Scene ${grid.scenes.length + 1}`);
  return { ...grid, scenes: [...grid.scenes, scene] };
}

export function removeScene(grid: SessionGrid, sceneIndex: number): SessionGrid {
  if (sceneIndex < 0 || sceneIndex >= grid.scenes.length) return grid;
  return {
    ...grid,
    scenes: grid.scenes.filter((_, i) => i !== sceneIndex),
    slots: grid.slots
      .filter((s) => s.sceneIndex !== sceneIndex)
      .map((s) => (s.sceneIndex > sceneIndex ? { ...s, sceneIndex: s.sceneIndex - 1 } : s)),
  };
}

export function renameScene(grid: SessionGrid, sceneIndex: number, name: string): SessionGrid {
  return {
    ...grid,
    scenes: grid.scenes.map((s, i) => (i === sceneIndex ? { ...s, name } : s)),
  };
}

/** Put a clip in a cell (replacing whatever was there). */
export function setSlotClip(
  grid: SessionGrid, trackId: TrackId, sceneIndex: number, clip: Clip | null,
): SessionGrid {
  const existing = slotAt(grid, trackId, sceneIndex);
  if (existing) {
    return {
      ...grid,
      slots: grid.slots.map((s) => (s.id === existing.id ? { ...s, clip } : s)),
    };
  }
  if (!clip) return grid;
  const slot: SessionSlot = {
    id: nextId('slot'),
    trackId,
    sceneIndex,
    clip,
    loop: true,
    quantizeBars: grid.defaultQuantizeBars,
  };
  return { ...grid, slots: [...grid.slots, slot] };
}

export function clearSlot(grid: SessionGrid, trackId: TrackId, sceneIndex: number): SessionGrid {
  return { ...grid, slots: grid.slots.filter((s) => !(s.trackId === trackId && s.sceneIndex === sceneIndex)) };
}

export function updateSlot(
  grid: SessionGrid, slotId: string, fn: (s: SessionSlot) => SessionSlot,
): SessionGrid {
  return { ...grid, slots: grid.slots.map((s) => (s.id === slotId ? fn(s) : s)) };
}

// ── Launching ─────────────────────────────────────────────────────────────────

export interface QueuedLaunch {
  trackId: TrackId;
  /** null means "stop this track at the boundary". */
  slotId: string | null;
  /** Musical position (in bars) the launch takes effect. */
  atBar: number;
}

export interface LaunchState {
  /** trackId → slotId currently sounding. */
  playing: Record<TrackId, string>;
  queued: QueuedLaunch[];
  /** Scene whose row was fired last — for the UI highlight. */
  lastScene: number | null;
}

export const EMPTY_LAUNCH: LaunchState = { playing: {}, queued: [], lastScene: null };

/**
 * The next boundary at or after `currentBar` for a quantisation.
 * Quantise 0 means "right now".
 */
export function nextBoundary(currentBar: number, quantizeBars: LaunchQuantize): number {
  if (quantizeBars <= 0) return currentBar;
  const next = Math.ceil(currentBar / quantizeBars) * quantizeBars;
  // Already exactly on a boundary → fire on this one, not the following.
  return Math.abs(next - currentBar) < 1e-9 ? currentBar : next;
}

/** Queue one slot.  A second launch on the same track replaces the first. */
export function queueSlot(
  state: LaunchState, grid: SessionGrid, slotId: string, currentBar: number,
): LaunchState {
  const slot = grid.slots.find((s) => s.id === slotId);
  if (!slot || !slot.clip) return state;
  const atBar = nextBoundary(currentBar, slot.quantizeBars);
  return {
    ...state,
    queued: [...state.queued.filter((q) => q.trackId !== slot.trackId),
      { trackId: slot.trackId, slotId: slot.id, atBar }],
  };
}

/** Queue a stop for one track. */
export function queueStop(
  state: LaunchState, trackId: TrackId, currentBar: number,
  quantizeBars: LaunchQuantize = 1,
): LaunchState {
  return {
    ...state,
    queued: [...state.queued.filter((q) => q.trackId !== trackId),
      { trackId, slotId: null, atBar: nextBoundary(currentBar, quantizeBars) }],
  };
}

/** Fire a whole row.  Tracks with an empty slot in that scene keep playing. */
export function queueScene(
  state: LaunchState, grid: SessionGrid, sceneIndex: number, currentBar: number,
): LaunchState {
  let next: LaunchState = { ...state, lastScene: sceneIndex };
  for (const slot of sceneSlots(grid, sceneIndex)) {
    next = queueSlot(next, grid, slot.id, currentBar);
  }
  return next;
}

export function stopAll(state: LaunchState, currentBar: number, quantizeBars: LaunchQuantize = 1): LaunchState {
  const trackIds = Object.keys(state.playing);
  let next = state;
  for (const trackId of trackIds) next = queueStop(next, trackId, currentBar, quantizeBars);
  return next;
}

export interface AdvanceResult {
  state: LaunchState;
  /** Slots that just started, for the engine to schedule. */
  started: SessionSlot[];
  /** Tracks that just stopped. */
  stopped: TrackId[];
}

/**
 * Move the transport to `bar` and apply everything whose boundary has passed.
 * The engine calls this every block; the UI reads the result.
 */
export function advance(state: LaunchState, grid: SessionGrid, bar: number): AdvanceResult {
  const due = state.queued.filter((q) => q.atBar <= bar + 1e-9);
  if (due.length === 0) return { state, started: [], stopped: [] };

  const playing = { ...state.playing };
  const started: SessionSlot[] = [];
  const stopped: TrackId[] = [];

  for (const launch of due) {
    if (launch.slotId === null) {
      if (playing[launch.trackId]) stopped.push(launch.trackId);
      delete playing[launch.trackId];
      continue;
    }
    const slot = grid.slots.find((s) => s.id === launch.slotId);
    if (!slot?.clip) continue;
    playing[launch.trackId] = slot.id;
    started.push(slot);
  }

  return {
    state: { ...state, playing, queued: state.queued.filter((q) => q.atBar > bar + 1e-9) },
    started,
    stopped,
  };
}

export function isPlaying(state: LaunchState, slot: SessionSlot): boolean {
  return state.playing[slot.trackId] === slot.id;
}

export function isQueued(state: LaunchState, slot: SessionSlot): boolean {
  return state.queued.some((q) => q.slotId === slot.id);
}

// ── Convert to Arrangement ────────────────────────────────────────────────────

export interface ArrangeStep {
  sceneIndex: number;
  /** How many bars this scene occupies in the arrangement. */
  bars: number;
}

export interface ArrangeOptions {
  /** Where the arrangement starts, in seconds. */
  startSec?: number;
  /** Repeat each clip to fill its scene's length. */
  fill?: boolean;
  /** Replace the timeline instead of appending after it. */
  replace?: boolean;
}

export function barSeconds(session: DawSession): number {
  return (60 / Math.max(1, session.tempoBpm)) * Math.max(1, session.timeSignature[0]);
}

/**
 * Print a scene order onto the timeline.
 *
 * Each step places every clip in that scene at the step's position on its own
 * track; `fill` repeats a short clip until the step is covered, which is what
 * a one-bar loop in an eight-bar section has to do.
 */
export function convertToArrangement(
  session: DawSession, grid: SessionGrid, plan: readonly ArrangeStep[],
  options: ArrangeOptions = {},
): DawSession {
  const { startSec = 0, fill = true, replace = false } = options;
  const barSec = barSeconds(session);
  let next = session;

  if (replace) {
    next = {
      ...next,
      tracks: next.tracks.map((track) => ({
        ...track,
        playlists: track.playlists.map((p) => (p.id === track.activePlaylistId ? { ...p, clips: [] } : p)),
      })),
    };
  }

  let cursorSec = startSec;
  for (const step of plan) {
    const stepSec = Math.max(0, step.bars) * barSec;
    for (const slot of sceneSlots(grid, step.sceneIndex)) {
      const source = slot.clip;
      if (!source) continue;
      const track = findTrack(next, slot.trackId);
      if (!track) continue;

      const length = Math.max(0.01, source.durationSec);
      const repeats = fill && slot.loop ? Math.max(1, Math.ceil(stepSec / length)) : 1;
      const placed: Clip[] = [];
      for (let i = 0; i < repeats; i++) {
        const start = cursorSec + i * length;
        if (start >= cursorSec + stepSec - 1e-6) break;
        // The last repeat is trimmed so a loop never spills into the next section.
        const duration = Math.min(length, cursorSec + stepSec - start);
        placed.push({
          ...source,
          id: nextId('clip'),
          startSec: start,
          durationSec: duration,
        });
      }

      next = updateTrack(next, slot.trackId, (t) => ({
        ...t,
        playlists: t.playlists.map((p) => (p.id === t.activePlaylistId
          ? { ...p, clips: [...p.clips, ...placed].sort((a, b) => a.startSec - b.startSec) }
          : p)),
      }));
    }
    cursorSec += stepSec;
  }

  return next;
}

/** A plan that plays every scene once, sized to its longest clip. */
export function defaultPlan(session: DawSession, grid: SessionGrid): ArrangeStep[] {
  const barSec = barSeconds(session);
  return grid.scenes.map((_, index) => {
    const longest = sceneSlots(grid, index)
      .reduce((max, s) => Math.max(max, s.clip?.durationSec ?? 0), 0);
    return { sceneIndex: index, bars: Math.max(1, Math.ceil(longest / barSec)) };
  });
}

/** "Scene A ×4 → Scene B ×8 → …" for the convert dialog. */
export function describePlan(grid: SessionGrid, plan: readonly ArrangeStep[]): string {
  return plan
    .map((step) => `${grid.scenes[step.sceneIndex]?.name ?? '?'} ×${step.bars}`)
    .join(' → ');
}
