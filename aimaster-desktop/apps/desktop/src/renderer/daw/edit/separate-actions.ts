// Stem separation, as a session edit.
//
// The DSP is pure and lives in `daw/audio/separate/`; this is the layer that
// reads a clip's decoded audio, runs the separator on a worker thread, writes
// each stem as its own source file and puts them into the arrangement.
//
// Three decisions that are not obvious:
//
//   THE SOURCE IS NOT TOUCHED, AND NOT DELETED.  The separation is an opinion
//   about the recording, not a replacement for it.  The original track stays
//   exactly where it was and is MUTED, so what you hear afterwards is the four
//   stems — which, because the masks sum to one, is the same record.  Unmute
//   it and you have both, at double level; that is why the mute happens.
//
//   THE STEMS GO IN A STACK.  Four new tracks appearing loose in a twenty-track
//   session is a mess, and a summing stack gives them one fader, one mute and
//   one place to be collapsed out of the way.  It also means the stems are
//   routed together, so an effect on the stack is an effect on the whole
//   separated mix.
//
//   THE FULL FILE IS SEPARATED, NOT THE CLIP'S SLICE.  The repetition cue needs
//   to see the arrangement to know what repeats in it; handing it four bars
//   would leave it with nothing to compare against.  The stems are therefore
//   the length of the source file, and the new clips are trimmed and placed to
//   match the clip that was separated.

import { runSeparation, type ProgressListener } from '../audio/separate/run.js';
import {
  STEM_KINDS, stemLabel,
  type SeparationOptions, type SeparationReport, type StemKind,
} from '../audio/separate/separate.js';
import { analyzeBuffer, decodeContext, getCached, loadAudio } from '../engine/audio-cache.js';
import { writeTempChannels } from '../engine/offline-render.js';
import { createStack } from '../model/stacks.js';
import {
  addFile, addTrack, createClip, createTrack, findTrack, trackClips, updateClips,
  updateTrack,
} from '../model/session-ops.js';
import { nextId } from '../model/ids.js';
import { clipAudio } from './spectral-repair.js';
import type { AudioFileRef, Clip, ClipId, DawSession, TrackId } from '../model/types.js';

export interface SeparateResult {
  session: DawSession;
  report: SeparationReport;
  /** The stack the stems went into. */
  folderId: TrackId;
  trackIds: Record<string, TrackId>;
  message: string;
}

export interface SeparateOptions {
  /** Which stems to make.  Fewer is faster — the masks are cheap, the synthesis is not. */
  wanted?: readonly StemKind[];
  separation?: Partial<SeparationOptions>;
  onProgress?: ProgressListener;
  /** Set false to leave the source track playing.  It will then double the stems. */
  muteSource?: boolean;
}

/** What the panel needs to know before it offers the button. */
export function canSeparate(
  session: DawSession, trackId: TrackId | null, clipId: ClipId | null,
): { ok: true; clip: Clip } | { ok: false; reason: string } {
  if (!trackId || !clipId) return { ok: false, reason: '분리할 오디오 클립을 고르세요' };
  const track = findTrack(session, trackId);
  if (!track) return { ok: false, reason: '트랙을 찾을 수 없습니다' };
  const clip = trackClips(track).find((c) => c.id === clipId);
  if (!clip) return { ok: false, reason: '클립을 찾을 수 없습니다' };
  if (clip.kind !== 'audio') return { ok: false, reason: 'MIDI 파트는 이미 나뉘어 있습니다 — 오디오 클립을 고르세요' };
  return { ok: true, clip };
}

/**
 * Separate the clip's source file into stems and put them in the session.
 *
 * Rejects rather than half-finishing: if the worker cannot start, nothing is
 * written and nothing is added.
 */
export async function separateClip(
  session: DawSession, trackId: TrackId, clipId: ClipId, options: SeparateOptions = {},
): Promise<SeparateResult> {
  const guard = canSeparate(session, trackId, clipId);
  if (!guard.ok) throw new Error(guard.reason);
  const clip = guard.ok ? guard.clip : null;
  if (!clip) throw new Error('클립을 찾을 수 없습니다');

  // Decode first if the file has not been touched yet.  Everything else in the
  // app decodes lazily — a waveform is drawn from peaks, playback decodes on
  // demand — so a file that has been imported but not yet played is not in the
  // cache, and "오디오가 아직 디코딩되지 않았습니다" is a true statement that is
  // useless to the person who just pressed Separate.  Decoding IS part of the
  // job; it just is not the interesting part, so it gets its own progress step.
  await ensureDecoded(session, clipId, options.onProgress);

  const { channels, sampleRate } = clipAudio(session, trackId, clipId);
  const wanted = options.wanted && options.wanted.length > 0 ? options.wanted : STEM_KINDS;

  const run = runSeparation(
    channels, sampleRate,
    { ...options.separation, wanted },
    options.onProgress ?? (() => {}),
  );
  const report = await run.result;

  const source = session.files.find((f) => f.id === clip.fileId);
  const baseName = source?.name.replace(/\.[^.]+$/, '') ?? clip.name;
  const sourceTrack = findTrack(session, trackId);

  let next = session;
  const trackIds: Record<string, TrackId> = {};
  const members: TrackId[] = [];

  for (const stem of report.stems) {
    const label = stemLabel(stem.kind);
    const path = await writeTempChannels(stem.channels, sampleRate, `${baseName}-${stem.kind}`);
    const file: AudioFileRef = {
      id: nextId('file'),
      path,
      name: `${baseName} (${label})`,
      durationSec: report.length / sampleRate,
      sampleRate,
      channels: stem.channels.length,
    };
    next = addFile(next, file);
    seedCache(file.id, stem.channels, sampleRate);

    const track = createTrack(`${baseName} · ${label}`, 'audio', {
      color: STEM_COLOR[stem.kind],
    });
    // Each stem goes one row further down than the last.  Inserting them all
    // at the same index is the obvious thing and it lays them out backwards,
    // because every insert pushes the previous one down — the stack came out
    // reading 그 외 · 베이스 · 드럼 · 보컬.
    next = addTrack(next, track, indexAfter(next, trackId, members.length));
    // Placed exactly where the clip that was separated sits, and trimmed the
    // same way — the stems line up with the original by construction.
    next = updateClips(next, track.id, (clips) => [...clips, createClip(file.id, label, {
      startSec: clip.startSec,
      offsetSec: clip.offsetSec,
      durationSec: clip.durationSec,
      fadeIn: clip.fadeIn,
      fadeOut: clip.fadeOut,
    })]);
    trackIds[stem.kind] = track.id;
    members.push(track.id);
  }

  const stacked = createStack(next, `${baseName} 스템`, members, 'summing');
  next = stacked.session;

  if (options.muteSource !== false && sourceTrack) {
    // Otherwise the record plays twice: the stems sum back to the source.
    next = updateTrack(next, trackId, (t) => ({ ...t, mute: true }));
  }

  const shares = report.stems
    .map((s) => `${stemLabel(s.kind)} ${(s.energyShare * 100).toFixed(0)}%`).join(' · ');
  return {
    session: next,
    report,
    folderId: stacked.folderId,
    trackIds,
    message: `${report.stems.length}개 스템으로 나눴습니다 — ${shares}`
      + ` (${(report.elapsedMs / 1000).toFixed(0)}초)`,
  };
}

/** Make sure the clip's source audio is in the cache, decoding it if not. */
async function ensureDecoded(
  session: DawSession, clipId: ClipId, onProgress?: SeparateOptions['onProgress'],
): Promise<void> {
  const clip = session.tracks
    .flatMap((t) => trackClips(t))
    .find((c) => c.id === clipId);
  if (!clip) return;
  if (getCached(clip.fileId)) return;
  const file = session.files.find((f) => f.id === clip.fileId);
  if (!file) throw new Error('원본 파일을 찾을 수 없습니다');
  const ctx = decodeContext();
  if (!ctx) throw new Error('오디오 디코더를 열 수 없습니다');
  onProgress?.(0, '오디오 읽는 중');
  await loadAudio(ctx, file.id, file.path);
}

const STEM_COLOR: Record<StemKind, string> = {
  vocals: '#d67f4f',
  drums:  '#4fd68f',
  bass:   '#4f7fd6',
  other:  '#9f6fd6',
};

/** Right below the track that was separated, so the stems are where you look. */
function indexAfter(session: DawSession, trackId: TrackId, offset: number): number | undefined {
  const at = session.tracks.findIndex((t) => t.id === trackId);
  return at === -1 ? undefined : at + 1 + offset;
}

/**
 * Put the samples we already have into the decode cache.
 *
 * Without this the waveform for each stem is blank until the file is decoded
 * back off disk — four decodes of a four-minute file, for audio that is
 * already in memory.
 */
function seedCache(fileId: string, channels: readonly Float32Array[], sampleRate: number): void {
  const ctor = (globalThis as unknown as {
    AudioBuffer?: new (o: { length: number; sampleRate: number; numberOfChannels: number }) => AudioBuffer;
  }).AudioBuffer;
  const length = channels[0]?.length ?? 0;
  if (!ctor || length === 0) return;
  const buffer = new ctor({ length, sampleRate, numberOfChannels: channels.length });
  for (let c = 0; c < channels.length; c++) {
    buffer.getChannelData(c).set(channels[c] ?? new Float32Array(0));
  }
  analyzeBuffer(fileId, buffer);
}
