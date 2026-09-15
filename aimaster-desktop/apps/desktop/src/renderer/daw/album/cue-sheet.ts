// cue-sheet.ts — the album's layout as a file a plant or a burner can read.
//
// A cue sheet is the public, text half of what a DDP carries: the track order,
// the index points, the codes.  It is accepted by every disc-burning tool and
// by many replication plants, and unlike DDP its format is documented in the
// open, which means this module can be written correctly rather than
// approximately.  See the note at the bottom about DDP.
//
// The rules that bite:
//
//   • Positions are MM:SS:FF at 75 frames per second, measured from the START
//     OF THE FILE, not from the track.  A cue sheet describing one image file
//     therefore counts straight through, gaps included.
//   • Quoted strings must have their quotes escaped, and a cue sheet has no
//     escape character — so the only safe thing is to remove them.  A title
//     containing a quote silently truncates the field in most parsers, which
//     is how an album ends up with a track called `He Said `.
//   • ISRC goes inside the TRACK block; the album's UPC goes at the top as
//     CATALOG, before any FILE line.

import {
  albumLayout, framesToMsf, normaliseIsrc,
  type Album, type AlbumLayout,
} from './album.js';

export interface CueOptions {
  /** The audio file the sheet points at, as it will sit next to the .cue. */
  imageFileName: string;
  /** WAVE for a .wav image, MP3/AIFF for the others. */
  fileType?: 'WAVE' | 'MP3' | 'AIFF' | 'BINARY';
  /** Written as a REM line, so the sheet says what made it. */
  comment?: string;
}

/**
 * Strip what a cue sheet cannot carry.
 *
 * Quotes end the field, and newlines end the line — both silently truncate in
 * every parser rather than erroring, so they are removed here where the damage
 * is visible instead of at the plant where it is not.
 */
export function cueSafe(text: string): string {
  return text.replace(/["\r\n]/g, '').trim();
}

/** One `KEY "value"` line, or nothing at all when the value is empty. */
function quoted(indent: string, key: string, value: string | undefined): string[] {
  const clean = cueSafe(value ?? '');
  return clean === '' ? [] : [`${indent}${key} "${clean}"`];
}

/**
 * The album as a cue sheet.
 *
 * One FILE line for the whole image: this describes a single continuous album
 * render, which is what the PQ layout in `albumLayout` also describes.  A
 * track-per-file cue sheet is a different document for a different job.
 */
export function toCueSheet(album: Album, options: CueOptions): string {
  const layout = albumLayout(album);
  const lines: string[] = [];

  if (options.comment) lines.push(`REM ${cueSafe(options.comment)}`);
  lines.push(`REM 총 ${framesToMsf(layout.totalFrames)} · ${album.tracks.length}곡`);

  const upc = (album.upc ?? '').replace(/[\s-]/g, '');
  if (upc !== '') lines.push(`CATALOG ${upc}`);
  lines.push(...quoted('', 'PERFORMER', album.performer));
  lines.push(...quoted('', 'TITLE', album.title));
  lines.push(`FILE "${cueSafe(options.imageFileName)}" ${options.fileType ?? 'WAVE'}`);

  album.tracks.forEach((track, i) => {
    const at = layout.tracks[i];
    if (!at) return;
    lines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`);
    lines.push(...quoted('    ', 'TITLE', track.title));
    lines.push(...quoted('    ', 'PERFORMER', track.performer || album.performer));
    const isrc = normaliseIsrc(track.isrc ?? '');
    if (isrc !== '') lines.push(`    ISRC ${isrc}`);
    // INDEX 00 only when there is a pause to point at.  Writing 00 equal to 01
    // is legal but means "a zero-length pause", which some players show as a
    // countdown that never counts.
    if (at.index0Frames !== undefined) {
      lines.push(`    INDEX 00 ${framesToMsf(at.index0Frames)}`);
    }
    lines.push(`    INDEX 01 ${framesToMsf(at.index1Frames)}`);
  });

  return `${lines.join('\n')}\n`;
}

// ── PQ log ──────────────────────────────────────────────────────────────────

/**
 * The PQ sheet: what a mastering engineer sends with the master.
 *
 * Plain text on purpose.  Its readers are a person at a plant and a person at
 * a label, and both of them want to check the start times against the artwork
 * without opening anything.
 */
export function toPqLog(album: Album, extra: { levels?: string } = {}): string {
  const layout: AlbumLayout = albumLayout(album);
  const pad = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s.padEnd(n);

  const head = [
    `ALBUM      ${cueSafe(album.title)}`,
    `ARTIST     ${cueSafe(album.performer)}`,
    ...(album.upc ? [`UPC        ${album.upc.replace(/[\s-]/g, '')}`] : []),
    `TRACKS     ${album.tracks.length}`,
    `TOTAL      ${framesToMsf(layout.totalFrames)}`,
    ...(extra.levels ? [`LEVELS     ${extra.levels}`] : []),
    '',
    `${pad('TR', 3)} ${pad('START', 9)} ${pad('PAUSE', 9)} ${pad('LENGTH', 9)} ${pad('ISRC', 13)} TITLE`,
    '-'.repeat(78),
  ];

  const rows = album.tracks.map((track, i) => {
    const at = layout.tracks[i];
    if (!at) return '';
    const pause = at.index0Frames === undefined
      ? '        -'
      : pad(framesToMsf(at.index1Frames - at.index0Frames), 9);
    return `${pad(String(i + 1).padStart(2, '0'), 3)} `
      + `${pad(framesToMsf(at.index1Frames), 9)} `
      + `${pause} `
      + `${pad(framesToMsf(at.durationFrames), 9)} `
      + `${pad(normaliseIsrc(track.isrc ?? '') || '-', 13)} `
      + cueSafe(track.title);
  });

  return `${[...head, ...rows].join('\n')}\n`;
}

// ── DDP ─────────────────────────────────────────────────────────────────────
//
// Deliberately not written here.
//
// DDP 2.00 is a proprietary specification (DCA Inc.), and its files are fixed
// -offset binary records: DDPID, DDPMS, PQDESCR and the audio image.  Every
// field's position matters, and a fileset with one field in the wrong place is
// not obviously broken — it is accepted by some tools and rejected at the
// plant, or worse, pressed wrong.
//
// Writing those byte layouts from memory would produce something that LOOKS
// like a DDP.  For a delivery format whose whole purpose is that the plant can
// trust it, "looks like" is the one thing it must not be.  The PQ data this
// module already computes is exactly what a DDP writer needs, so adding one is
// a small job once the actual specification is at hand — and it should be
// checked against a reference fileset before anyone ships with it.
