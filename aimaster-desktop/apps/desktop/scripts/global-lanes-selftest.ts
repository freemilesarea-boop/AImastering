/**
 * global-lanes-selftest — the seven-track report, as arithmetic.
 *
 * The report: "7개 이상의 트랙을 올리면 7개부터는 UX 에서 짤려서 오디오 파형이
 * 보이지 않는다".  Measured in the running app with eight imported stems and
 * the window forced to each size:
 *
 *                 scroller   global lanes   track room   96 px lanes shown
 *   1440 × 900      658 px       190 px        468 px           4
 *   1680 × 1050     808 px       190 px        618 px           6
 *   1920 × 1080     838 px       190 px        648 px           6
 *
 * Six fit, the seventh is cut — on a session whose section, chord and picture
 * lanes were all EMPTY and whose tempo never changed.  The waveform was not
 * what was broken: the lanes were off the bottom of the scroller, and the
 * rows past the window are not even built.  190 px of the scroller was being
 * spent on four lanes with nothing in them.
 *
 * After, on the same sizes with the same session: 6 / 8 / 8.  The lanes come
 * back the moment the session has a section, a chord, a picture or a tempo
 * change, and the toolbar's G: button overrules that in either direction.
 *
 * This file holds the maths that decides it, and holds the heights in
 * `global-lanes.ts` to the four components that actually render them — a
 * duplicated constant that drifts is how arithmetic comes to describe a
 * layout that is not on screen.
 */
export {};

import { readFileSync } from 'node:fs';

import {
  GLOBAL_LANE_HEIGHTS, GLOBAL_LANE_IDS, globalLanesPx, globalLanesShown,
  globalLanesWithMaterial, type GlobalLaneId,
} from '../src/renderer/daw/model/global-lanes.js';
import {
  DEFAULT_TRACK_HEIGHT, MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT, heightToFit,
} from '../src/renderer/daw/model/track-header.js';
import { createSession } from '../src/renderer/daw/model/session-ops.js';
import { makeChord } from '../src/renderer/daw/model/chords.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const read = (f: string): string => readFileSync(f, 'utf8');

console.log('\n=== The four lanes above the tracks ===\n');

// ── The heights are the components' own ──────────────────────────────────
{
  const sources: Record<GlobalLaneId, [string, string]> = {
    section: ['src/renderer/components/daw/edit/SectionLane.tsx', 'SECTION_LANE_HEIGHT'],
    chord:   ['src/renderer/components/daw/edit/ChordLane.tsx',   'CHORD_LANE_HEIGHT'],
    picture: ['src/renderer/components/daw/edit/PictureLane.tsx', 'PICTURE_LANE_HEIGHT'],
    tempo:   ['src/renderer/components/daw/edit/TempoTrack.tsx',  'TEMPO_TRACK_HEIGHT'],
  };
  const wrong: string[] = [];
  const seen: string[] = [];
  for (const id of GLOBAL_LANE_IDS) {
    const [file, name] = sources[id];
    const m = new RegExp(`export const ${name} = (\\d+)`).exec(read(file));
    const px = m ? Number(m[1]) : NaN;
    seen.push(`${id}=${String(px)}`);
    if (px !== GLOBAL_LANE_HEIGHTS[id]) {
      wrong.push(`${name} is ${String(px)}, global-lanes says ${GLOBAL_LANE_HEIGHTS[id]}`);
    }
  }
  check(
    'each height is the one its component exports',
    wrong.length === 0,
    wrong.length === 0 ? seen.join(', ') : wrong.join('; '),
  );
  check(
    'and together they are the 190 px the measurement found',
    globalLanesPx({ section: true, chord: true, picture: true, tempo: true }) === 190,
    `${globalLanesPx({ section: true, chord: true, picture: true, tempo: true })} px`,
  );
}

// ── A lane shows itself when it has something to show ────────────────────
{
  const empty = createSession('empty');
  const flags = globalLanesWithMaterial(empty);
  check(
    'a new session gives all 190 px to the tracks',
    GLOBAL_LANE_IDS.every((id) => flags[id] === false) && globalLanesPx(flags) === 0,
    GLOBAL_LANE_IDS.map((id) => `${id}=${String(flags[id])}`).join(' '),
  );
}
{
  const withSection: DawSession = {
    ...createSession('s'),
    sections: [{ id: 'sec1', name: 'Verse', kind: 'verse', startSec: 0 }],
  };
  const withChord: DawSession = {
    ...createSession('c'),
    chordTrack: [{ id: 'c1', timeSec: 0, chord: makeChord(0) }],
  };
  const a = globalLanesWithMaterial(withSection);
  const b = globalLanesWithMaterial(withChord);
  check(
    'a section brings back its lane, and only its lane',
    a.section === true && a.chord === false && a.picture === false && a.tempo === false
      && globalLanesPx(a) === GLOBAL_LANE_HEIGHTS.section,
    `${globalLanesPx(a)} px for a session with one section`,
  );
  check(
    'and a chord brings back its own, which is the tall one',
    b.chord === true && b.section === false && globalLanesPx(b) === GLOBAL_LANE_HEIGHTS.chord,
    `${globalLanesPx(b)} px for a session with one chord`,
  );
}
{
  const marked: DawSession = {
    ...createSession('m'),
    markers: [{ id: 'm1', name: 'A', timeSec: 4 }],
  };
  check(
    'markers count as material for the lane that shows them',
    globalLanesWithMaterial(marked).section === true,
    'a session with a marker and no sections still gets the section lane',
  );
}

// ── The user overrules it, in either direction ───────────────────────────
{
  const rich: DawSession = {
    ...createSession('r'),
    sections: [{ id: 'sec1', name: 'Verse', kind: 'verse', startSec: 0 }],
  };
  const off = globalLanesShown(rich, false);
  const on = globalLanesShown(createSession('e'), true);
  check(
    'OFF puts away a lane that has something in it',
    globalLanesPx(off) === 0,
    `a session with a section, G:OFF → ${globalLanesPx(off)} px`,
  );
  check(
    'ON brings back all four on a session with nothing in any of them',
    globalLanesPx(on) === 190,
    `empty session, G:ON → ${globalLanesPx(on)} px`,
  );
  check(
    'AUTO is neither of those — it asks the session',
    globalLanesPx(globalLanesShown(rich, null)) === GLOBAL_LANE_HEIGHTS.section,
    `${globalLanesPx(globalLanesShown(rich, null))} px`,
  );
}

// ── The number the report was about ──────────────────────────────────────
//
// This division is the test's own, not the product's: nothing in the app
// asks "how many lanes fit", it just lays them out and the ones past the
// bottom are not built.  What holds the app to these numbers is the app
// smoke, which forces the window to 1920×1080, imports eight stems and
// COUNTS the lanes inside the scroller.  The arithmetic is here so the two
// columns of that table have somewhere to live and a change to the heights
// moves them.
function lanesThatFit(scrollerPx: number, globalPx: number, trackHeightPx: number): number {
  return Math.max(0, Math.floor((scrollerPx - globalPx) / trackHeightPx));
}
{
  // The three scroller heights measured in the running app.
  const MEASURED: ReadonlyArray<[string, number]> = [
    ['1440×900', 658], ['1680×1050', 808], ['1920×1080', 838],
  ];
  const before = MEASURED.map(([, px]) => lanesThatFit(px, 190, 96));
  const after = MEASURED.map(([, px]) => lanesThatFit(px, 0, 96));
  check(
    'with the four empty lanes, 1680 and 1920 cut the SEVENTH track',
    before[1] === 6 && before[2] === 6,
    MEASURED.map(([n], i) => `${n}: ${before[i]}`).join(', '),
  );
  check(
    'without them, both show eight — the reported track and the one after it',
    after[1] === 8 && after[2] === 8 && after[0] === 6,
    MEASURED.map(([n], i) => `${n}: ${after[i]}`).join(', '),
  );
}

// ── Fitting the tracks to the window ─────────────────────────────────────
{
  // What the app measured after pressing FIT at 1920×1080: nine rows, an
  // 838 px scroller, no global lanes — 93 px a track and no scrollbar.
  const px = heightToFit(9, 838, 0);
  check(
    'FIT gives nine rows the height the app measured',
    px === 93 && px * 9 <= 838,
    `${px} px × 9 = ${px * 9} px in an 838 px scroller`,
  );
  check(
    'what the global lanes take is taken off the top first',
    heightToFit(9, 838, 190) === 72,
    `9 rows, 838 px, 190 px of lanes → ${heightToFit(9, 838, 190)} px`,
  );
  check(
    'thirty tracks in a short window get the smallest legible lane, not a sliver',
    heightToFit(30, 400, 0) === MIN_TRACK_HEIGHT,
    `30 rows in 400 px → ${heightToFit(30, 400, 0)} px (floor ${MIN_TRACK_HEIGHT})`,
  );
  check(
    'and one track in a tall window does not grow past the ceiling',
    heightToFit(1, 2000, 0) === MAX_TRACK_HEIGHT,
    `1 row in 2000 px → ${heightToFit(1, 2000, 0)} px (ceiling ${MAX_TRACK_HEIGHT})`,
  );
  check(
    'an unmeasured scroller does not resize anything to nothing',
    heightToFit(0, 838, 0) === DEFAULT_TRACK_HEIGHT
      && heightToFit(9, NaN, 0) === DEFAULT_TRACK_HEIGHT,
    `→ ${DEFAULT_TRACK_HEIGHT} px, the default`,
  );
}

// ── The window is still built from both columns at once ──────────────────
{
  const edit = read('src/renderer/components/daw/edit/EditWindow.tsx');
  const pairs = GLOBAL_LANE_IDS.map((id) => {
    const uses = edit.split(`globalLanes.${id} &&`).length - 1;
    return `${id}×${uses}`;
  });
  const bothColumns = GLOBAL_LANE_IDS.every(
    (id) => edit.split(`globalLanes.${id} &&`).length - 1 === 2);
  check(
    'every lane is gated in BOTH columns — headers and lanes are one list',
    bothColumns,
    pairs.join(', '),
  );
  check(
    'the row window is measured inside the scroller, not from a positioned ancestor',
    /rowsTop\.current\?\.offsetTop \?\? 0\) - el\.offsetTop/.test(edit),
    'offsetTop alone read 288 px where the rows began at 190',
  );
  check(
    'and it is re-measured when a global lane appears or disappears',
    /\}, \[globalPx\]\);/.test(edit),
    'the rows’ origin moves with them',
  );
  check(
    'FIT asks for the height rather than naming one',
    /heightToFit\(rows\.length, rowPort\.height, globalPx \+ automationPx\)/.test(edit),
    'the button computes from what the scroller measured',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
