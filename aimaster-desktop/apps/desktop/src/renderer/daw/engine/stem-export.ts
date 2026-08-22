// Stem export.
//
// A stem is one part of the mix, rendered on its own, such that PLAYING THE
// STEMS TOGETHER GIVES THE MIX BACK.  That property is the whole feature —
// it is what lets someone else remix, re-master, or fly the song into a
// picture edit without the session.  Everything below follows from it:
//
//   • Every stem is rendered over ONE range, decided once.  Stems of
//     different lengths or origins do not line up, and a file that starts
//     "where its own audio starts" is a trap that only shows up in someone
//     else's DAW.
//
//   • A stem is not "the channel by itself".  It is the WHOLE MIX with every
//     other source muted, so the routing survives: a vocal's reverb send
//     still reaches the reverb aux, and the tail comes out on the vocal stem
//     where it belongs.  Rendering channels in isolation would lose every
//     send, and the stems would sum to a drier mix than the one approved.
//
//   • The master chain is BYPASSED by default.  A limiter is not linear:
//     limit each stem on its own and their sum is not the limited mix, it is
//     something nobody has heard.  The option to include it exists because
//     sometimes a client asks for it, and then the honest thing is to say
//     what it costs.
//
//   • Only what is actually in the mix is exported.  A muted track's stem is
//     a silent file, and its absence is also what keeps the sum correct.

import type { DawSession, Track, TrackId } from '../model/types.js';
import { findTrack, trackClips } from '../model/session-ops.js';
import { clipEnd } from '../model/session-ops.js';
import { isAudible } from '../model/mixer-math.js';
import { renderSession, sessionRange, type RenderRange } from './offline-render.js';
import { encodeAudioBuffer, type WavBitDepth } from './wav.js';

/** Kinds that carry source audio, as opposed to returns and summing points. */
const SOURCE_KINDS = new Set<Track['kind']>(['audio', 'instrument']);

export interface StemItem {
  trackId: TrackId;
  /** Track name as it was, for the message. */
  trackName: string;
  /** File name without extension, numbered and made safe. */
  fileName: string;
}

export interface StemPlan {
  /** The one range every stem is rendered over. */
  range: RenderRange;
  items: StemItem[];
  /** Tracks left out, and why — never a silent omission. */
  skipped: Array<{ trackName: string; reason: string }>;
  /** Things the user should know before the render starts. */
  warnings: string[];
}

export interface StemOptions {
  /**
   * Put the master chain on every stem.
   *
   * Off by default: with a limiter or bus compressor on the master, stems
   * processed individually no longer sum to the mix.
   */
  includeMaster?: boolean;
  /** Only these tracks, when the user picked a subset. */
  trackIds?: readonly TrackId[];
  /** Tail past the range so reverbs and delays are not cut off. */
  tailSec?: number;
}

/** Characters a file name can carry on every platform this ships to. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 60) || 'track';
}

/**
 * Decide what to export, without rendering anything.
 *
 * Pure, so the dialog can show exactly what is about to be written — how
 * many files, how long, and what is being left out — before committing to a
 * render that takes minutes.
 */
export function planStems(session: DawSession, options: StemOptions = {}): StemPlan {
  const wanted = options.trackIds ? new Set(options.trackIds) : null;
  const items: StemItem[] = [];
  const skipped: Array<{ trackName: string; reason: string }> = [];
  const warnings: string[] = [];
  const used = new Set<string>();

  for (const track of session.tracks) {
    if (!SOURCE_KINDS.has(track.kind)) continue;
    if (wanted && !wanted.has(track.id)) continue;

    if (!isAudible(session, track)) {
      // Not a failure: it is not in the mix, so it is not part of the sum.
      skipped.push({ trackName: track.name, reason: '믹스에서 들리지 않습니다 (뮤트/솔로)' });
      continue;
    }
    if (trackClips(track).length === 0) {
      skipped.push({ trackName: track.name, reason: '클립이 없습니다' });
      continue;
    }

    // Numbered so the files sort in track order in any file browser, and
    // de-duplicated so two tracks called "Gtr" do not overwrite each other.
    const base = `${String(items.length + 1).padStart(2, '0')} ${safeName(track.name)}`;
    let fileName = base;
    let n = 2;
    while (used.has(fileName.toLowerCase())) { fileName = `${base} (${n})`; n += 1; }
    used.add(fileName.toLowerCase());

    items.push({ trackId: track.id, trackName: track.name, fileName });
  }

  const master = session.tracks.find((t) => t.kind === 'master');
  if (options.includeMaster && master && master.inserts.some((i) => !i.bypass)) {
    warnings.push(
      '마스터 체인을 각 스템에 적용합니다 — 리미터는 선형이 아니므로'
      + ' 스템을 합쳐도 믹스와 같아지지 않습니다',
    );
  }

  const range = sessionRange(session);
  if (range.endSec <= 0) warnings.push('세션에 오디오가 없습니다');

  return { range, items, skipped, warnings };
}

/**
 * The session as it must look to render ONE stem.
 *
 * Every other source is muted; everything else — auxes, buses, folders, VCAs
 * — is left standing so the routing still works.  Solo is cleared and the
 * mutes are written out explicitly, because solo is relative ("everything
 * else off") and a leftover solo flag elsewhere would silence the very track
 * being rendered.
 */
export function isolateStem(
  session: DawSession, trackId: TrackId, options: StemOptions = {},
): DawSession {
  // Audibility is read from the ORIGINAL session, before anything is muted.
  const audible = new Map<TrackId, boolean>(
    session.tracks.map((t) => [t.id, isAudible(session, t)] as const),
  );

  return {
    ...session,
    tracks: session.tracks.map((track): Track => {
      const base: Track = { ...track, solo: false, soloSafe: false };

      if (track.kind === 'master') {
        // The master still sums — but its processing is what would break the
        // sum, so by default the stems pass through a bare one.
        if (options.includeMaster) return { ...base, mute: false };
        return { ...base, inserts: [], volumeDb: 0, pan: 0, mute: false };
      }

      if (SOURCE_KINDS.has(track.kind)) {
        // The one source that plays, and only if it was in the mix at all.
        const on = track.id === trackId && audible.get(track.id) === true;
        return { ...base, mute: !on };
      }

      // Returns, folders and VCAs keep the state they had, written out as a
      // plain mute so the cleared solo above cannot change their meaning.
      return { ...base, mute: audible.get(track.id) !== true };
    }),
  };
}

/** Render one stem over the shared range. */
export async function renderStem(
  session: DawSession, trackId: TrackId, range: RenderRange, options: StemOptions = {},
): Promise<AudioBuffer> {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');
  const isolated = isolateStem(session, trackId, options);
  return renderSession(isolated, range, {
    ...(options.tailSec === undefined ? {} : { tailSec: options.tailSec }),
  });
}

/**
 * The mix the stems have to add up to.
 *
 * Rendered through the same bare master the stems used, so the comparison is
 * like for like: any difference is the stems' fault, not the master chain's.
 */
export async function renderStemReference(
  session: DawSession, range: RenderRange, options: StemOptions = {},
): Promise<AudioBuffer> {
  const master = session.tracks.find((t) => t.kind === 'master');
  const flattened: DawSession = options.includeMaster || !master ? session : {
    ...session,
    tracks: session.tracks.map((t): Track => (t.kind === 'master'
      ? { ...t, inserts: [], volumeDb: 0, pan: 0 } : t)),
  };
  return renderSession(flattened, range, {
    ...(options.tailSec === undefined ? {} : { tailSec: options.tailSec }),
  });
}

/** One line describing what a plan will do, for the confirm step. */
export function describePlan(plan: StemPlan): string {
  const length = plan.range.endSec;
  const parts = [`스템 ${plan.items.length}개`, `${length.toFixed(1)}초`];
  if (plan.skipped.length > 0) parts.push(`제외 ${plan.skipped.length}개`);
  return parts.join(' · ');
}

/** Longest clip end, exported for callers that need the natural length. */
export function stemRange(session: DawSession): RenderRange {
  let end = 0;
  for (const t of session.tracks) {
    if (!SOURCE_KINDS.has(t.kind)) continue;
    for (const c of trackClips(t)) end = Math.max(end, clipEnd(c));
  }
  return { startSec: 0, endSec: end };
}


// ── Writing ───────────────────────────────────────────────────────────────────

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

function invoker(): Invoke {
  const api = window.electronAPI;
  if (!api) throw new Error('electronAPI를 사용할 수 없습니다');
  return (channel, ...args) => api.invoke(channel as Parameters<typeof api.invoke>[0], ...args);
}

export interface StemProgress {
  /** 1-based, so it reads as "3 / 12". */
  index: number;
  total: number;
  trackName: string;
}

export interface StemExportResult {
  /** Folder the stems were written into, or null when the user cancelled. */
  directory: string | null;
  written: Array<{ trackName: string; path: string }>;
  skipped: StemPlan['skipped'];
  warnings: string[];
}

/**
 * Render and write every stem in a plan.
 *
 * The folder is chosen FIRST, before a single render runs: a four-minute
 * twenty-track export is minutes of work, and discovering at the end that
 * the user meant to cancel wastes all of it.
 */
export async function exportStems(
  session: DawSession,
  options: StemOptions = {},
  onProgress?: (progress: StemProgress) => void,
  bitDepth: WavBitDepth = 24,
): Promise<StemExportResult> {
  const plan = planStems(session, options);
  if (plan.items.length === 0) {
    throw new Error('내보낼 스템이 없습니다 — 들리는 오디오 트랙이 없습니다');
  }

  const invoke = invoker();
  const directory = await invoke('daw:choose-stem-folder', { name: session.name }) as string | null;
  if (!directory) {
    return { directory: null, written: [], skipped: plan.skipped, warnings: plan.warnings };
  }

  const written: Array<{ trackName: string; path: string }> = [];
  for (const [index, item] of plan.items.entries()) {
    onProgress?.({ index: index + 1, total: plan.items.length, trackName: item.trackName });
    const buffer = await renderStem(session, item.trackId, plan.range, options);
    const bytes = encodeAudioBuffer(buffer, bitDepth);
    const path = await invoke('daw:write-stem', { name: item.fileName, data: bytes }) as string;
    written.push({ trackName: item.trackName, path });
  }

  return { directory, written, skipped: plan.skipped, warnings: plan.warnings };
}
