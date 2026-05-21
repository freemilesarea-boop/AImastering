// Realtime-preview UI status derivation (REALTIME-PASSTHROUGH fix).
//
// Pure, testable mapping from the realtime graph's internal state +
// processing evidence → an honest coarse status the UI can show.  The key
// rule: NEVER report "active" (edits heard live) unless the worklet is
// actually processing audio — a spliced-but-passing-through node is
// "passthrough", and no session yet is "waiting".

import type { RealtimeMasteringGraphStatus } from './realtime-mastering-graph.js';

export type RealtimePreviewUiStatus =
  | 'off'          // flag off — hook is a no-op
  | 'unavailable'  // flag on but the environment can't run realtime
  | 'waiting'      // ready, but no audio session yet (not playing / no source)
  | 'starting'     // session present, worklet loading/attaching
  | 'passthrough'  // node spliced but process() not running yet
  | 'active'       // process running — edits are heard live
  | 'bypassed'     // node in graph but bypassed (audio passes through)
  | 'failed';      // load/attach failed → fell back to native playback

export interface RealtimeUiStatusInput {
  /** Realtime flag is on. */
  enabled: boolean;
  /** Environment can run realtime (AudioContext + AudioWorklet + WASM). */
  ready: boolean;
  /** An analyzer session exists (audio loaded + playing). */
  hasSession: boolean;
  /** Internal graph status (null until attach starts). */
  graphStatus: RealtimeMasteringGraphStatus | undefined;
  /** The worklet has actually processed audio (metrics samples > 0). */
  processing: boolean;
}

/** Derive the coarse, honest UI status.  Pure. */
export function deriveRealtimeUiStatus(i: RealtimeUiStatusInput): RealtimePreviewUiStatus {
  if (!i.enabled) return 'off';
  if (!i.ready) return 'unavailable';
  if (i.graphStatus === 'failed') return 'failed';
  if (i.graphStatus === 'bypassed') return 'bypassed';
  if (!i.hasSession) return 'waiting';
  if (i.graphStatus === 'active') return i.processing ? 'active' : 'passthrough';
  return 'starting';
}

/** Whether module edits are genuinely audible right now. */
export function isRealtimeHeardLive(status: RealtimePreviewUiStatus): boolean {
  return status === 'active';
}

/** Human-readable, honest one-liner for the status chip. */
export function realtimeStatusLabel(
  status: RealtimePreviewUiStatus,
  readinessLabel?: string,
): string {
  switch (status) {
    case 'active':
      return 'Realtime on · module edits are heard live';
    case 'passthrough':
      return 'Realtime not processing yet — changes are staged';
    case 'waiting':
      return 'Realtime waiting — start playback on a loaded track; changes are staged';
    case 'starting':
      return 'Realtime starting… — changes are staged until it is active';
    case 'bypassed':
      return 'Realtime bypassed — changes are staged';
    case 'failed':
      return 'Realtime failed — using re-render; changes are staged';
    case 'unavailable':
      return `Realtime unavailable — changes are staged${readinessLabel && readinessLabel !== 'realtime-ready' ? ` (${readinessLabel})` : ''}`;
    case 'off':
    default:
      return 'Realtime off — changes are staged. Click Update Preview or Create Revision to hear supported changes.';
  }
}
