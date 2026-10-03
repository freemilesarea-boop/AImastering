/**
 * track-placement-selftest — where a new track lands.
 *
 * Every user-facing way of adding a track appended to the END: the toolbar's
 * + 트랙, + Aux and + VCA, the new-track shortcut, the instrument rack's add
 * slot, the step sequencer's drum track and the template panel.  `addTrack`
 * has taken an insertion index all along — the stem separator passes one, so
 * four separated stems land under the track they came from — and none of the
 * six paths did.  On a thirty-track session every add meant scrolling to the
 * bottom and dragging the row back up.
 *
 * So the decision lives in one place now (`insertIndex` on the store, over
 * `indexAfterTracks` in the model) and the paths ask it rather than each
 * deciding.  That is also what this file can check: the arithmetic as a
 * function, the store action as behaviour, and — because a seventh path could
 * be added tomorrow and forget — a sweep of the call sites.
 *
 * Run:  pnpm --filter @aimaster/desktop test:track-placement
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { useDawStore } from '../src/renderer/stores/dawStore.js';
import {
  addTrack, createSession, createTrack, indexAfterTracks,
} from '../src/renderer/daw/model/session-ops.js';
import { applyTrackTemplate, captureTrackTemplate } from '../src/renderer/daw/model/track-template.js';
import { duplicateTrack } from '../src/renderer/daw/edit/track-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Four named tracks and a master, in order. */
function session(): { session: DawSession; ids: TrackId[] } {
  resetIds();
  let s = createSession('placement', 48_000);
  const ids: TrackId[] = [];
  for (let i = 0; i < 4; i += 1) {
    const tr = createTrack(`T${i}`, 'audio');
    s = addTrack(s, tr);
    ids.push(tr.id);
  }
  return { session: s, ids };
}
const names = (s: DawSession): string => s.tracks.map((t) => t.name).join(',');

check('nothing selected means the end, which is what addTrack already did', () => {
  const { session: s } = session();
  assert(indexAfterTracks(s, []) === undefined, 'empty selection');
  assert(indexAfterTracks(s, ['nope' as TrackId]) === undefined, 'an id from another session');
});

check('one track selected means the row under it', () => {
  const { session: s, ids } = session();
  assert(indexAfterTracks(s, [ids[1]!]) === 2, `after the second track — got ${indexAfterTracks(s, [ids[1]!])}`);
  assert(indexAfterTracks(s, [ids[3]!]) === 4, 'after the last one');
});

check('a multi-selection means under the LAST of it, not into the middle', () => {
  // Select three drum tracks, add a fourth: it belongs under the group.
  const { session: s, ids } = session();
  assert(indexAfterTracks(s, [ids[0]!, ids[1]!, ids[2]!]) === 3, 'after the third');
  // Order of the ids must not matter — a selection is a set.
  assert(indexAfterTracks(s, [ids[2]!, ids[0]!, ids[1]!]) === 3, 'whatever order they arrive in');
});

check('the master is never a neighbour to insert after', () => {
  // It is always the last row, and `addTrack` clamps above it; treating it as
  // a neighbour would mean "after the master", which is a place that does not
  // exist.
  const { session: s } = session();
  const master = s.tracks.find((t) => t.kind === 'master')!;
  assert(indexAfterTracks(s, [master.id]) === undefined, 'the master alone means the end');
});

check('the toolbar and the shortcut put the track under the selection', () => {
  const { session: s, ids } = session();
  const store = useDawStore.getState();
  store.apply(() => s);
  store.setSelectedTracks([ids[1]!]);
  useDawStore.getState().addTrackHere('audio');
  assert(names(useDawStore.getState().session) === 'T0,T1,Audio 5,T2,T3,Master',
    `got ${names(useDawStore.getState().session)}`);
});

check('the new row becomes the selection, so the next add lands under it', () => {
  const { session: s, ids } = session();
  const store = useDawStore.getState();
  store.apply(() => s);
  store.setSelectedTracks([ids[1]!]);
  useDawStore.getState().addTrackHere('audio');
  useDawStore.getState().addTrackHere('audio');
  // Two adds in a row read downwards, not inside out.
  assert(names(useDawStore.getState().session) === 'T0,T1,Audio 5,Audio 6,T2,T3,Master',
    `got ${names(useDawStore.getState().session)}`);
});

check('an aux brings its bus, a VCA its routing, and both land in place', () => {
  const { session: s, ids } = session();
  const store = useDawStore.getState();
  store.apply(() => s);
  store.setSelectedTracks([ids[0]!]);
  useDawStore.getState().addTrackHere('aux');
  const afterAux = useDawStore.getState().session;
  assert(names(afterAux) === 'T0,Aux 1,T1,T2,T3,Master', `aux: ${names(afterAux)}`);
  const aux = afterAux.tracks.find((t) => t.kind === 'aux')!;
  assert(aux.input !== null && afterAux.buses.some((b) => b.id === aux.input),
    'the aux reads from a bus that exists');

  store.setSelectedTracks([ids[2]!]);
  useDawStore.getState().addTrackHere('vca');
  const afterVca = useDawStore.getState().session;
  assert(names(afterVca) === 'T0,Aux 1,T1,T2,VCA 1,T3,Master', `vca: ${names(afterVca)}`);
  assert(afterVca.tracks.find((t) => t.kind === 'vca')!.output.kind === 'none',
    'a VCA drives faders rather than carrying audio');
});

check('a template of several tracks keeps their order where it is inserted', () => {
  // Inserting them all at the same index is the obvious thing and it lays
  // them out backwards, because each insert pushes the previous one down —
  // which is exactly what the stem separator had to fix.
  const { session: s, ids } = session();
  const captured = captureTrackTemplate(s, ids[0]!, 'Vox');
  assert(captured !== null && captured.template !== null, 'a template was captured');
  const out = applyTrackTemplate(
    s, captured!.template!, { count: 3, atIndex: 2, trackName: 'Vox' });
  assert(names(out.session) === 'T0,T1,Vox,Vox 2,Vox 3,T2,T3,Master', `got ${names(out.session)}`);
});

check('a new audio track is numbered by the audio tracks, not by the row count', () => {
  // `Audio ${tracks.length}` counted the master and every aux and VCA, so a
  // second audio track in a session with a few buses came out "Audio 6".
  resetIds();
  const store = useDawStore.getState();
  store.apply(() => createSession('numbering', 48_000));
  store.setSelectedTracks([]);
  useDawStore.getState().addTrackHere('aux');
  useDawStore.getState().addTrackHere('audio');
  useDawStore.getState().addTrackHere('audio');
  const got = useDawStore.getState().session.tracks.map((t) => t.name).join(',');
  assert(got === 'Aux 1,Audio 1,Audio 2,Master', `got ${got}`);
});

check('a duplicated track lands under the one it was copied from', () => {
  // This one was already right, by appending and then splicing the row back
  // up: the sweep below flagged it for not passing an index, and the check
  // here is what settled that the behaviour was not the problem.  It passes
  // on both versions, which is why it is worth keeping — it is the thing the
  // simplification had to preserve.
  const { session: s, ids } = session();
  const out = duplicateTrack(s, ids[1]!);
  // The copy's name comes from `nextTrackName`, which numbers the base: the
  // check here is the ROW it lands on.
  assert(names(out) === 'T0,T1,T 2,T2,T3,Master', `got ${names(out)}`);
});

check('every add-track path asks where to put it', () => {
  // A seventh path could be added tomorrow and forget, which is how all six
  // of these came to append.  The import paths are listed because an import
  // is a batch of files the user picked, not a place they pointed at.
  const allowed = new Map<string, string>([
    ['src/renderer/daw/edit/session-import.ts', 'an import is a batch, and lands at the end'],
    ['src/renderer/daw/io/interchange.ts', 'same: an interchange file brings its own order'],
    ['src/renderer/daw/edit/video-audio.ts', 'the extracted audio follows the video it came from'],
    ['src/renderer/daw/edit/region-live.ts', 'a utility aux for one region, not a row the user asked for'],
    ['src/renderer/daw/model/stacks.ts', 'a folder goes above its members, which it works out itself'],
    ['src/renderer/daw/model/track-template.ts', 'this is the function that takes the index'],
    ['src/renderer/daw/model/instrument-rack.ts', 'same: it passes the index it is given'],
    ['src/renderer/daw/model/import-audio.ts', 'an import is a batch, and lands at the end'],
    ['src/renderer/daw/model/session-ops.ts', 'the definition'],
    ['src/renderer/daw/edit/separate-actions.ts', 'the one caller that already placed its tracks'],
    ['src/renderer/stores/dawStore.ts', 'the action every path goes through'],
  ]);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(path.join(DESKTOP, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.stories.tsx')) out.push(rel);
    }
    return out;
  };
  const bare: string[] = [];
  for (const file of walk('src/renderer')) {
    if (allowed.has(file)) continue;
    const text = fs.readFileSync(path.join(DESKTOP, file), 'utf8');
    for (const call of text.match(/addTrack\([^;]*?\)/gs) ?? []) {
      if (call.startsWith('addTrack(') && call.split(',').length < 3) bare.push(`${file}: ${call.slice(0, 60)}`);
    }
  }
  assert(bare.length === 0, `an add-track call with no placement — ${bare.join('; ')}`);
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
