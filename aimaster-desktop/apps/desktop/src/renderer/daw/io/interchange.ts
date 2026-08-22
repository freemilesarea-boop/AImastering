// The shape a session has when it is between two applications.
//
// An AAF from a picture editor and a DAW session are not the same thing and
// converting one straight into the other loses the argument every time: the
// AAF has no faders, the session has no mob ids.  So both sides convert to
// THIS — an edit decision list with real media references — and neither side
// has to know about the other.
//
// It is deliberately small.  Everything an interchange format cannot carry
// faithfully is left out rather than approximated, and the conversion says
// what it left behind.  A plugin chain that arrives as "some effect was here"
// is worse than a note saying the effects did not come.

import { addFile, addTrack, createClip, createSession, createTrack, updateClips }
  from '../model/session-ops.js';
import { clipEnd, findFile, trackClips } from '../model/session-ops.js';
import { NO_FADE } from '../model/types.js';
import type { DawSession, Clip } from '../model/types.js';

export interface InterchangeClip {
  name: string;
  /** Where it sits on the timeline. */
  startSec: number;
  durationSec: number;
  /** How far into the source file it starts. */
  sourceOffsetSec: number;
  /** Where the media is, as the file said it — usually a file:// URL. */
  sourceUrl: string | null;
  sourceName: string;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface InterchangeTrack {
  name: string;
  clips: InterchangeClip[];
}

export interface InterchangeSession {
  name: string;
  /** The edit rate the file was authored at — usually the audio sample rate. */
  sampleRate: number;
  tracks: InterchangeTrack[];
  /** One line per thing that could not be carried across, named. */
  problems: string[];
}

export const emptyInterchange = (name = 'Interchange'): InterchangeSession =>
  ({ name, sampleRate: 48_000, tracks: [], problems: [] });

/** Last sound in the whole thing, in seconds. */
export function interchangeEndSec(session: InterchangeSession): number {
  let end = 0;
  for (const track of session.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.startSec + clip.durationSec);
  }
  return end;
}

export function describeInterchange(session: InterchangeSession): string {
  const clips = session.tracks.reduce((n, t) => n + t.clips.length, 0);
  const linked = new Set(session.tracks.flatMap((t) =>
    t.clips.map((c) => c.sourceUrl).filter((u): u is string => !!u))).size;
  const end = interchangeEndSec(session);
  return `트랙 ${session.tracks.length} · 클립 ${clips} · 미디어 ${linked} · `
    + `${Math.floor(end / 60)}분 ${Math.round(end % 60)}초`;
}

// ── Into a session ────────────────────────────────────────────────────────────

export interface BuildResult {
  session: DawSession;
  /** Media the file pointed at, in the order the tracks reference them. */
  mediaUrls: string[];
  problems: string[];
}

/** The last path component of a URL or path, decoded. */
export function fileNameOf(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const parts = withoutQuery.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? url;
  try { return decodeURIComponent(last); } catch { return last; }
}

/**
 * Turn an interchange session into a DAW session.
 *
 * The audio is NOT loaded here — this makes the arrangement, and the clips
 * point at file references whose paths came out of the interchange file.
 * Whether those paths exist on this machine is a separate question with a
 * separate answer, and conflating the two is how an import silently produces
 * a session of empty rectangles.
 */
export function sessionFromInterchange(
  interchange: InterchangeSession, sampleRate = interchange.sampleRate,
): BuildResult {
  let session = createSession(interchange.name || 'Imported', sampleRate);
  const problems = [...interchange.problems];
  const urls: string[] = [];
  const fileIds = new Map<string, string>();

  for (const track of interchange.tracks) {
    const daw = createTrack(track.name || '트랙', 'audio');
    session = addTrack(session, daw);

    const clips: Clip[] = [];
    for (const clip of track.clips) {
      const key = clip.sourceUrl ?? `unlinked:${clip.sourceName}`;
      let fileId = fileIds.get(key);
      if (!fileId) {
        fileId = `aaf-${fileIds.size + 1}`;
        fileIds.set(key, fileId);
        if (clip.sourceUrl) urls.push(clip.sourceUrl);
        session = addFile(session, {
          id: fileId,
          path: clip.sourceUrl ? urlToPath(clip.sourceUrl) : '',
          name: clip.sourceName || fileNameOf(clip.sourceUrl ?? '이름 없음'),
          // The interchange file says where the media starts, not how long it
          // is; the real duration arrives when the audio is decoded.
          durationSec: clip.sourceOffsetSec + clip.durationSec,
          sampleRate,
          channels: 2,
        });
      }
      clips.push(createClip(fileId, clip.name || clip.sourceName, {
        startSec: Math.max(0, clip.startSec),
        offsetSec: Math.max(0, clip.sourceOffsetSec),
        durationSec: Math.max(0.001, clip.durationSec),
        fadeIn: clip.fadeInSec > 0 ? { durationSec: clip.fadeInSec, shape: 'equalPower' } : NO_FADE,
        fadeOut: clip.fadeOutSec > 0 ? { durationSec: clip.fadeOutSec, shape: 'equalPower' } : NO_FADE,
      }));
    }
    session = updateClips(session, daw.id, () => clips);
  }

  return { session, mediaUrls: urls, problems };
}

/** `file:///a/b.wav` → `/a/b.wav`.  Anything else is passed through. */
export function urlToPath(url: string): string {
  if (!url.startsWith('file://')) return url;
  let rest = url.slice('file://'.length);
  // file://host/path is legal and rare; the host is not ours to resolve.
  if (rest.startsWith('/')) { /* file:///path */ } else {
    const slash = rest.indexOf('/');
    rest = slash >= 0 ? rest.slice(slash) : `/${rest}`;
  }
  try { return decodeURIComponent(rest); } catch { return rest; }
}

export function pathToUrl(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const withSlash = normalised.startsWith('/') ? normalised : `/${normalised}`;
  return `file://${withSlash.split('/').map(encodeURIComponent).join('/')}`;
}

// ── Out of a session ──────────────────────────────────────────────────────────

/**
 * Read a DAW session into the interchange shape.
 *
 * Only what an AAF can hold: audio tracks, their clips, where each clip sits,
 * what it plays and its fades.  Everything else — plugins, automation, sends,
 * MIDI, tempo — is named as left behind rather than silently dropped, because
 * the person receiving the file is going to assume it is all there.
 */
export function interchangeFromSession(session: DawSession): InterchangeSession {
  const problems: string[] = [];
  const tracks: InterchangeTrack[] = [];

  for (const track of session.tracks) {
    if (track.kind === 'instrument') {
      const parts = trackClips(track).length;
      if (parts > 0) problems.push(`${track.name} — MIDI 파트 ${parts}개는 AAF 로 나가지 않습니다`);
      continue;
    }
    if (track.kind !== 'audio') continue;

    const clips: InterchangeClip[] = [];
    for (const clip of trackClips(track)) {
      if (clip.muted) continue;
      const file = findFile(session, clip.fileId);
      if (!file || !file.path) {
        problems.push(`${track.name} · ${clip.name} — 원본 파일 경로가 없어 제외했습니다`);
        continue;
      }
      clips.push({
        name: clip.name,
        startSec: clip.startSec,
        durationSec: clipEnd(clip) - clip.startSec,
        sourceOffsetSec: clip.offsetSec,
        sourceUrl: pathToUrl(file.path),
        sourceName: file.name,
        fadeInSec: clip.fadeIn.durationSec,
        fadeOutSec: clip.fadeOut.durationSec,
      });
    }
    if (clips.length === 0) continue;
    tracks.push({ name: track.name, clips });

    if (track.inserts.length > 0) {
      problems.push(`${track.name} — 인서트 ${track.inserts.length}개는 AAF 로 나가지 않습니다`);
    }
    if (track.automation.length > 0) {
      problems.push(`${track.name} — 오토메이션 레인 ${track.automation.length}개는 AAF 로 나가지 않습니다`);
    }
    if (track.sends.length > 0) {
      problems.push(`${track.name} — 센드 ${track.sends.length}개는 AAF 로 나가지 않습니다`);
    }
    if (track.volumeDb !== 0 || track.pan !== 0) {
      problems.push(`${track.name} — 페이더와 팬은 AAF 로 나가지 않습니다 (필요하면 스템으로 내보내세요)`);
    }
  }

  return {
    name: session.name,
    sampleRate: session.sampleRate,
    tracks,
    problems,
  };
}
