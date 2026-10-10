/**
 * nudge-selftest — the distance one nudge moves.
 *
 * The amount was `nudgeSec: 0.1` on the store with a setter nothing in the
 * app ever called, and the edit toolbar drew `Nudge 0.1s` as a plain span
 * beside Grid's real select.  So every nudge in the app moved exactly 100 ms,
 * for the life of the session, and 100 ms is a distance that lands on no grid
 * line at any tempo — 1/40 of a note at 60 BPM, 1/20 at 120, 1/13.8 at 174.
 * The frame-nudge command two hundred lines away even carries a comment
 * calling 41.7 ms "a number nobody would ever set the nudge to", written on
 * the assumption that the nudge could be set at all.
 *
 * It is a choice now: the grid itself (held as a choice, so a tempo change
 * carries it), one picture frame, or an absolute time.  What this file checks
 * is the arithmetic, the two things that must never disagree (the toolbar's
 * readout and the key press's distance), the refusal to substitute a number
 * when a choice cannot be honoured, and — because that is how the amount
 * went dead in the first place — that the control is actually wired.
 *
 * Run:  pnpm --filter @aimaster/desktop test:nudge
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_NUDGE, NUDGE_CHOICES, describeNudge, formatNudgeAmount,
  nudgeAmountSec, nudgeChoiceId, nudgeProblem, nudgeSettingFromId,
  type NudgeContext,
} from '../src/renderer/daw/model/nudge.js';
import { gridLabel, describeSnap } from '../src/renderer/daw/model/snap-modes.js';
import {
  addTempoEvent, defaultTempoMap, secToBeat, type TempoMap,
} from '../src/renderer/daw/model/tempo-map.js';
import { nudgeSelection } from '../src/renderer/daw/edit/clip-edit.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(got: number, want: number, m: string, tol = 1e-9): void {
  assert(Math.abs(got - want) <= tol, `${m}: ${got} vs ${want}`);
}

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => fs.readFileSync(path.join(DESKTOP, rel), 'utf8');

function ctx(over: Partial<NudgeContext> = {}): NudgeContext {
  return {
    tempoMap: defaultTempoMap(120), gridDivision: 0.25, atSec: 0, fps: null, ...over,
  };
}

// ── The arithmetic ────────────────────────────────────────────────────────────

check('the grid choice resolves to the ruler\'s own division, at the ruler\'s tempo', () => {
  // 120 BPM: a beat is 500 ms, so 1/16 is 125 ms and a bar is 2000.
  close(nudgeAmountSec({ kind: 'grid' }, ctx({ gridDivision: 0.25 }))!, 0.125, '1/16 at 120');
  close(nudgeAmountSec({ kind: 'grid' }, ctx({ gridDivision: 4 }))!, 2, '1 bar at 120');
  close(nudgeAmountSec({ kind: 'grid' }, ctx({ gridDivision: 1 / 3 }))!, 1 / 6, '1/8 triplet at 120');
  // 174 BPM: a beat is 344.8 ms.
  close(nudgeAmountSec({ kind: 'grid' }, ctx({ tempoMap: defaultTempoMap(174), gridDivision: 0.25 }))!,
    0.25 * 60 / 174, '1/16 at 174');
});

check('the old fixed 100 ms lands on no grid line the app offers', () => {
  // The measurement the whole task rests on.  If some division at some
  // sensible tempo DID come out at 100 ms, the dead value would merely have
  // been inflexible rather than unmusical.
  const divisions = [4, 2, 1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];
  let closest = Infinity;
  for (const bpm of [60, 90, 120, 174]) {
    for (const d of divisions) {
      const sec = nudgeAmountSec({ kind: 'grid' }, ctx({ tempoMap: defaultTempoMap(bpm), gridDivision: d }))!;
      closest = Math.min(closest, Math.abs(sec - 0.1) / 0.1);
    }
  }
  // Nothing comes within 15 % of 100 ms.  The nearest is 1/16T at 90 BPM
  // (111 ms), which is 11 % away and a triplet nobody edits an audio clip on.
  assert(closest > 0.1, `some division is within ${(closest * 100).toFixed(1)} % of 100 ms`);
});

check('a nudge inside a ritardando is a grid line of THAT bar', () => {
  // Measured at atSec rather than at the song start, which is the whole
  // reason the grid is kept as a choice instead of copied as a number.
  let map: TempoMap = defaultTempoMap(120);
  // Beat 8 at 120 BPM is 4 s in, so the half-speed bars start there.
  map = addTempoEvent(map, 8, 60);
  const early = nudgeAmountSec({ kind: 'grid' }, ctx({ tempoMap: map, atSec: 0, gridDivision: 1 }))!;
  const late = nudgeAmountSec({ kind: 'grid' }, ctx({ tempoMap: map, atSec: 4, gridDivision: 1 }))!;
  close(early, 0.5, 'a beat at 120');
  close(late, 1, 'a beat at 60');
  assert(late > early * 1.9, 'the slower bar nudges further');
});

check('one grid nudge moves a clip exactly one grid line', () => {
  // The promise the choice makes, checked on the beat axis rather than in
  // seconds: a clip that started on a line ends on the next one.
  resetIds();
  let s: DawSession = createSession('nudge', 48_000);
  const tr = createTrack('T', 'audio');
  s = addTrack(s, tr);
  const trackId = tr.id as TrackId;
  s = addFile(s, {
    id: 'file-a', path: '/songs/a.wav', name: 'a.wav',
    durationSec: 30, sampleRate: 48_000, channels: 2,
  });
  s = updateClips(s, trackId, () =>
    [createClip('file-a', 'a', { startSec: 1, offsetSec: 0, durationSec: 1 })]);
  const map = defaultTempoMap(120);
  const amount = nudgeAmountSec({ kind: 'grid' }, ctx({ gridDivision: 0.25, atSec: 1 }))!;
  const moved = nudgeSelection(s, { startSec: 1, endSec: 2, trackIds: [trackId] }, amount);
  const clip = trackClips(findTrack(moved, trackId)!)[0]!;
  close(secToBeat(map, clip.startSec) - secToBeat(map, 1), 0.25, 'exactly a sixteenth on the beat axis', 1e-6);
});

check('the absolute choices are the times they are named', () => {
  close(nudgeAmountSec({ kind: 'fixed', sec: 0.001 }, ctx())!, 0.001, '1ms');
  close(nudgeAmountSec({ kind: 'fixed', sec: 0.01 }, ctx())!, 0.01, '10ms');
  close(nudgeAmountSec({ kind: 'fixed', sec: 0.1 }, ctx())!, 0.1, '100ms');
  close(nudgeAmountSec({ kind: 'fixed', sec: 1 }, ctx())!, 1, '1s');
});

check('a frame is the PICTURE\'s frame, not a constant', () => {
  close(nudgeAmountSec({ kind: 'frame' }, ctx({ fps: 24 }))!, 1 / 24, '24 fps');
  close(nudgeAmountSec({ kind: 'frame' }, ctx({ fps: 25 }))!, 0.04, '25 fps');
  close(nudgeAmountSec({ kind: 'frame' }, ctx({ fps: 30000 / 1001 }))!, 1001 / 30000, '29.97 fps');
});

// ── Refusing to substitute ────────────────────────────────────────────────────

check('a frame nudge with no picture refuses, and says why', () => {
  // The alternative — falling back to some default distance — is how an edit
  // window starts feeling haunted: the key moves the clip by a number the
  // toolbar never showed.
  assert(nudgeAmountSec({ kind: 'frame' }, ctx({ fps: null })) === null, 'no amount without a picture');
  const why = nudgeProblem({ kind: 'frame' }, ctx({ fps: null }));
  assert(why !== null && why.includes('픽처'), `the complaint names the picture: ${why}`);
  assert(nudgeProblem({ kind: 'frame' }, ctx({ fps: 24 })) === null, 'with a picture there is no complaint');
});

check('a grid of zero refuses rather than moving by nothing', () => {
  assert(nudgeAmountSec({ kind: 'grid' }, ctx({ gridDivision: 0 })) === null, 'no grid, no amount');
  assert(nudgeProblem({ kind: 'grid' }, ctx({ gridDivision: 0 })) !== null, 'and it says so');
  assert(nudgeAmountSec({ kind: 'fixed', sec: 0 }, ctx()) === null, 'nor does a zero time');
});

// ── The readout and the key press cannot disagree ─────────────────────────────

check('every offered choice round-trips through the select\'s value', () => {
  // A select whose value is not among its options renders blank, and the
  // store would then hold something the user cannot see.
  for (const c of NUDGE_CHOICES) {
    assert(nudgeChoiceId(c.setting) === c.id, `${c.id} round-trips`);
    const back = nudgeSettingFromId(c.id);
    assert(back !== undefined && back.kind === c.setting.kind, `${c.id} resolves back`);
  }
  assert(nudgeSettingFromId('nonsense') === undefined, 'an unknown id is not silently a choice');
  assert(nudgeChoiceId(DEFAULT_NUDGE) === 'grid', 'the default is in the list');
});

check('a musical readout shows the time the key press will move', () => {
  const c = ctx({ gridDivision: 0.25 });
  const shown = describeNudge({ kind: 'grid' }, c);
  const moved = formatNudgeAmount(nudgeAmountSec({ kind: 'grid' }, c)!);
  assert(shown.includes(moved), `readout ${shown} carries the moved distance ${moved}`);
  assert(shown.includes('1/16'), `and names the division: ${shown}`);
  const frame = describeNudge({ kind: 'frame' }, ctx({ fps: 24 }));
  assert(frame.includes('41.67ms'), `a frame reads as its time too: ${frame}`);
  assert(describeNudge({ kind: 'fixed', sec: 0.01 }, c) === '10ms', 'an absolute choice is just itself');
});

check('the nudge names the division the snap readout names', () => {
  // One arithmetic, not two copies: `gridLabel` is shared, so the two
  // toolbar readouts cannot start calling 1/3 of a beat different things.
  for (const d of [4, 2, 1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125]) {
    const label = gridLabel(d);
    assert(describeNudge({ kind: 'grid' }, ctx({ gridDivision: d })).startsWith(label),
      `nudge uses ${label}`);
    assert(describeSnap('grid', d).includes(label), `snap uses ${label}`);
  }
  assert(gridLabel(1 / 3) === '1/12', 'an eighth triplet is a twelfth of a bar');
});

check('a distance is written to a precision you can act on', () => {
  assert(formatNudgeAmount(0.001) === '1ms', '1ms');
  assert(formatNudgeAmount(1 / 24) === '41.67ms', 'a frame keeps its fraction');
  assert(formatNudgeAmount(0.125) === '125ms', 'a sixteenth is whole milliseconds');
  assert(formatNudgeAmount(2) === '2s', 'a bar at 120 reads in seconds');
});

// ── The wiring, which is what went dead before ────────────────────────────────

check('the store holds a choice, and the default is the grid', () => {
  const store = read('src/renderer/stores/dawStore.ts');
  assert(/nudge: DEFAULT_NUDGE/.test(store), 'the store starts on the default');
  assert(/setNudge: \(nudge\) => set\(\{ nudge \}\)/.test(store), 'and has a setter');
  assert(!/nudgeSec/.test(store.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the dead seconds field is gone from the code, not just from the UI');
  assert(DEFAULT_NUDGE.kind === 'grid', 'the default is musical');
});

check('the toolbar can SET the nudge, not only draw it', () => {
  // The exact failure this task is about: a readout with no writer.
  const ui = read('src/renderer/components/daw/edit/EditWindow.tsx');
  assert(/s\.setNudge/.test(ui), 'EditWindow takes the setter from the store');
  assert(/onChange=\{\(e\) => setNudge\(/.test(ui), 'and a control calls it');
  assert(/NUDGE_CHOICES\.map/.test(ui), 'offering the whole list');
  assert(/describeNudge\(nudge, nudgeView\)/.test(ui), 'and shows the resolved distance');
});

check('both numpad commands go through the resolver', () => {
  const cmds = read('src/renderer/shortcuts/daw-commands.ts');
  assert(/'daw\.nudgeForward': \(\) => nudgeBy\(1\)/.test(cmds), 'forward');
  assert(/'daw\.nudgeBack': \(\) => nudgeBy\(-1\)/.test(cmds), 'back');
  assert(/nudgeAmountSec\(state\.nudge, ctx\)/.test(cmds), 'resolved from the choice');
  assert(/nudgeContext\(sel\.startSec\)/.test(cmds), 'at the selection start, like the readout');
  assert(/notify\(nudgeProblem\(/.test(cmds), 'and an unresolvable choice is reported, not substituted');
});

// ── Report ────────────────────────────────────────────────────────────────────

let pass = 0;
for (const r of results) {
  if (r.pass) { pass += 1; console.log(`  PASS  ${r.name}`); }
  else console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
}
console.log(`\nnudge-selftest: ${pass}/${results.length}`);
if (pass !== results.length) process.exit(1);
