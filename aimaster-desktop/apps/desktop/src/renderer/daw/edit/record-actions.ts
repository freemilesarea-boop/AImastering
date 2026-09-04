// Turning a capture into takes.
//
// The tape is one continuous buffer.  This is where it becomes session data:
// the pre-roll is discarded, loop passes are cut apart, each pass gets its own
// playlist, and the audio is written once as a single file that every take
// clip points into at a different offset.
//
// One file, many clips.  Writing a file per pass would multiply the disk cost
// of a twenty-take vocal by twenty for no benefit — the clips already carry
// their own offset and length.

import {
  loopPasses, passClipName, settingsLatency,
  type LoopPass, type RecordPlan, type RecordSettings,
} from '../model/recording.js';
import { captureShortfall } from '../model/input-latency.js';
import {
  addFile, createClip, createPlaylist, findTrack, updateTrack,
} from '../model/session-ops.js';
import { analyzeBuffer } from '../engine/audio-cache.js';
import { writeTempChannels } from '../engine/offline-render.js';
import { nextId } from '../model/ids.js';
import type { AudioFileRef, Clip, DawSession, Playlist, TrackId } from '../model/types.js';

export interface CapturedTake {
  channels: Float32Array[];
  sampleRate: number;
}

/** Injectable so the selftest can run the whole commit without touching disk. */
export type AudioWriter = (
  channels: readonly Float32Array[], sampleRate: number, name: string,
) => Promise<string>;

export interface CommitResult {
  session: DawSession;
  file: AudioFileRef;
  takes: number;
  /** Playlist the transport should be left on. */
  activePlaylistId: string;
  /** Round trip actually removed from the take, seconds. */
  latencyAppliedSec: number;
  /**
   * Correction the capture had no audio for, seconds.
   *
   * Non-zero when the take ran to the very end of what was captured: shifting
   * the read window later needs that much more at the tail, and if it is not
   * there the take is short by this much rather than silently misaligned.
   */
  latencyShortSec: number;
}

/**
 * Write the capture and lay its passes onto the track.
 *
 * `captured` starts at the plan's `transportStartSec`, so the pre-roll is at
 * the front and is cut here rather than at capture time — stopping the tape
 * mid-pre-roll would lose the run-up if the player wanted it back.
 *
 * The round trip comes from the settings, and this is where it is removed.
 * A sound the player made FOR transport time T reaches the capture at
 * (T - start) + L, because they were listening to an output that was already
 * late and their answer took the input path to arrive.  So the read window
 * moves LATER into the capture by L, and everything downstream — the passes,
 * the clip positions — keeps working in kept-relative time and needs no idea
 * that any of this happened.
 *
 * Moving the read window rather than the clip is deliberate: pulling the
 * clip's `startSec` earlier would push a take recorded at the top of the song
 * before zero, where there is no timeline to put it on.
 */
export async function commitRecording(
  session: DawSession, trackId: TrackId, captured: CapturedTake,
  plan: RecordPlan, settings: RecordSettings, writer: AudioWriter = writeTempChannels,
): Promise<CommitResult> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');

  const { sampleRate } = captured;
  const totalSec = (captured.channels[0]?.length ?? 0) / sampleRate;
  if (totalSec <= 0) throw new Error('녹음된 오디오가 없습니다');

  // Drop the pre-roll, the round trip, and the tail past a punch-out.
  const latency = settingsLatency(settings);
  const keepFrom = plan.preRollSec + latency;
  // How long the take should be.  A punch says so; an open take runs from the
  // record point to the end of what was captured.
  const wantedSec = plan.recordEndSec === null
    ? Math.max(0, totalSec - plan.preRollSec)
    : plan.recordEndSec - plan.recordStartSec;
  const keepTo = Math.min(totalSec, keepFrom + wantedSec);
  const keptSec = Math.max(0, keepTo - keepFrom);
  if (keptSec <= 1e-4) throw new Error('녹음 구간이 비어 있습니다');

  // The window moved later, so it needs that much more at the tail.  When the
  // capture stopped too soon the take is SHORT by the difference — reported,
  // not hidden, because a take quietly missing its last 20 ms is worth a line.
  const latencyShortSec = captureShortfall(keepFrom, wantedSec, totalSec);

  const fromFrame = Math.round(keepFrom * sampleRate);
  const toFrame = Math.round(keepTo * sampleRate);
  const kept = captured.channels.map((ch) => ch.subarray(fromFrame, toFrame).slice());

  const path = await writer(kept, sampleRate, `${track.name}-take`);
  const file: AudioFileRef = {
    id: nextId('file'),
    path,
    name: `${track.name} take`,
    durationSec: keptSec,
    sampleRate,
    channels: kept.length,
  };
  seedCache(file.id, kept, sampleRate);

  const passes = settings.loopTakes
    ? loopPasses(plan.recordStartSec, keptSec, plan.loop)
    : loopPasses(plan.recordStartSec, keptSec, null);

  const withFile = addFile(session, file);
  const lanes: Playlist[] = [];
  passes.forEach((pass) => {
    lanes.push(createPlaylist(
      laneName(track.name, track.playlists.length + lanes.length + 1),
      [clipForPass(file.id, track.name, pass, passes.length)],
    ));
  });
  if (lanes.length === 0) throw new Error('녹음된 패스가 없습니다');

  // The LAST pass is the one the player just finished, so that is the take
  // left active — the same thing a tape op would do.
  const active = lanes[lanes.length - 1] as Playlist;

  return {
    session: updateTrack(withFile, trackId, (t) => ({
      ...t,
      playlists: [...t.playlists, ...lanes],
      activePlaylistId: active.id,
      recordArm: t.recordArm,
    })),
    file,
    takes: lanes.length,
    activePlaylistId: active.id,
    latencyAppliedSec: latency,
    latencyShortSec,
  };
}

function laneName(trackName: string, index: number): string {
  return `${trackName}.${String(index).padStart(2, '0')}`;
}

function clipForPass(fileId: string, trackName: string, pass: LoopPass, total: number): Clip {
  return createClip(fileId, passClipName(trackName, pass, total), {
    startSec: pass.timelineStartSec,
    offsetSec: pass.captureFromSec,
    durationSec: pass.captureToSec - pass.captureFromSec,
  });
}

/** Put the captured samples straight into the cache — they need no decode. */
function seedCache(fileId: string, channels: Float32Array[], sampleRate: number): void {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return;
  const ctor = (globalThis as unknown as {
    AudioBuffer?: new (o: { length: number; sampleRate: number; numberOfChannels: number }) => AudioBuffer;
  }).AudioBuffer;
  if (!ctor) return;
  try {
    const buffer = new ctor({ length, sampleRate, numberOfChannels: channels.length });
    for (let c = 0; c < channels.length; c++) {
      buffer.getChannelData(c).set(channels[c] ?? new Float32Array(length));
    }
    analyzeBuffer(fileId, buffer);
  } catch {
    // No AudioBuffer here (tests) — the file is on disk and will decode later.
  }
}
