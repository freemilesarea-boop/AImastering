// Moving the arrangement when the tempo map moves under it.
//
// A tempo edit used to replace the map and touch nothing else, so everything
// stored in seconds kept its SECOND and changed its BAR.  Measured, all
// written on bar lines at 120 bpm: slowing the song to 100 bpm put a part, a
// clip and a chord written on bar 5 at 4|2, and a marker and an automation
// point written on bar 9 at 7|3.  At 100 bpm the part's 8.00 s is beat 13.33 —
// not even on a beat.  Undo brings it back; nothing else does.
//
// ── Why here and not in the schema ──────────────────────────────────────────
//
// The honest fix is to store musical positions in beats, which is what notes
// already do (`model/midi.ts`).  For everything else it is 458 uses of
// `.startSec` across 92 files, and a migration for every session ever saved.
// The conversion is exact without any of that:
//
//     newSec = beatToSec(newMap, secToBeat(oldMap, oldSec))
//
// and a tempo edit lands in exactly one function, which has both maps.
//
// ── What moves and what does not ────────────────────────────────────────────
//
// These are not new rules.  `setSessionTempo`, at the bottom of this file, has
// had them since the single-BPM transport field was written — it lived in
// `model/warp.ts` and scaled everything by the tempo ratio.  What it did not
// have was the tempo MAP, and two holes came with that; its own comment has
// the measurements.  Both paths share one set of rules now.
//
// Moves, because it is a musical position: every clip's start (audio as well
// as MIDI — a bar 5 downbeat is a bar 5 downbeat whatever is on it),
// automation points, markers, chord events, section starts.
//
// Does NOT move:
//
//   · `offsetSec` and the `original` block — those are positions in the SOURCE
//     file's own time, and the source does not know about the session's tempo
//   · fades on a clip whose length did not change — a 20 ms click removal is
//     20 ms at any tempo.  On a clip that DID stretch they scale with it, since
//     there the fade is a fraction of a musical length
//   · an unwarped audio clip's LENGTH.  Its start follows the bar and its
//     duration does not, so tempo changes open gaps and overlaps between
//     audio clips.  That is what every DAW does and it is the honest answer:
//     the audio is as long as it is.  A clip warped with `followTempo` does
//     keep its musical length, because warping is what makes that possible.
//   · patterns — a `Pattern` carries its own `baseBpm`, so its length is
//     already relative to the tempo it was written at
//   · the video reference — picture is wall-clock, and moving it to a bar line
//     would slide the film under the music
//   · per-note and per-lane expression curves inside a part, which are already
//     in beats

import {
  beatToSec, clampBpm, normaliseTempoMap, secToBeat, tempoMapOf,
  withTempoMapKeepingSeconds,
} from './tempo-map.js';
import { clipWarp } from './warp.js';
import type {
  AutomationLane, Clip, DawSession, Marker, TempoMap, Track,
} from './types.js';
import type { ChordEvent } from './chords.js';

/**
 * Do two maps place beats at different seconds?
 *
 * A meter change does not — meters number the bars and never move a beat — so
 * changing 4/4 to 3/4 must not re-time anything.  Comparing the tempo events
 * says that exactly, and skipping the conversion keeps a meter edit free of
 * the float noise a round trip through two maps would leave.
 */
export function tempiDiffer(a: TempoMap, b: TempoMap): boolean {
  if (a.tempos.length !== b.tempos.length) return true;
  for (let i = 0; i < a.tempos.length; i++) {
    const x = a.tempos[i]!;
    const y = b.tempos[i]!;
    if (x.beat !== y.beat || x.bpm !== y.bpm || x.curve !== y.curve) return true;
  }
  return false;
}

/** Whether a clip's LENGTH is musical, or just as long as its audio is. */
function lengthIsMusical(clip: Clip): boolean {
  if (clip.kind === 'midi') return true;
  const warp = clipWarp(clip);
  return warp !== null && warp.followTempo;
}

/**
 * Set the tempo map and carry the arrangement with it.
 *
 * This is what a tempo edit wants.  The one exception is a caller that has
 * ALREADY moved the content itself — ripple insert and delete move every
 * position in seconds and then hand over a map with beats inserted — and that
 * one calls `withTempoMapKeepingSeconds` instead.
 */
export function withTempoMap(session: DawSession, map: TempoMap): DawSession {
  const from = tempoMapOf(session);
  const set = withTempoMapKeepingSeconds(session, map);
  const to = tempoMapOf(set);
  if (!tempiDiffer(from, to)) return set;

  const at = (sec: number): number => beatToSec(to, secToBeat(from, sec));

  const moveClip = (clip: Clip): Clip => {
    const startSec = at(clip.startSec);
    if (!lengthIsMusical(clip)) return { ...clip, startSec };
    const durationSec = at(clip.startSec + clip.durationSec) - startSec;
    // The fades go with the length: a fade is a fraction of a clip that
    // stretched, not a fixed number of milliseconds like a click removal on
    // audio that did not.
    const scale = clip.durationSec > 0 ? durationSec / clip.durationSec : 1;
    return {
      ...clip, startSec, durationSec,
      fadeIn: { ...clip.fadeIn, durationSec: clip.fadeIn.durationSec * scale },
      fadeOut: { ...clip.fadeOut, durationSec: clip.fadeOut.durationSec * scale },
    };
  };
  const moveLane = (lane: AutomationLane): AutomationLane => ({
    ...lane,
    points: lane.points.map((point) => ({ ...point, timeSec: at(point.timeSec) })),
  });
  const moveTrack = (track: Track): Track => ({
    ...track,
    playlists: track.playlists.map((playlist) => ({
      ...playlist, clips: playlist.clips.map(moveClip),
    })),
    automation: track.automation.map(moveLane),
  });

  return {
    ...set,
    tracks: set.tracks.map(moveTrack),
    markers: set.markers.map((marker): Marker => ({ ...marker, timeSec: at(marker.timeSec) })),
    chordTrack: set.chordTrack.map((event): ChordEvent => ({
      ...event, timeSec: at(event.timeSec),
    })),
    ...(set.sections
      ? { sections: set.sections.map((s) => ({ ...s, startSec: at(s.startSec) })) }
      : {}),
  };
}

// ── One tempo for the whole song ────────────────────────────────────────────

export interface TempoChangeResult {
  session: DawSession;
  /** Audio clips that could not follow because warp is off — they keep their
   *  length while everything around them moved. */
  unwarpedClipIds: string[];
}

/**
 * Set the song's tempo from a single number — the transport field, or a tempo
 * the detector measured.
 *
 * This used to live in `model/warp.ts` and scale every position by the tempo
 * ratio itself, with two measured holes.  It never moved MARKERS or SECTIONS,
 * although its own comment said "a bar 9 marker has to stay bar 9": halving the
 * tempo of a song with a marker on bar 9 left it on bar 5.  And it wrote
 * `tempoBpm` without touching the tempo MAP, so on a session that had ever had
 * a tempo event it scaled all the content and left the map behind — a clip
 * written on bar 5 came back on bar 8|3, with `tempoBpm` saying 60 and the map
 * saying 120.
 *
 * Going through the map closes both, and there is only one set of rules about
 * what follows a tempo change again instead of two that could drift.
 *
 * The whole tempo TRACK scales, rather than being flattened to `bpm`: a song
 * with a slower bridge keeps its slower bridge, and on the flat map that most
 * sessions have this is exactly "the tempo is now that".
 */
export function setSessionTempo(session: DawSession, bpm: number): TempoChangeResult {
  const from = session.tempoBpm;
  const to = Math.max(20, Math.min(300, bpm));
  if (from <= 0 || Math.abs(from - to) < 1e-9) {
    return { session: { ...session, tempoBpm: to }, unwarpedClipIds: [] };
  }
  const unwarpedClipIds = session.tracks.flatMap((track) => track.playlists.flatMap(
    (playlist) => playlist.clips
      .filter((clip) => clip.kind === 'audio' && !lengthIsMusical(clip))
      .map((clip) => clip.id)));
  const scale = to / from;
  const map = tempoMapOf(session);
  const scaled = normaliseTempoMap({
    ...map,
    tempos: map.tempos.map((event) => ({ ...event, bpm: clampBpm(event.bpm * scale) })),
  });
  return { session: withTempoMap(session, scaled), unwarpedClipIds };
}
