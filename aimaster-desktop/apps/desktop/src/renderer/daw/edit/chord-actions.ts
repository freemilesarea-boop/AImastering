// Reading a clip's chords into the chord track.
//
// The detector in `daw/audio/chroma/` takes mono samples and gives back a
// chord chart.  This is the layer between it and the session: which audio to
// hand it, what tempo to tell it, and where the answer goes.
//
// Three decisions worth stating.
//
//   THE CHORD TRACK IS REPLACED, NOT APPENDED TO.  Two detections of the same
//   clip would otherwise stack two charts on one lane, and because a chord
//   stores only where it STARTS, the result is not "two opinions" but one
//   unreadable interleaving of both.  Chords outside the analysed span are
//   kept — analysing the second verse must not erase the first.
//
//   THE SEPARATOR RUNS FIRST, BY DEFAULT.  That is the accuracy the user
//   asked for and it buys two different things: the drums come OUT of the mix
//   being matched (a snare is broadband energy that lands on every pitch class
//   at once), and the bass stem comes IN as the bass reading, which is the
//   only thing that separates Am7 from C6.  It is much slower, so it can be
//   turned off; when the separator refuses, this says so and analyses the mix
//   rather than failing.
//
//   THE TEMPO COMES FROM THE SESSION, WITH THE PHASE WORKED OUT.  The session
//   knows its own BPM, and the clip sits somewhere on that grid — a clip
//   starting mid-bar must not be analysed as though its first sample were a
//   downbeat, or every chord boundary lands off the beat.

import {
  detectChordsFromAudio, describeReadout,
} from '../audio/chroma/chord-detect-audio.js';
import { runChordDetection } from '../audio/chroma/run.js';
import type { ChordReadout } from '../audio/chroma/chord-segment.js';
import type { ChordVocabulary } from '../audio/chroma/chord-match.js';
import { runSeparation, type ProgressListener } from '../audio/separate/run.js';
import { decodeContext, getCached, loadAudio } from '../engine/audio-cache.js';
import { trackClips } from '../model/session-ops.js';
import { nextId } from '../model/ids.js';
import { sortedChords, withChords } from './chord-edit.js';
import { clipAudio } from './spectral-repair.js';
import type { ChordEvent } from '../model/chords.js';
import type { ClipId, DawSession, TrackId } from '../model/types.js';

export interface DetectChordsForClipOptions {
  vocabulary?: ChordVocabulary;
  /**
   * Separate first — drums out, bass stem in.
   *
   * On by default: "정확하게" was the choice, and this is most of what that
   * word buys.
   */
  separate?: boolean;
  /**
   * Run the analysis inline instead of on a worker.
   *
   * For a self-test, and for nothing else.  The measured cost is about 29×
   * real time at 44.1 kHz, so a four-minute clip is eight seconds of a window
   * that cannot repaint — including the progress the button is trying to show.
   */
  inline?: boolean;
  onProgress?: ProgressListener;
}

export interface ClipChordResult {
  session: DawSession;
  readout: ChordReadout;
  /** What the chord track gained, and anything the user should know. */
  message: string;
  /** Set when the separator could not run and the mix was used instead. */
  separationNote?: string;
  /** Set when the worker could not start and the analysis blocked the thread. */
  workerNote?: string;
}

/** Sum to mono over a span of the source file, in samples. */
function monoSlice(
  channels: readonly Float32Array[], from: number, to: number,
): Float32Array {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.max(start, to);
  const out = new Float32Array(end - start);
  const count = Math.max(1, channels.length);
  for (const channel of channels) {
    const limit = Math.min(end, channel.length);
    for (let i = start; i < limit; i++) out[i - start] = (out[i - start] ?? 0) + (channel[i] ?? 0) / count;
  }
  return out;
}

/**
 * Where beat one falls inside the analysed buffer.
 *
 * The clip starts at `startSec` on the session's grid, so the first beat
 * boundary at or after it is `ceil(startSec / period) * period` — and what the
 * detector needs is that instant expressed from the START OF THE CLIP.
 */
export function beatPhaseFor(startSec: number, bpm: number): number {
  if (!(bpm > 0)) return 0;
  const period = 60 / bpm;
  const next = Math.ceil(startSec / period - 1e-9) * period;
  return Math.max(0, next - startSec);
}

/**
 * Chords the clip is playing, written into the session's chord track.
 *
 * The clip's own slice of its file, not the whole file: a chord chart for
 * audio the user did not put in the arrangement is a chart for something they
 * cannot see.
 */
export async function detectChordsForClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  options: DetectChordsForClipOptions = {},
): Promise<ClipChordResult> {
  const { vocabulary, separate = true, inline = false, onProgress } = options;

  await ensureDecoded(session, clipId, onProgress);
  const { clip, channels, sampleRate } = clipAudio(session, trackId, clipId);
  const from = Math.round(clip.offsetSec * sampleRate);
  const to = Math.round((clip.offsetSec + clip.durationSec) * sampleRate);
  if (to - from < sampleRate * 0.5) {
    throw new Error('0.5초보다 짧은 클립에서는 코드를 읽을 수 없습니다');
  }

  let mix = monoSlice(channels, from, to);
  let bass: Float32Array | null = null;
  let separationNote: string | undefined;

  if (separate) {
    try {
      // The separator is handed the clip's slice, and the buffers are
      // TRANSFERRED — so they are copies made here, never the cache's.
      const slices = channels.map((c) => c.slice(Math.max(0, from), Math.max(0, to)));
      const report = await runSeparation(
        slices, sampleRate, { wanted: ['vocals', 'drums', 'bass', 'other'] },
        (fraction, what) => onProgress?.(fraction * 0.6, what),
      ).result;
      const stemOf = (kind: string): Float32Array[] | null =>
        report.stems.find((s) => s.kind === kind)?.channels ?? null;
      const bassStem = stemOf('bass');
      const harmonic = report.stems.filter((s) => s.kind !== 'drums');
      if (harmonic.length > 0) {
        // Everything but the drums, summed back together.  A snare is
        // broadband energy that lands on all twelve pitch classes at once,
        // and removing it is most of what the accuracy setting buys.
        const length = mix.length;
        const rebuilt = new Float32Array(length);
        for (const stem of harmonic) {
          const count = Math.max(1, stem.channels.length);
          for (const channel of stem.channels) {
            const limit = Math.min(length, channel.length);
            for (let i = 0; i < limit; i++) rebuilt[i] = (rebuilt[i] ?? 0) + (channel[i] ?? 0) / count;
          }
        }
        mix = rebuilt;
      }
      if (bassStem && bassStem.length > 0) {
        bass = monoSlice(bassStem, 0, Math.min(mix.length, bassStem[0]?.length ?? 0));
      }
    } catch (err) {
      // Refusing outright would be worse than a slightly less accurate chart,
      // so this degrades and SAYS SO — the mix still has a lowest note in it.
      separationNote = err instanceof Error ? err.message : String(err);
    }
  }

  onProgress?.(0.6, '코드 분석');
  const detectOptions = {
    ...(vocabulary ? { vocabulary } : {}),
    tempo: {
      bpm: session.tempoBpm,
      phaseSec: beatPhaseFor(clip.startSec, session.tempoBpm),
      // The session's own tempo, which the user set or the detector wrote —
      // not a guess made from this clip.
      confidence: 0.9,
    },
    bass,
  };
  const report = (fraction: number, what: string): void => onProgress?.(0.6 + fraction * 0.4, what);
  // On a worker, because the analysis is seconds of solid arithmetic and a
  // blocked main thread cannot paint the progress it is being asked to show.
  let workerNote: string | undefined;
  let readout: ChordReadout;
  if (inline) {
    readout = detectChordsFromAudio(mix, sampleRate, { ...detectOptions, onProgress: report });
  } else {
    try {
      readout = await runChordDetection(mix, sampleRate, detectOptions, report).result;
    } catch (err) {
      // Same degrade-and-say-so rule as the separator above: a few seconds of
      // a stuck window is worse than the alternative, and no chart at all is
      // worse than both.
      workerNote = err instanceof Error ? err.message : String(err);
      readout = detectChordsFromAudio(mix, sampleRate, { ...detectOptions, onProgress: report });
    }
  }

  const events = replaceChordsInSpan(
    sortedChords(session),
    clip.startSec, clip.startSec + clip.durationSec,
    readout.segments.map((segment) => ({
      id: nextId('chord'),
      timeSec: clip.startSec + segment.startSec,
      chord: segment.chord,
    })),
  );
  const placed = readout.segments;

  const parts = [`코드 ${placed.length}개를 코드 트랙에 썼습니다`, describeReadout(readout)];
  if (separationNote) parts.push(`분리 없이 믹스에서 읽었습니다 — ${separationNote}`);
  if (workerNote) parts.push(`창이 잠시 멈췄습니다 (워커 없이 분석) — ${workerNote}`);
  return {
    session: withChords(session, events),
    readout,
    message: parts.join(' · '),
    ...(separationNote ? { separationNote } : {}),
    ...(workerNote ? { workerNote } : {}),
  };
}

/**
 * The detected chords replace what was in the analysed span, and only there.
 *
 * Appending would be wrong in a way that is not obvious until you see it: a
 * chord stores only where it STARTS, so what is sounding at 1:12 is the last
 * change at or before it.  Two charts over one span therefore do not read as
 * two opinions — they interleave into one chart that is neither.
 *
 * Outside the span, everything is kept.  Analysing the second verse must not
 * erase the first, and a user who analyses four clips one at a time should end
 * up with a chart for all four.
 */
export function replaceChordsInSpan(
  existing: readonly ChordEvent[], startSec: number, endSec: number,
  placed: readonly ChordEvent[],
): ChordEvent[] {
  const kept = existing.filter(
    (event) => event.timeSec < startSec - 1e-6 || event.timeSec > endSec + 1e-6,
  );
  return [...kept, ...placed].sort((a, b) => a.timeSec - b.timeSec);
}

async function ensureDecoded(
  session: DawSession, clipId: ClipId, onProgress?: ProgressListener,
): Promise<void> {
  const clip = session.tracks.flatMap((t) => trackClips(t)).find((c) => c.id === clipId);
  if (!clip) return;
  if (getCached(clip.fileId)) return;
  const file = session.files.find((f) => f.id === clip.fileId);
  if (!file) throw new Error('원본 파일을 찾을 수 없습니다');
  const ctx = decodeContext();
  if (!ctx) throw new Error('오디오 디코더를 열 수 없습니다');
  onProgress?.(0, '오디오 읽는 중');
  await loadAudio(ctx, file.id, file.path);
}
