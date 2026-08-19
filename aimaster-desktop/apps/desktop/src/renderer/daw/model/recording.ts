// Recording — the plan, the passes, and what becomes a take.
//
// Everything here is pure.  The capture itself needs a microphone and an
// AudioWorklet (daw/engine/recorder.ts); this module decides WHERE the
// transport starts, WHEN samples are kept, and how a continuous capture over a
// looping transport becomes a stack of takes.
//
// Three ideas do the work:
//
//   Pre-roll and count-in are different things.  Pre-roll rolls the TAPE early
//   so the player hears the bar before the punch; count-in plays clicks over
//   silence before the transport moves at all.  Conflating them is why so many
//   DAWs have a confusing record panel.
//
//   Punch is a window, not a mode.  Recording always has a start; punch just
//   also gives it an end, and the same plan describes both cases.
//
//   A loop pass is a take.  The capture is one continuous stream; the timeline
//   wraps.  Cutting the stream at the wrap points and giving each piece its own
//   playlist is the whole of loop recording — and comping already knows what to
//   do with playlists.

import { activePlaylist } from './session-ops.js';
import type { DawSession, Track, TrackId } from './types.js';

export type MonitorMode = 'off' | 'on';

export interface RecordSettings {
  /** MediaDevices id, or null for the system default. */
  inputDeviceId: string | null;
  /** Channels to capture. */
  channels: 1 | 2;
  monitoring: MonitorMode;
  /** Punch gives the recording an end as well as a start. */
  punchEnabled: boolean;
  punchStartSec: number;
  punchEndSec: number;
  /** Seconds of transport BEFORE the recording starts, so the player hears
   *  their way in.  Audio in the pre-roll is discarded. */
  preRollSec: number;
  /** Bars of clicks played over silence before the transport moves. */
  countInBars: number;
  /** Loop recording: each pass through the loop becomes its own take. */
  loopTakes: boolean;
}

export const DEFAULT_RECORD_SETTINGS: RecordSettings = {
  inputDeviceId: null,
  channels: 1,
  monitoring: 'on',
  punchEnabled: false,
  punchStartSec: 0,
  punchEndSec: 0,
  preRollSec: 2,
  countInBars: 0,
  loopTakes: true,
};

export interface RecordPlan {
  /** Seconds of clicks before the transport moves.  0 when there is no count-in. */
  countInSec: number;
  /** Where the transport starts rolling. */
  transportStartSec: number;
  /** First sample kept. */
  recordStartSec: number;
  /** Last sample kept, or null when the recording runs until stopped. */
  recordEndSec: number | null;
  /** Transport time between rolling and the first kept sample. */
  preRollSec: number;
  /** Set when the transport will loop while recording. */
  loop: { startSec: number; endSec: number } | null;
}

export function beatSeconds(tempoBpm: number): number {
  return 60 / Math.max(1, tempoBpm);
}

/** Clicks are counted in bars; a bar is the session's own time signature. */
export function countInSeconds(bars: number, tempoBpm: number, beatsPerBar: number): number {
  return Math.max(0, bars) * Math.max(1, beatsPerBar) * beatSeconds(tempoBpm);
}

export interface LoopRange { startSec: number; endSec: number }

/**
 * Work out the whole take before pressing record.
 *
 * `loop` is the transport's loop range when looping is armed, else null.  With
 * `loopTakes` off, a looping transport still loops but the capture is one
 * continuous take.
 */
export function planRecording(
  session: DawSession, settings: RecordSettings, playheadSec: number,
  loop: LoopRange | null = null,
): RecordPlan {
  const beatsPerBar = session.timeSignature[0];
  const countInSec = countInSeconds(settings.countInBars, session.tempoBpm, beatsPerBar);

  const punchStart = Math.min(settings.punchStartSec, settings.punchEndSec);
  const punchEnd = Math.max(settings.punchStartSec, settings.punchEndSec);
  const punched = settings.punchEnabled && punchEnd - punchStart > 1e-6;

  const recordStartSec = Math.max(0, punched ? punchStart : playheadSec);
  const recordEndSec = punched ? punchEnd : null;

  // Pre-roll cannot run past the start of the timeline; whatever is left is
  // what the player actually gets.
  const requested = Math.max(0, settings.preRollSec);
  const transportStartSec = Math.max(0, recordStartSec - requested);
  const preRollSec = recordStartSec - transportStartSec;

  return {
    countInSec,
    transportStartSec,
    recordStartSec,
    recordEndSec,
    preRollSec,
    loop: loop && loop.endSec - loop.startSec > 1e-6 ? loop : null,
  };
}

/** Length of the plan's window, or null when it is open-ended. */
export function plannedDuration(plan: RecordPlan): number | null {
  return plan.recordEndSec === null ? null : plan.recordEndSec - plan.recordStartSec;
}

export function describePlan(plan: RecordPlan): string {
  const parts: string[] = [];
  if (plan.countInSec > 0) parts.push(`카운트인 ${plan.countInSec.toFixed(2)}s`);
  if (plan.preRollSec > 0) parts.push(`프리롤 ${plan.preRollSec.toFixed(2)}s`);
  parts.push(plan.recordEndSec === null
    ? `${plan.recordStartSec.toFixed(3)}s 부터`
    : `펀치 ${plan.recordStartSec.toFixed(3)}–${plan.recordEndSec.toFixed(3)}s`);
  if (plan.loop) parts.push(`루프 ${plan.loop.startSec.toFixed(2)}–${plan.loop.endSec.toFixed(2)}s`);
  return parts.join(' · ');
}

// ── Loop passes ───────────────────────────────────────────────────────────────

export interface LoopPass {
  index: number;
  /** Offset into the captured audio, seconds. */
  captureFromSec: number;
  captureToSec: number;
  /** Where this pass belongs on the timeline. */
  timelineStartSec: number;
}

/** A pass shorter than this is a fragment of a cycle, not a take. */
export const MIN_PASS_SEC = 0.1;

/**
 * Cut one continuous capture into the passes the transport made.
 *
 * Capture time is linear; timeline time wraps at the loop end.  Pass 0 runs
 * from wherever recording started to the loop end; every pass after it is a
 * full cycle starting at the loop start.  The final pass is truncated to
 * whatever was actually captured, and dropped if it is only a sliver.
 */
export function loopPasses(
  recordStartSec: number, capturedSec: number, loop: LoopRange | null,
  minPassSec = MIN_PASS_SEC,
): LoopPass[] {
  if (capturedSec <= 0) return [];
  if (!loop || loop.endSec - loop.startSec <= 1e-6 || recordStartSec >= loop.endSec) {
    return [{ index: 0, captureFromSec: 0, captureToSec: capturedSec, timelineStartSec: recordStartSec }];
  }

  const cycle = loop.endSec - loop.startSec;
  const firstLength = loop.endSec - Math.max(recordStartSec, loop.startSec);
  const passes: LoopPass[] = [];

  let cursor = 0;
  let index = 0;
  while (cursor < capturedSec - 1e-9) {
    const length = index === 0 ? firstLength : cycle;
    const to = Math.min(capturedSec, cursor + length);
    const kept = to - cursor;
    // Keep the first pass whatever its length — it is the one the player meant
    // to play.  Later slivers are the tail of a stopped cycle.
    if (index === 0 || kept >= minPassSec) {
      passes.push({
        index,
        captureFromSec: cursor,
        captureToSec: to,
        timelineStartSec: index === 0 ? Math.max(recordStartSec, loop.startSec) : loop.startSec,
      });
    }
    cursor = to;
    index++;
  }
  return passes;
}

// ── Arming ────────────────────────────────────────────────────────────────────

export function armedTracks(session: DawSession): Track[] {
  return session.tracks.filter((t) => t.recordArm && (t.kind === 'audio' || t.kind === 'instrument'));
}

export function setRecordArm(session: DawSession, trackId: TrackId, armed: boolean): DawSession {
  return {
    ...session,
    tracks: session.tracks.map((t) => (t.id === trackId ? { ...t, recordArm: armed } : t)),
  };
}

export function clearRecordArm(session: DawSession): DawSession {
  if (!session.tracks.some((t) => t.recordArm)) return session;
  return { ...session, tracks: session.tracks.map((t) => ({ ...t, recordArm: false })) };
}

export interface RecordReadiness {
  ok: boolean;
  reason?: string;
}

/** Everything that has to be true before the button does anything. */
export function canRecord(session: DawSession, settings: RecordSettings): RecordReadiness {
  const armed = armedTracks(session);
  if (armed.length === 0) return { ok: false, reason: '녹음할 트랙을 먼저 무장(R)하세요' };
  if (armed.some((t) => t.kind === 'instrument')) {
    return { ok: false, reason: '인스트루먼트 트랙 MIDI 녹음은 아직 지원하지 않습니다' };
  }
  if (armed.some((t) => t.frozen)) return { ok: false, reason: '프리즈된 트랙에는 녹음할 수 없습니다' };
  if (settings.punchEnabled && settings.punchEndSec - settings.punchStartSec <= 1e-6) {
    return { ok: false, reason: '펀치 구간을 먼저 선택하세요' };
  }
  if (armed.length > 1) {
    return { ok: false, reason: '지금은 한 번에 한 트랙만 녹음할 수 있습니다' };
  }
  return { ok: true };
}

/** Next take name for a track, in the Pro Tools "Vox.03" style. */
export function takeName(track: Track): string {
  return `${track.name}.${String(track.playlists.length + 1).padStart(2, '0')}`;
}

/** Clip name for a recorded pass. */
export function passClipName(trackName: string, pass: LoopPass, total: number): string {
  return total > 1 ? `${trackName} take ${pass.index + 1}` : trackName;
}

/** True when the active take lane already has audio where we are about to record. */
export function wouldOverlap(track: Track, startSec: number, endSec: number): boolean {
  const clips = activePlaylist(track)?.clips ?? [];
  return clips.some((c) => c.startSec < endSec && c.startSec + c.durationSec > startSec);
}
