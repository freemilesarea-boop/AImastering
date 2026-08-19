// Restoration actions — noise reduction and de-click, as session edits.
//
// The DSP is pure (daw/audio/noise-reduction.ts, daw/audio/declick.ts); this
// is the layer that reads a clip's decoded audio, runs it, writes the result
// as a new source file and repoints the clip.  Same contract as spectral
// repair: the original file is never touched.

import {
  learnNoiseProfile, reduceNoiseChannels, profileFloorDb,
  type DenoiseOptions, type NoiseProfile,
} from '../audio/noise-reduction.js';
import {
  declickChannels, detectClicks, type ClickEvent, type ClickOptions, type RepairOptions,
} from '../audio/declick.js';
import {
  detectHum, removeHumChannels, type DehumOptions, type HumDetection, type HumOptions,
} from '../audio/dehum.js';
import {
  dereverbChannels, estimateReverbTime, type DereverbOptions, type ReverbEstimate,
} from '../audio/dereverb.js';
import { clipAudio, writeEditedClip } from './spectral-repair.js';
import type { ClipId, DawSession, TrackId } from '../model/types.js';

/** Mono sum of a clip — what both detectors analyse. */
function monoOf(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0] ?? new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (let i = 0; i < first.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

export interface LearnResult {
  profile: NoiseProfile;
  floorDb: number;
}

/**
 * Learn the noise floor from a time range of a clip.
 *
 * `fromSec`/`toSec` are TIMELINE seconds — the range the user selected in the
 * Edit window — and are translated into the clip's own file positions here, so
 * the caller never has to think about clip offsets.
 */
export function learnClipNoise(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  fromSec: number, toSec: number,
): LearnResult {
  const { clip, channels, sampleRate } = clipAudio(session, trackId, clipId);
  const start = Math.min(fromSec, toSec) - clip.startSec + clip.offsetSec;
  const end = Math.max(fromSec, toSec) - clip.startSec + clip.offsetSec;
  const profile = learnNoiseProfile(monoOf(channels), sampleRate, start, end);
  return { profile, floorDb: profileFloorDb(profile) };
}

export interface RestoreResult {
  session: DawSession;
  message: string;
}

export async function denoiseClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  profile: NoiseProfile, options: DenoiseOptions = {},
): Promise<RestoreResult> {
  const { channels, sampleRate } = clipAudio(session, trackId, clipId);
  if (sampleRate !== profile.sampleRate) {
    throw new Error('노이즈 프로파일과 클립의 샘플레이트가 다릅니다');
  }
  const cleaned = reduceNoiseChannels(channels, sampleRate, profile, options);
  const residual = (options.output ?? 'clean') === 'residual';
  const written = await writeEditedClip(
    session, trackId, clipId, cleaned, sampleRate,
    residual ? 'residual' : 'denoise', residual ? 'residual' : 'denoised');
  return {
    session: written.session,
    message: residual
      ? '제거될 성분만 남긴 잔차를 만들었습니다 — 음악이 들리면 과처리입니다'
      : `노이즈 리덕션 ${Math.abs(options.reductionDb ?? 12).toFixed(0)} dB 적용`,
  };
}

/** Detect only — the scan that fills the list before anything is written. */
export function scanClipClicks(
  session: DawSession, trackId: TrackId, clipId: ClipId, options: ClickOptions = {},
): { clicks: ClickEvent[]; sampleRate: number } {
  const { clip, channels, sampleRate } = clipAudio(session, trackId, clipId);
  const from = Math.floor(clip.offsetSec * sampleRate);
  const to = Math.min(channels[0]?.length ?? 0, Math.ceil((clip.offsetSec + clip.durationSec) * sampleRate));
  const mono = monoOf(channels).subarray(Math.max(0, from), Math.max(0, to));
  const clicks = detectClicks(mono, sampleRate, options)
    // Report in file time, so the UI can put them on the timeline.
    .map((c) => ({
      ...c,
      startSec: c.startSec + clip.offsetSec,
      endSec: c.endSec + clip.offsetSec,
    }));
  return { clicks, sampleRate };
}

export async function declickClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  options: ClickOptions & RepairOptions = {},
): Promise<RestoreResult & { detected: number; repaired: number }> {
  const { channels, sampleRate } = clipAudio(session, trackId, clipId);
  const result = declickChannels(channels, sampleRate, options);
  if (result.detected === 0) {
    return { session, message: '클릭을 찾지 못했습니다', detected: 0, repaired: 0 };
  }
  const written = await writeEditedClip(
    session, trackId, clipId, result.channels, sampleRate, 'declick', 'declicked');
  return {
    session: written.session,
    message: `클릭 ${result.detected}개 중 ${result.repaired}개를 복원했습니다`,
    detected: result.detected,
    repaired: result.repaired,
  };
}

// ── De-hum ────────────────────────────────────────────────────────────────────

/** Look for mains hum in a clip.  Null means none was convincingly there. */
export function detectClipHum(
  session: DawSession, trackId: TrackId, clipId: ClipId, options: HumOptions = {},
): HumDetection | null {
  const { clip, channels, sampleRate } = clipAudio(session, trackId, clipId);
  const from = Math.max(0, Math.floor(clip.offsetSec * sampleRate));
  const to = Math.min(channels[0]?.length ?? 0, Math.ceil((clip.offsetSec + clip.durationSec) * sampleRate));
  return detectHum(monoOf(channels).subarray(from, to), sampleRate, options);
}

export async function dehumClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  detection: HumDetection, options: DehumOptions = {},
): Promise<RestoreResult> {
  const { channels, sampleRate } = clipAudio(session, trackId, clipId);
  if (sampleRate !== detection.profile.sampleRate) {
    throw new Error('험 프로파일과 클립의 샘플레이트가 다릅니다');
  }
  const cleaned = removeHumChannels(channels, sampleRate, detection, options);
  const residual = (options.output ?? 'clean') === 'residual';
  const written = await writeEditedClip(
    session, trackId, clipId, cleaned, sampleRate,
    residual ? 'hum-residual' : 'dehum', residual ? 'hum residual' : 'de-hummed');
  return {
    session: written.session,
    message: residual
      ? '제거될 험만 남긴 잔차입니다 — 음악이 들리면 과처리입니다'
      : `${detection.nominal} Hz 계열 험 제거 · 하모닉 ${detection.harmonics.length}개`,
  };
}

// ── De-reverb ─────────────────────────────────────────────────────────────────

/** Measure the room from the clip's own free decays. */
export function estimateClipReverb(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): ReverbEstimate | null {
  const { clip, channels, sampleRate } = clipAudio(session, trackId, clipId);
  const from = Math.max(0, Math.floor(clip.offsetSec * sampleRate));
  const to = Math.min(channels[0]?.length ?? 0, Math.ceil((clip.offsetSec + clip.durationSec) * sampleRate));
  return estimateReverbTime(monoOf(channels).subarray(from, to), sampleRate);
}

export async function dereverbClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  t60: number, options: DereverbOptions = {},
): Promise<RestoreResult> {
  const { channels, sampleRate } = clipAudio(session, trackId, clipId);
  const cleaned = dereverbChannels(channels, sampleRate, t60, options);
  const residual = (options.output ?? 'clean') === 'residual';
  const written = await writeEditedClip(
    session, trackId, clipId, cleaned, sampleRate,
    residual ? 'reverb-tail' : 'dereverb', residual ? 'reverb tail' : 'de-reverbed');
  return {
    session: written.session,
    message: residual
      ? '제거될 잔향 꼬리만 남겼습니다'
      : `잔향 감소 · T60 ${t60.toFixed(2)} s 기준`,
  };
}
