// The four lanes above the tracks, and what they cost in screen height.
//
// Sections, chords, the picture and the tempo map each get a lane at the top
// of the Edit window's track scroller.  They are not tracks: they belong to
// the project, they are always there, and they sit INSIDE the vertical
// scroller — so they are the first 190 px of it whether or not the session
// has anything to put in them.
//
// Measured in the running app (dev build, eight imported stems, the window
// forced to each size with `Emulation.setDeviceMetricsOverride`):
//
//                 scroller   global lanes   left for tracks   96 px lanes shown
//   1440 × 900      658 px       190 px          468 px            4
//   1680 × 1050     808 px       190 px          618 px            6
//   1920 × 1080     838 px       190 px          648 px            6
//   2560 × 1440    1198 px       190 px         1008 px            9
//
// At the two sizes a full-screen window actually has, SIX tracks fit and the
// seventh is the one cut off — which is exactly the report this module exists
// to answer: "7개 이상의 트랙을 올리면 7개부터는 짤려서 파형이 보이지 않는다".
// The tracks were not clipped by a bug in the waveform: 190 px of the
// scroller was spent on four lanes, three of which had nothing in them.
//
// That fix then took something with it.  The `+` that adds a section
// boundary, the `뼈대` and `분석` that make the first chords, and the `+` and
// `박자` that add the first tempo and meter change are all INSIDE their own
// lane's header.  So an empty chord lane hid the only buttons that could put
// a chord in it: no chords → no lane → no buttons → no chords.  The toolbar's
// three-state toggle was the one way out, and "press the button marked G:AUTO"
// is not how anyone finds the chord track.
//
// So a lane with nothing in it is COLLAPSED to the single row that carries its
// entry point rather than removed: 26 px instead of 76 for chords, 26 instead
// of 62 for the tempo map, and the section lane is one row already.  The
// picture lane is the one with nothing to offer — every control in it needs a
// video that is loaded from elsewhere — so it still takes none.  An empty
// session spends 78 px of the 190, and the full lane comes back the moment
// there is something to show in it.
//
// So a lane shows itself when the session has something for it, and the
// project's own reasoning about the Universe strip — "on a short session it
// is a band of nothing, and screen height is the scarce thing here" — is
// applied to these four as well.  The reference DAW does not put a chord or
// a tempo track in a new project either; you add one when you need it.
//
// The heights are duplicated here from the four components that own them,
// because arithmetic about them has to be testable without mounting React.
// `global-lanes-selftest` reads the components' own constants and refuses if
// the two ever disagree.

import { sectionsOf } from './arrangement.js';
import { videoOf } from './video.js';
import { isConstantTempo, tempoMapOf } from './tempo-map.js';
import type { DawSession } from './types.js';

export type GlobalLaneId = 'section' | 'chord' | 'picture' | 'tempo';

export const GLOBAL_LANE_IDS: readonly GlobalLaneId[] = ['section', 'chord', 'picture', 'tempo'];

/**
 * What each lane takes, in the order they are stacked.
 *
 * The source of truth for each is the component's exported constant —
 * `SECTION_LANE_HEIGHT`, `CHORD_LANE_HEIGHT`, `PICTURE_LANE_HEIGHT`,
 * `TEMPO_TRACK_HEIGHT`.  A selftest holds these to those.
 */
export const GLOBAL_LANE_HEIGHTS: Readonly<Record<GlobalLaneId, number>> = {
  section: 26,
  chord: 76,
  picture: 26,
  tempo: 62,
};

export type GlobalLaneFlags = Readonly<Record<GlobalLaneId, boolean>>;

/**
 * What a lane takes when it is collapsed to the row that holds its entry
 * point.  `0` means the lane has no entry point of its own and is left out
 * entirely — the picture lane's controls all need a video, and a video is
 * loaded from the menu, not from the lane.
 *
 * The section lane's full height is already one row, so collapsing it changes
 * nothing but the name; it is listed so the arithmetic has no special case.
 */
export const GLOBAL_LANE_COLLAPSED_HEIGHTS: Readonly<Record<GlobalLaneId, number>> = {
  section: 26,
  chord: 26,
  picture: 0,
  tempo: 26,
};

/** Shown whole, shown as its entry-point row, or not built at all. */
export type GlobalLaneView = 'off' | 'collapsed' | 'full';

export type GlobalLaneViews = Readonly<Record<GlobalLaneId, GlobalLaneView>>;

/**
 * Which lanes have something in them.
 *
 * Markers count for the section lane: it is where they are shown, so a
 * session with markers and no sections still needs it.  The key counts for
 * the chord lane for the same reason — the lane's header is where the key is
 * displayed and changed.
 */
export function globalLanesWithMaterial(session: DawSession): GlobalLaneFlags {
  return {
    section: sectionsOf(session).length > 0 || session.markers.length > 0,
    chord: session.chordTrack.length > 0 || session.key !== undefined,
    picture: videoOf(session) !== null,
    tempo: !isConstantTempo(tempoMapOf(session)),
  };
}

/**
 * How to build each lane, given the user's override.
 *
 * `null` is the default: a lane with material is shown whole, and a lane
 * without it is collapsed to its entry-point row rather than removed.  `true`
 * and `false` are the user saying so, and the user wins either way — a tempo
 * map with four changes can still be put away to get the height back, and
 * `false` takes the entry-point rows with it, because a user who asks for the
 * height back has said what they want.
 *
 * This replaced `globalLanesShown`, which returned a boolean per lane.  Two
 * states could not say "keep the row that adds the first chord", which is the
 * whole of the defect it was changed for.
 */
export function globalLaneViews(
  session: DawSession, override: boolean | null,
): GlobalLaneViews {
  const material = globalLanesWithMaterial(session);
  const views: Record<GlobalLaneId, GlobalLaneView> = {
    section: 'off', chord: 'off', picture: 'off', tempo: 'off',
  };
  for (const id of GLOBAL_LANE_IDS) {
    if (override === false) continue;
    if (override === true || material[id]) views[id] = 'full';
    else if (GLOBAL_LANE_COLLAPSED_HEIGHTS[id] > 0) views[id] = 'collapsed';
  }
  return views;
}

/** What the built lanes take off the top of the scroller. */
export function globalLanesPx(views: GlobalLaneViews): number {
  let px = 0;
  for (const id of GLOBAL_LANE_IDS) {
    if (views[id] === 'full') px += GLOBAL_LANE_HEIGHTS[id];
    else if (views[id] === 'collapsed') px += GLOBAL_LANE_COLLAPSED_HEIGHTS[id];
  }
  return px;
}
