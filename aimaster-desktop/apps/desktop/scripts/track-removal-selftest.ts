/**
 * track-removal-selftest.ts — the tracks that could not be deleted.
 *
 * `session-ops.removeTrack` has existed since the session model was written,
 * covered by tests, with NO caller anywhere in the app.  Five ways to add a
 * channel — audio, instrument, Aux, VCA, duplicate — and none to take one
 * away.  The undo history even carries a label for it, `tracks-removed:
 * 트랙 삭제`, ready to describe something that could not happen.
 *
 * And it was not finished.  Measured on a folder over two tracks, BEFORE any
 * of this was written:
 *
 *     remove the FOLDER: parentId ["킥→trk-12", "스네어→trk-12"]
 *                        busesLeft ["드럼 Bus"]
 *                        stillRoutedIntoTheFoldersBus ["킥→드럼 Bus", "스네어→드럼 Bus"]
 *
 * Both children left pointing at a track that no longer existed, and the
 * folder's summing bus left behind with both of them still routed into it —
 * audio passing through a bus with no fader anywhere on screen.  The VCA and
 * group cleanup was already right; those two were not.  So wiring a delete
 * button without fixing this would have shipped the defect, not found it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addTrack, createSession, createTrack, findTrack, removeTrack, removeTracks,
} from '../src/renderer/daw/model/session-ops.js';
import { createStack } from '../src/renderer/daw/model/stacks.js';
import {
  describeRemoval, removalCost, removalTitle,
} from '../src/renderer/daw/edit/track-removal.js';
import type { DawSession, Track, TrackId } from '../src/renderer/daw/model/types.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

/** A folder over kick+snare, a VCA on bass, and a group over all three. */
function scene(): {
  session: DawSession; kick: TrackId; snare: TrackId; bass: TrackId;
  vca: TrackId; folder: TrackId; master: TrackId;
} {
  let s = createSession('probe', 48_000);
  const ids: TrackId[] = [];
  for (const name of ['킥', '스네어', '베이스']) {
    const t = createTrack(name);
    ids.push(t.id);
    s = addTrack(s, t);
  }
  const [kick, snare, bass] = ids as [TrackId, TrackId, TrackId];
  const stacked = createStack(s, '드럼', [kick, snare]);
  s = stacked.session;
  const vcaTrack = createTrack('VCA', 'vca');
  s = addTrack(s, vcaTrack);
  s = { ...s, tracks: s.tracks.map((t) => (t.id === bass ? { ...t, vcaId: vcaTrack.id } : t)) };
  s = { ...s, groups: [...s.groups, {
    id: 'g1', symbol: 'A', name: '전부', memberIds: [kick, snare, bass],
    linkEdit: true, linkMix: false, enabled: true,
  } as never] };
  const master = (s.tracks.find((t) => t.kind === 'master') as Track).id;
  return { session: s, kick, snare, bass, vca: vcaTrack.id, folder: stacked.folderId, master };
}

/** Every reference in the session that points at a track that is not there. */
function dangling(s: DawSession): Record<string, string[]> {
  const live = new Set(s.tracks.map((t) => t.id));
  const busIds = new Set(s.buses.map((b) => b.id));
  return {
    parentId: s.tracks.filter((t) => t.parentId !== null && !live.has(t.parentId))
      .map((t) => t.name),
    vcaId: s.tracks.filter((t) => t.vcaId !== null && !live.has(t.vcaId)).map((t) => t.name),
    groupMembers: s.groups.flatMap((g) => g.memberIds.filter((m) => !live.has(m))),
    output: s.tracks.filter((t) => t.output.kind === 'bus' && !busIds.has(t.output.busId))
      .map((t) => t.name),
    input: s.tracks.filter((t) => t.input !== null && !busIds.has(t.input)).map((t) => t.name),
    sends: s.tracks.filter((t) => t.sends.some((x) => !busIds.has(x.target))).map((t) => t.name),
    sidechain: s.tracks.filter((t) => t.inserts.some((i) =>
      i.sidechainSource !== null && !busIds.has(i.sidechainSource))).map((t) => t.name),
  };
}
const clean = (s: DawSession): boolean =>
  Object.values(dangling(s)).every((list) => list.length === 0);

// ── 1. The three references that were already handled ───────────────────────

{
  const { session, bass, vca } = scene();
  const after = removeTrack(session, bass);
  // `findTrack` answers with undefined, not null.
  check('a plain track goes', findTrack(after, bass) === undefined);
  check('and leaves nothing pointing at it', clean(after), JSON.stringify(dangling(after)));
  check('a group drops the member it lost',
    after.groups[0]?.memberIds.includes(bass) === false);

  const noVca = removeTrack(session, vca);
  check('removing a VCA frees the channels it controlled',
    findTrack(noVca, bass)?.vcaId === null);
}

// ── 2. The two that were not ────────────────────────────────────────────────

{
  const { session, folder, kick, snare } = scene();
  const after = removeTrack(session, folder);
  check('a folder goes', findTrack(after, folder) === undefined);
  // The first half of the measured defect.
  check('its children are not orphaned',
    dangling(after)['parentId']?.length === 0,
    `still pointing at it: ${dangling(after)['parentId']?.join(', ')}`);
  // NOT compared against the folder's own parentId: the folder here is
  // top-level, so that is null, and `parentId: null` would pass while
  // orphaning every child of a nested stack.  The nested case below is the
  // one that can tell the difference.
  check('they are promoted to where the folder was',
    findTrack(after, kick)?.parentId === null);
  check('and they are still here — deleting a stack is not deleting its takes',
    findTrack(after, kick) !== undefined && findTrack(after, snare) !== undefined);
  // The second half, and the worse one: audio through a bus with no fader.
  check('the summing bus goes with it',
    after.buses.length === session.buses.length - 1,
    `${session.buses.length} → ${after.buses.length}`);
  check('and nothing is left routed into it', clean(after), JSON.stringify(dangling(after)));
  check('the children come back to the master',
    findTrack(after, kick)?.output.kind === 'master');
}

{
  // A stack inside a stack.  Removing the inner one must hand its children to
  // the OUTER folder, not to the top level: a break that wrote `parentId:
  // null` passed every check above, because the only folder they used was
  // top-level and null is what it should have been anyway.
  const { session, kick, snare, bass } = scene();
  const inner = createStack(session, '킥 레이어', [kick, snare]);
  const outer = createStack(inner.session, '드럼 전체', [inner.folderId, bass]);
  const s2 = outer.session;
  check('the nested stack is built', findTrack(s2, inner.folderId)?.parentId === outer.folderId,
    String(findTrack(s2, inner.folderId)?.parentId));

  const after = removeTrack(s2, inner.folderId);
  check('removing an inner stack hands its children to the outer one',
    findTrack(after, kick)?.parentId === outer.folderId,
    `킥 landed at ${String(findTrack(after, kick)?.parentId)}, wanted ${outer.folderId}`);
  check('and leaves nothing dangling', clean(after), JSON.stringify(dangling(after)));
}

// ── 3. The master ───────────────────────────────────────────────────────────

{
  const { session, master } = scene();
  check('the master is refused', removeTrack(session, master) === session);
  const many = removeTracks(session, [master, session.tracks[0]!.id]);
  check('and refused inside a selection, without blocking the rest',
    findTrack(many, master) !== undefined && many.tracks.length === session.tracks.length - 1);
}

// ── 4. Several at once ──────────────────────────────────────────────────────

{
  const { session, kick, snare, bass } = scene();
  const after = removeTracks(session, [kick, snare, bass]);
  check('a selection goes together', after.tracks.length === session.tracks.length - 3);
  check('and leaves the session consistent', clean(after), JSON.stringify(dangling(after)));
}

{
  // Folder AND its children selected: the whole stack really goes, and the
  // ORDER IT WAS CLICKED IN must not change the result.  A first version of
  // this compared track counts, which are equal under any order even when the
  // sessions differ — so the break that reversed the order went uncaught.
  // The whole session is compared now.
  const { session, folder, kick, snare } = scene();
  const a = removeTracks(session, [folder, kick, snare]);
  const b = removeTracks(session, [snare, kick, folder]);
  check('a folder and its children go whichever order they were picked in',
    JSON.stringify(a) === JSON.stringify(b) && a.tracks.length === session.tracks.length - 3,
    `${a.tracks.length} vs ${b.tracks.length}`);
  check('and that leaves nothing dangling either', clean(a) && clean(b));

  // Only the folder and ONE of its children: the other must still be promoted
  // correctly no matter which of the two went first.
  const c = removeTracks(session, [folder, kick]);
  const d = removeTracks(session, [kick, folder]);
  check('a partly-selected stack is order-independent too',
    JSON.stringify(c) === JSON.stringify(d),
    'the two orders left different sessions');
  check('and the child that stayed is on the master',
    findTrack(c, snare)?.output.kind === 'master' && clean(c));
}

{
  const { session, kick } = scene();
  check('the same id twice removes one track',
    removeTracks(session, [kick, kick]).tracks.length === session.tracks.length - 1);
  check('an empty selection changes nothing',
    removeTracks(session, []).tracks.length === session.tracks.length);
  check('an id that is not there changes nothing',
    removeTrack(session, 'trk-nope' as TrackId) === session);
}

{
  // Measured: dropping a folder's bus while cleaning only the OUTPUTS left an
  // Aux reading a bus that was not there, one dangling send and one dangling
  // sidechain.  `removeBus` already knew all four; this is why removeTrack
  // asks it rather than repeating one of them.
  const { session, folder, bass } = scene();
  const bus = findTrack(session, folder)!.input as string;
  const aux = createTrack('드럼 Aux', 'aux');
  let s = addTrack(session, { ...aux, input: bus });
  s = {
    ...s,
    tracks: s.tracks.map((t) => (t.id !== bass ? t : {
      ...t,
      sends: [{ id: 'sn1', slot: 0, target: bus, levelDb: -6, pan: 0,
                preFader: false, mute: false }],
      inserts: [{ id: 'i1', slot: 0, pluginId: 'comp', label: 'C', bypass: false,
                  latencySamples: 0, sidechainSource: bus, params: {} }],
    } as Track)),
  };
  const after = removeTrack(s, folder);
  const live = new Set(after.buses.map((b) => b.id));
  check('the Aux that read the folder bus is not left reading nothing',
    findTrack(after, aux.id)?.input === null,
    String(findTrack(after, aux.id)?.input));
  check('a send into it goes',
    findTrack(after, bass)?.sends.every((x) => live.has(x.target)) === true);
  check('a sidechain off it is unhooked',
    findTrack(after, bass)?.inserts[0]?.sidechainSource === null,
    String(findTrack(after, bass)?.inserts[0]?.sidechainSource));
  check('and the whole session is consistent', clean(after), JSON.stringify(dangling(after)));
}

// ── 5. Saying what it costs ─────────────────────────────────────────────────

{
  const { session, folder, kick, bass, master } = scene();
  const cost = removalCost(session, [folder]);
  check('a folder reports the children it will NOT take',
    cost.promoted.length === 2, JSON.stringify(cost.promoted));
  check('and the bus it will', cost.buses.length === 1, JSON.stringify(cost.buses));
  const worded = describeRemoval(cost);
  check('the wording says the children survive',
    worded.includes('남습니다'), worded);

  const bassCost = removalCost(session, [bass]);
  check('a track in a group says so', bassCost.groups.length === 1);
  check('and a track under a VCA is counted from the other side',
    removalCost(session, [session.tracks.find((t) => t.kind === 'vca')!.id])
      .freedFromVca.includes('베이스'));

  // Zero counts are noise; the one number that matters gets lost in them.
  check('an empty track does not list four zeroes',
    describeRemoval(removalCost(session, [kick])).includes('비어 있는 트랙입니다'),
    describeRemoval(removalCost(session, [kick])));

  const masterCost = removalCost(session, [master]);
  check('asking for the master costs nothing and says why',
    masterCost.names.length === 0 && describeRemoval(masterCost).includes('마스터'),
    describeRemoval(masterCost));

  check('one track is named in the title',
    removalTitle(removalCost(session, [bass])) === '베이스 삭제할까요?',
    removalTitle(removalCost(session, [bass])));
  const three = removalTitle(removalCost(session, session.tracks.slice(0, 3).map((t) => t.id)));
  check('several are counted in the title', /트랙 \d+개 삭제할까요\?/.test(three), three);
}

{
  // Clips on an ALTERNATE playlist are still a recording somebody made.
  const { session, kick } = scene();
  const withTake = {
    ...session,
    tracks: session.tracks.map((t) => (t.id !== kick ? t : {
      ...t,
      playlists: [
        { ...t.playlists[0]!, clips: [{ id: 'c1' } as never] },
        { ...t.playlists[0]!, id: 'pl-2', clips: [{ id: 'c2' } as never, { id: 'c3' } as never] },
      ],
    })),
  };
  check('clips on every take are counted, not just the active one',
    removalCost(withTake, [kick]).clips === 3,
    String(removalCost(withTake, [kick]).clips));
}

// ── 6. The route that did not exist ─────────────────────────────────────────

const edit = stripComments(read('src/renderer/components/daw/edit/EditWindow.tsx'));
const mix = stripComments(read('src/renderer/components/daw/mix/MixWindow.tsx'));
const glue = stripComments(read('src/renderer/ui/delete-tracks.ts'));
const commands = stripComments(read('src/renderer/shortcuts/daw-commands.ts'));
const defs = stripComments(read('src/renderer/shortcuts/definitions.ts'));
const app = stripComments(read('src/renderer/App.tsx'));

check('the arrangement has a delete', /deleteTracks\(\[row\.track\.id\]\)/.test(edit));
check('and not on the master', /kind === 'master' \? null :/.test(edit));
check('the console has one too', /deleteTracks\(\[track\.id\]\)/.test(mix));
check('a key reaches it',
  /id: 'daw\.deleteTracks'/.test(defs) && /'daw\.deleteTracks':\s*\(\)\s*=>/.test(commands));
check('the key takes the whole selection', /deleteTracks\(targetTrackIds\(\)\)/.test(commands));

check('it asks before it deletes', /askConfirm\(/.test(glue));
check('the question carries the cost',
  /removalTitle\(/.test(glue) && /describeRemoval\(/.test(glue));
check('and it goes through apply, so Mod+Z brings it back',
  /\.apply\(\(s\) => removeTracks\(/.test(glue));
check('the confirm dialog is mounted',
  /import\s+ConfirmDialog\s+from/.test(app) && /<ConfirmDialog\s*\/>/.test(app));

// The reason this file exists.  `removeTracks` is what the app calls;
// `removeTrack` is live because that calls it, which is exactly how the
// dead-export ratchet judges liveness — so both are checked at their own
// level rather than one vouching for the other.
check('removeTracks is reachable from the app', /\bremoveTracks\(/.test(glue),
  'implemented and tested, with no route to it');
const ops = stripComments(read('src/renderer/daw/model/session-ops.ts'));
check('and removeTracks is what reaches removeTrack',
  /removeTracks[\s\S]*?\bremoveTrack\(/.test(ops),
  'removeTracks does not call removeTrack');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
