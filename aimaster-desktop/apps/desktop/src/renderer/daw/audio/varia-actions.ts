// Vocal editor actions — analyse a stem, correct it, render it back.
//
// This is the bridge between the pure pitch layer and the session: it pulls
// the decoded audio out of the cache, runs the analysis, applies the chosen
// correction, renders through PSOLA and points the clip at the new file.
//
// The original file is never touched.  A correction produces a NEW render in
// the session scratch directory and the clip is re-pointed at it, so undo
// restores the take exactly.

import { analyzeVocal, quantizeToPitches, straighten, withEdit, type VariSegment } from './pitch-analysis.js';
import { renderVariAudio } from './pitch-shift.js';
import { getCached, analyzeBuffer, loadAudio, decodeContext } from '../engine/audio-cache.js';
import { writeTempChannels } from '../engine/offline-render.js';
import { addFile, findTrack, trackClips, updateClip } from '../model/session-ops.js';
import { scalePitchClasses, type Scale } from '../model/scales.js';
import { nextId } from '../model/ids.js';
import type { DawSession, TrackId, ClipId } from '../model/types.js';

/** Decoded channels for a clip's source file, decoding on demand. */
async function clipChannels(
  session: DawSession, fileId: string,
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  let cached = getCached(fileId);
  if (!cached) {
    const file = session.files.find((f) => f.id === fileId);
    const ctx = decodeContext();
    if (!file || !ctx) return null;
    cached = await loadAudio(ctx, file.id, file.path);
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < cached.buffer.numberOfChannels; c++) {
    channels.push(cached.buffer.getChannelData(c));
  }
  return { channels, sampleRate: cached.buffer.sampleRate };
}

export interface AnalyzeResult {
  session: DawSession;
  segmentCount: number;
}

/**
 * Analyse a clip's audio into editable pitch segments.
 * Only the clip's own span of the file is analysed, so trimming a take does
 * not drag the neighbouring phrase into the editor.
 */
export async function analyzeClipPitch(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): Promise<AnalyzeResult> {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  if (!clip || clip.kind !== 'audio') throw new Error('오디오 클립을 선택하세요');

  const decoded = await clipChannels(session, clip.fileId);
  if (!decoded) throw new Error('오디오를 디코딩할 수 없습니다');

  const { channels, sampleRate } = decoded;
  const from = Math.floor(clip.offsetSec * sampleRate);
  const to = Math.min(channels[0]?.length ?? 0, Math.ceil((clip.offsetSec + clip.durationSec) * sampleRate));
  const mono = new Float32Array(Math.max(0, to - from));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[from + i] ?? 0;
    mono[i] = sum / Math.max(1, channels.length);
  }

  const segments = analyzeVocal(mono, sampleRate);
  return {
    session: updateClip(session, trackId, clipId, (c) => ({ ...c, pitchSegments: segments })),
    segmentCount: segments.length,
  };
}

export type CorrectionMode =
  | { kind: 'toScale'; scale: Scale; amount: number }
  | { kind: 'toSemitone'; amount: number }
  | { kind: 'straighten'; amount: number }
  | { kind: 'formant'; semitones: number };

/** Apply a correction to a clip's segments without rendering yet. */
export function applyCorrection(
  session: DawSession, trackId: TrackId, clipId: ClipId, mode: CorrectionMode,
): DawSession {
  return updateClip(session, trackId, clipId, (clip) => ({
    ...clip,
    pitchSegments: clip.pitchSegments.map((segment) => correctSegment(segment, mode)),
  }));
}

export function correctSegment(segment: VariSegment, mode: CorrectionMode): VariSegment {
  switch (mode.kind) {
    case 'toScale':
      return quantizeToPitches(segment, scalePitchClasses(mode.scale), mode.amount);
    case 'toSemitone': {
      const target = Math.round(segment.measured.medianPitch);
      const cents = (target - segment.measured.medianPitch) * 100;
      return withEdit(segment, { pitchOffsetCents: cents * mode.amount });
    }
    case 'straighten':
      return straighten(segment, mode.amount);
    case 'formant':
      return withEdit(segment, { formantSemitones: mode.semitones });
    default:
      return segment;
  }
}

/**
 * Render the clip's pitch edits into a new file and re-point the clip at it.
 * The analysis is carried over (re-pointed at the new source) so the editor
 * keeps showing the same segments.
 */
export async function renderClipPitch(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): Promise<DawSession> {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  if (!clip || clip.kind !== 'audio') throw new Error('오디오 클립을 선택하세요');
  if (clip.pitchSegments.length === 0) throw new Error('먼저 피치 분석을 실행하세요');

  const decoded = await clipChannels(session, clip.fileId);
  if (!decoded) throw new Error('오디오를 디코딩할 수 없습니다');
  const { channels, sampleRate } = decoded;

  // Segment times are clip-relative; the renderer works on the file, so they
  // are offset into file time for the render pass.
  const shifted = clip.pitchSegments.map((s) => ({
    ...s,
    startSec: s.startSec + clip.offsetSec,
    endSec: s.endSec + clip.offsetSec,
  }));

  const rendered = renderVariAudio(channels, sampleRate, shifted);
  const path = await writeTempChannels(rendered, sampleRate, `${clip.name}-tuned`);

  const ref = {
    id: nextId('file'),
    path,
    name: `${clip.name} (tuned)`,
    durationSec: (channels[0]?.length ?? 0) / sampleRate,
    sampleRate,
    channels: channels.length,
  };

  // Seed the cache so the waveform redraws immediately instead of after a
  // round trip through the decoder.
  const ctx = decodeContext();
  if (ctx) {
    const buffer = ctx.createBuffer(rendered.length, rendered[0]?.length ?? 1, sampleRate);
    for (let c = 0; c < rendered.length; c++) {
      // copyToChannel wants a Float32Array over a plain ArrayBuffer; the
      // rendered arrays already are, but the DOM types are stricter.
      buffer.getChannelData(c).set(rendered[c]!);
    }
    analyzeBuffer(ref.id, buffer);
  }

  const withRef = addFile(session, ref);
  return updateClip(withRef, trackId, clipId, (c) => ({ ...c, fileId: ref.id }));
}

/** Summary line for the UI: how far off the take is. */
export function tuningSummary(segments: readonly VariSegment[]): string {
  if (segments.length === 0) return '분석 없음';
  const errors = segments.map((s) => {
    const target = Math.round(s.measured.medianPitch);
    return Math.abs((target - s.measured.medianPitch) * 100);
  });
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const worst = Math.max(...errors);
  return `${segments.length}개 구간 · 평균 ${mean.toFixed(0)}센트 · 최대 ${worst.toFixed(0)}센트`;
}
