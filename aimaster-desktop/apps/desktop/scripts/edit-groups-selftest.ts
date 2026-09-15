/**
 * edit-groups-selftest.ts — eight drum tracks that cut as one.
 *
 * The mixer half of a group already worked: linked faders, mutes, solos,
 * moved relatively so the balance survives.  This is the half that matters
 * after a stem split — selecting a phrase on the snare and having the kick,
 * the overheads and the room selected with it.
 *
 * The design is one hook: the SELECTION is widened where it is stored, so
 * every verb downstream follows the group without knowing groups exist.  So
 * the thing to test hardest is that widening — what it includes, what it
 * refuses to include, and that it does not touch a session with no groups.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:edit-groups
 */

import {
  anyEditGroups, describeGroup, editGroupsOf, editMembers, expandSelection,
  linkedClips, linksEdit, moveClipWithGroup,
} from '../src/renderer/daw/edit/edit-groups.js';
import {
  addGroup, addTrack, createClip, createGroup, createSession, createTrack,
  findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, GroupDef, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

/** Kick, snare, overhead, plus a vocal that is NOT in the group. */
function kit(over: Partial<GroupDef> = {}): {
  session: DawSession; ids: Record<string, TrackId>; group: GroupDef;
} {
  resetIds();
  let s = createSession('kit', 48_000);
  for (const name of ['Kick', 'Snare', 'OH', 'Vox']) s = addTrack(s, createTrack(name, 'audio'));
  const byName = (n: string): TrackId => s.tracks.find((t) => t.name === n)!.id;
  const ids = { kick: byName('Kick'), snare: byName('Snare'), oh: byName('OH'), vox: byName('Vox') };
  for (const id of Object.values(ids)) {
    s = updateClips(s, id, () => [
      createClip('f', 'a', { startSec: 0, offsetSec: 0, durationSec: 4 }),
      createClip('f', 'b', { startSec: 8, offsetSec: 0, durationSec: 4 }),
    ]);
  }
  const group: GroupDef = {
    ...createGroup('Drums', 'a', [ids.kick, ids.snare, ids.oh]),
    linkEdit: true,
    ...over,
  };
  return { session: addGroup(s, group), ids, group };
}

const sel = (trackIds: TrackId[], startSec = 1, endSec = 3) => ({ startSec, endSec, trackIds });

// ── Which groups link editing ────────────────────────────────────────────────

check('a group made by a track template does NOT link editing', () => {
  // Every group that exists today links faders.  Switching those to move
  // audio because a new field defaulted to true would rewrite sessions on
  // load — the sort of change nobody notices until a cut lands on four
  // tracks that were only ever meant to share a fader.
  const plain = createGroup('Busses', 'a', ['t1', 't2']);
  assert(plain.linkEdit === undefined, 'no field on an old group');
  assert(!linksEdit(plain), 'and absent reads as off');
});

check('a disabled group links nothing, even with the flag on', () => {
  const { session, ids } = kit({ enabled: false });
  assert(!anyEditGroups(session), 'suspended');
  assert(editMembers(session, ids.kick).length === 1, 'just itself');
});

// ── Widening the selection ───────────────────────────────────────────────────

check('selecting one member selects the whole group', () => {
  const { session, ids } = kit();
  const out = expandSelection(session, sel([ids.snare]));
  assert(out.trackIds.length === 3, `${out.trackIds.length} tracks`);
  assert(out.trackIds.includes(ids.kick) && out.trackIds.includes(ids.oh), 'kick and OH came along');
  assert(!out.trackIds.includes(ids.vox), 'the vocal did not');
});

check('the time range is untouched — only the tracks widen', () => {
  const { session, ids } = kit();
  const out = expandSelection(session, sel([ids.snare], 1.25, 2.75));
  near(out.startSec, 1.25, 1e-9, 'start');
  near(out.endSec, 2.75, 1e-9, 'end');
});

check('the widened list is in the session’s track order', () => {
  // So a grouped selection reads top-to-bottom like the arrangement, and two
  // selections covering the same tracks compare equal.
  const { session, ids } = kit();
  const fromSnare = expandSelection(session, sel([ids.snare])).trackIds;
  const fromOh = expandSelection(session, sel([ids.oh])).trackIds;
  assert(JSON.stringify(fromSnare) === JSON.stringify(fromOh), `${fromSnare} vs ${fromOh}`);
  assert(fromSnare[0] === ids.kick, 'kick is the top row');
});

check('a selection already covering the group is returned unchanged', () => {
  // Identity matters: setSelection runs on every mousemove of a drag, and a
  // new array each time is a re-render each time.
  const { session, ids } = kit();
  const once = expandSelection(session, sel([ids.kick]));
  assert(expandSelection(session, once) === once, 'the same object back');
});

check('a session with no edit groups is left completely alone', () => {
  const { session, ids } = kit({ linkEdit: false });
  const input = sel([ids.snare]);
  assert(expandSelection(session, input) === input, 'the same object back');
});

check('an empty selection stays empty', () => {
  const { session } = kit();
  const input = sel([]);
  assert(expandSelection(session, input) === input, 'nothing to widen');
});

check('membership does not chain through a shared track', () => {
  // Kick+Snare in one group, Snare+Vox in another: editing the kick must not
  // reach the vocal.  The alternative joins the whole session together the
  // first time someone is careless with a group.
  const { session, ids } = kit();
  const two = addGroup(session, {
    ...createGroup('Pair', 'b', [ids.snare, ids.vox]), linkEdit: true,
  });
  const out = expandSelection(two, sel([ids.kick])).trackIds;
  assert(!out.includes(ids.vox), `the vocal was pulled in: ${out.length} tracks`);
  // But selecting the shared track pulls in both groups.
  const both = expandSelection(two, sel([ids.snare])).trackIds;
  assert(both.length === 4, `both groups, got ${both.length}`);
});

// ── Dragging a clip ──────────────────────────────────────────────────────────

check('a grouped clip drags the whole group by the SAME distance', () => {
  const { session, ids } = kit();
  const kick = trackClips(findTrack(session, ids.kick)!)[0]!;
  const after = moveClipWithGroup(session, ids.kick, kick.id, 2);
  for (const id of [ids.kick, ids.snare, ids.oh]) {
    near(trackClips(findTrack(after, id)!)[0]!.startSec, 2, 1e-9, `${id} moved`);
  }
});

check('the group keeps its internal offsets — it is a distance, not a place', () => {
  // Eight tracks of one take are not aligned to the sample.  A snare hit a
  // few milliseconds behind the kick IS the performance; snapping everyone
  // to one position flattens the thing the group exists to preserve.
  const { session, ids } = kit();
  const nudged = updateClips(session, ids.snare, (clips) =>
    clips.map((c, i) => (i === 0 ? { ...c, startSec: 0.02 } : c)));
  const kick = trackClips(findTrack(nudged, ids.kick)!)[0]!;
  const after = moveClipWithGroup(nudged, ids.kick, kick.id, 5);
  near(trackClips(findTrack(after, ids.kick)!)[0]!.startSec, 5, 1e-9, 'kick');
  near(trackClips(findTrack(after, ids.snare)!)[0]!.startSec, 5.02, 1e-9, 'snare kept its 20 ms');
});

check('only the clips that overlap in time come along', () => {
  const { session, ids } = kit();
  const kick = trackClips(findTrack(session, ids.kick)!)[0]!;   // 0–4 s
  const after = moveClipWithGroup(session, ids.kick, kick.id, 2);
  // The second clip on each member sits at 8 s and shares no time with it.
  near(trackClips(findTrack(after, ids.snare)!)[1]!.startSec, 8, 1e-9, 'left where it was');
});

check('a clip on an ungrouped track never moves', () => {
  const { session, ids } = kit();
  const kick = trackClips(findTrack(session, ids.kick)!)[0]!;
  const after = moveClipWithGroup(session, ids.kick, kick.id, 3);
  near(trackClips(findTrack(after, ids.vox)!)[0]!.startSec, 0, 1e-9, 'the vocal stayed');
});

check('dragging to where it already is changes nothing', () => {
  const { session, ids } = kit();
  const kick = trackClips(findTrack(session, ids.kick)!)[0]!;
  assert(moveClipWithGroup(session, ids.kick, kick.id, kick.startSec) === session, 'same session');
});

check('a drag to before zero is held at zero, and the group is not dragged past it', () => {
  const { session, ids } = kit();
  const kick = trackClips(findTrack(session, ids.kick)!)[0]!;
  const after = moveClipWithGroup(session, ids.kick, kick.id, -5);
  for (const id of [ids.kick, ids.snare]) {
    assert(trackClips(findTrack(after, id)!)[0]!.startSec >= 0, `${id} went negative`);
  }
});

// ── What it says ─────────────────────────────────────────────────────────────

check('the group names itself and its size', () => {
  const { group } = kit();
  assert(describeGroup(group).includes('Drums'), describeGroup(group));
  assert(describeGroup(group).includes('3'), describeGroup(group));
});

check('editGroupsOf finds only the enabled, edit-linked ones', () => {
  const { session, ids } = kit();
  assert(editGroupsOf(session, ids.kick).length === 1, 'the drum group');
  assert(editGroupsOf(session, ids.vox).length === 0, 'the vocal is in none');
});

check('linkedClips reports the partners without moving anything', () => {
  const { session, ids } = kit();
  const kick = trackClips(findTrack(session, ids.kick)!)[0]!;
  const partners = linkedClips(session, ids.kick, kick);
  assert(partners.length === 2, `snare and OH, got ${partners.length}`);
  assert(!partners.some((p) => p.trackId === ids.kick), 'never itself');
  assert(!partners.some((p) => p.trackId === ids.vox), 'never the ungrouped track');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Edit groups ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
