// album.ts — a record, not a pile of files.
//
// Mastering one song is the app's whole flow today.  Delivering an ALBUM is a
// different job with its own rules, and none of them were expressible: the
// order, the gaps between songs, the codes the distributor needs, and the fact
// that a CD does not measure time in seconds.
//
// A Red Book CD is divided into FRAMES, 75 to the second, and every position
// on a disc — where a track starts, where the pause before it starts, where
// the disc ends — is a whole number of frames.  A gap of "2 seconds" is 150
// frames; a gap of 2.007 seconds is not representable and has to become one or
// the other.  So the layout is computed in frames throughout and seconds only
// ever appear at the edges, where a person types them.
//
// The two index points per track are the part that surprises people:
//
//   INDEX 00 — where the PAUSE before the track begins.  A player counting
//              down to the track is counting through this.
//   INDEX 01 — where the MUSIC begins.  This is "the start of track 3".
//
// A track with no pause has only INDEX 01.  The first track is special: the
// Red Book requires at least two seconds of silence before it, and that
// silence is not part of track 1 — it is the disc's lead-in.

/** Frames per second on a CD.  Not negotiable; it is what the format is. */
export const CD_FRAMES_PER_SEC = 75;

/** Red Book: a disc holds at most 99 tracks. */
export const MAX_CD_TRACKS = 99;

/** Red Book: no track shorter than four seconds. */
export const MIN_TRACK_SEC = 4;

/** Red Book: at least two seconds of silence before track 1. */
export const MIN_LEAD_IN_SEC = 2;

/** A standard 74-minute disc, in frames — the limit most plants quote. */
export const CD_CAPACITY_FRAMES = 74 * 60 * CD_FRAMES_PER_SEC;

/** An 80-minute disc.  Common, but not every plant will take one. */
export const CD_CAPACITY_FRAMES_80 = 80 * 60 * CD_FRAMES_PER_SEC;

export interface AlbumTrack {
  id: string;
  title: string;
  /** Track artist, when it differs from the album's. */
  performer?: string;
  /**
   * ISRC — the recording's identifier, 12 characters: CC-XXX-YY-NNNNN.
   * Stored WITHOUT hyphens, which is how it goes on the disc.
   */
  isrc?: string;
  /** Where the mastered audio for this track lives. */
  sourcePath: string;
  durationSec: number;
  /**
   * Silence before this track, in seconds.
   *
   * Becomes INDEX 00 → INDEX 01.  Zero means the track runs straight out of
   * the one before it, which is what a segued album wants.
   */
  gapBeforeSec: number;
  /** Level trim for this track alone, from the album level match. */
  gainDb: number;
}

export interface Album {
  title: string;
  performer: string;
  /** UPC / EAN — the product's barcode, 12 or 13 digits. */
  upc?: string;
  tracks: AlbumTrack[];
  /**
   * Silence before track 1.  Two seconds is the Red Book minimum and the
   * default; some labels ask for more.
   */
  leadInSec: number;
}

export function createAlbum(title = 'Untitled Album', performer = ''): Album {
  return { title, performer, tracks: [], leadInSec: MIN_LEAD_IN_SEC };
}

// ── Frames and MSF ──────────────────────────────────────────────────────────

/**
 * Seconds to whole frames, rounded.
 *
 * Rounded rather than truncated: a two-second gap typed by a person is meant
 * to be two seconds, and floor() would silently make it 1.9867 s every time
 * floating point landed a hair under.
 */
export function secToFrames(sec: number): number {
  return Math.max(0, Math.round(sec * CD_FRAMES_PER_SEC));
}

export function framesToSec(frames: number): number {
  return frames / CD_FRAMES_PER_SEC;
}

/** Minutes:Seconds:Frames, the way every PQ sheet and cue file writes it. */
export function framesToMsf(frames: number): string {
  const f = Math.max(0, Math.round(frames));
  const m = Math.floor(f / (60 * CD_FRAMES_PER_SEC));
  const s = Math.floor((f % (60 * CD_FRAMES_PER_SEC)) / CD_FRAMES_PER_SEC);
  const r = f % CD_FRAMES_PER_SEC;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s)}:${pad(r)}`;
}

/** Parse `MM:SS:FF` back to frames.  Returns null on anything else. */
export function msfToFrames(msf: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d):(\d{2})$/.exec(msf.trim());
  if (!m) return null;
  const frames = Number(m[3]);
  if (frames >= CD_FRAMES_PER_SEC) return null;
  return Number(m[1]) * 60 * CD_FRAMES_PER_SEC + Number(m[2]) * CD_FRAMES_PER_SEC + frames;
}

// ── Layout ──────────────────────────────────────────────────────────────────

export interface TrackLayout {
  /** 1-based, as printed on the sleeve. */
  number: number;
  trackId: string;
  title: string;
  /** Where the pause before the track begins.  Absent when there is no pause. */
  index0Frames?: number;
  /** Where the music begins — "the start of track N". */
  index1Frames: number;
  /** One frame past the track's last frame. */
  endFrames: number;
  /** Music only, not counting the pause before it. */
  durationFrames: number;
}

export interface AlbumLayout {
  tracks: TrackLayout[];
  /** Total programme length including the lead-in and every gap. */
  totalFrames: number;
}

/**
 * Where every track sits on the disc.
 *
 * The lead-in comes first and belongs to no track.  After that each track's
 * pause (if any) is INDEX 00 and its music is INDEX 01, and the next track
 * starts where this one's music ends.
 */
export function albumLayout(album: Album): AlbumLayout {
  let cursor = secToFrames(album.leadInSec);
  const tracks: TrackLayout[] = album.tracks.map((track, i) => {
    const gap = secToFrames(track.gapBeforeSec);
    // Track 1's silence IS the lead-in; charging it a gap as well would put
    // four seconds before the first note when the user asked for two.
    const pause = i === 0 ? 0 : gap;
    const index0 = pause > 0 ? cursor : undefined;
    const index1 = cursor + pause;
    const duration = secToFrames(track.durationSec);
    const end = index1 + duration;
    cursor = end;
    const out: TrackLayout = {
      number: i + 1,
      trackId: track.id,
      title: track.title,
      index1Frames: index1,
      endFrames: end,
      durationFrames: duration,
    };
    if (index0 !== undefined) out.index0Frames = index0;
    return out;
  });
  return { tracks, totalFrames: cursor };
}

// ── Red Book validation ─────────────────────────────────────────────────────

export type ProblemLevel = 'error' | 'warning';

export interface AlbumProblem {
  level: ProblemLevel;
  /** 1-based track number, or null for a problem with the disc as a whole. */
  track: number | null;
  message: string;
}

/** ISRC is 12 characters: 2 letters, 3 alphanumerics, 2 digits, 5 digits. */
export function isValidIsrc(isrc: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/.test(normaliseIsrc(isrc));
}

/** Strip the hyphens people type and upper-case it. */
export function normaliseIsrc(isrc: string): string {
  return isrc.replace(/[\s-]/g, '').toUpperCase();
}

/** UPC-A is 12 digits, EAN-13 is 13.  Both are accepted on a disc. */
export function isValidUpc(upc: string): boolean {
  return /^\d{12}$|^\d{13}$/.test(upc.replace(/[\s-]/g, ''));
}

/**
 * Everything wrong with the album, worst first.
 *
 * ERRORS are things a plant will reject.  WARNINGS are things that are legal
 * but that somebody usually meant differently — a missing ISRC does not stop
 * the disc being pressed, it stops the track being counted by anyone.
 */
export function validateAlbum(album: Album): AlbumProblem[] {
  const problems: AlbumProblem[] = [];
  const layout = albumLayout(album);

  if (album.tracks.length === 0) {
    problems.push({ level: 'error', track: null, message: '트랙이 없습니다' });
    return problems;
  }
  if (album.tracks.length > MAX_CD_TRACKS) {
    problems.push({
      level: 'error', track: null,
      message: `트랙이 ${album.tracks.length}개입니다 — CD 는 ${MAX_CD_TRACKS}개까지입니다`,
    });
  }
  if (secToFrames(album.leadInSec) < secToFrames(MIN_LEAD_IN_SEC)) {
    problems.push({
      level: 'error', track: null,
      message: `첫 곡 앞 무음이 ${album.leadInSec.toFixed(2)}초입니다 — Red Book 최소 ${MIN_LEAD_IN_SEC}초`,
    });
  }
  if (layout.totalFrames > CD_CAPACITY_FRAMES_80) {
    problems.push({
      level: 'error', track: null,
      message: `전체 ${framesToMsf(layout.totalFrames)} — 80분 디스크에도 들어가지 않습니다`,
    });
  } else if (layout.totalFrames > CD_CAPACITY_FRAMES) {
    problems.push({
      level: 'warning', track: null,
      message: `전체 ${framesToMsf(layout.totalFrames)} — 74분을 넘어 80분 디스크가 필요합니다`,
    });
  }
  if (album.upc !== undefined && album.upc !== '' && !isValidUpc(album.upc)) {
    problems.push({ level: 'error', track: null, message: `UPC 형식이 아닙니다: ${album.upc}` });
  }
  if (album.title.trim() === '') {
    problems.push({ level: 'warning', track: null, message: '앨범 제목이 비어 있습니다' });
  }

  const seenIsrc = new Map<string, number>();
  album.tracks.forEach((track, i) => {
    const n = i + 1;
    if (track.durationSec < MIN_TRACK_SEC) {
      problems.push({
        level: 'error', track: n,
        message: `${track.durationSec.toFixed(2)}초 — Red Book 최소 ${MIN_TRACK_SEC}초`,
      });
    }
    if (track.title.trim() === '') {
      problems.push({ level: 'warning', track: n, message: '제목이 비어 있습니다' });
    }
    if (track.isrc !== undefined && track.isrc !== '') {
      if (!isValidIsrc(track.isrc)) {
        problems.push({ level: 'error', track: n, message: `ISRC 형식이 아닙니다: ${track.isrc}` });
      } else {
        const norm = normaliseIsrc(track.isrc);
        const first = seenIsrc.get(norm);
        if (first !== undefined) {
          problems.push({
            level: 'error', track: n,
            message: `ISRC 가 ${first}번 트랙과 같습니다 — 녹음마다 달라야 합니다`,
          });
        } else seenIsrc.set(norm, n);
      }
    } else {
      problems.push({ level: 'warning', track: n, message: 'ISRC 가 없습니다' });
    }
    if (track.gapBeforeSec < 0) {
      problems.push({ level: 'error', track: n, message: '간격이 음수입니다' });
    }
  });

  return problems.sort((a, b) =>
    (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)
    || (a.track ?? 0) - (b.track ?? 0));
}

export function hasErrors(problems: readonly AlbumProblem[]): boolean {
  return problems.some((p) => p.level === 'error');
}

// ── Editing ─────────────────────────────────────────────────────────────────

export function addAlbumTrack(album: Album, track: AlbumTrack, atIndex?: number): Album {
  const tracks = [...album.tracks];
  tracks.splice(atIndex ?? tracks.length, 0, track);
  return { ...album, tracks };
}

export function removeAlbumTrack(album: Album, trackId: string): Album {
  const tracks = album.tracks.filter((t) => t.id !== trackId);
  return tracks.length === album.tracks.length ? album : { ...album, tracks };
}

/** Move a track to a new position.  Identity when it is already there. */
export function moveAlbumTrack(album: Album, trackId: string, toIndex: number): Album {
  const from = album.tracks.findIndex((t) => t.id === trackId);
  if (from < 0) return album;
  const to = Math.max(0, Math.min(album.tracks.length - 1, toIndex));
  if (from === to) return album;
  const tracks = [...album.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved as AlbumTrack);
  return { ...album, tracks };
}

export function updateAlbumTrack(
  album: Album, trackId: string, fn: (t: AlbumTrack) => AlbumTrack,
): Album {
  let changed = false;
  const tracks = album.tracks.map((t) => {
    if (t.id !== trackId) return t;
    const next = fn(t);
    if (next !== t) changed = true;
    return next;
  });
  return changed ? { ...album, tracks } : album;
}

/** Set the same gap before every track but the first. */
export function setAllGaps(album: Album, gapSec: number): Album {
  const gap = Math.max(0, gapSec);
  return { ...album, tracks: album.tracks.map((t) => ({ ...t, gapBeforeSec: gap })) };
}

export function describeAlbum(album: Album): string {
  const layout = albumLayout(album);
  const n = album.tracks.length;
  return `${n}곡 · ${framesToMsf(layout.totalFrames)}`;
}
