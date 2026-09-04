/**
 * tier-c-selftest.ts — the pool, batch fades, saved views, mix snapshots, notes.
 *
 * What each one gets wrong if nobody watches:
 *
 *   • POOL — calling a file unused when an ALTERNATE playlist still needs it.
 *     "Delete unused" is the one button here that cannot be undone by hand, so
 *     the used/unused answer has to count every playlist, not just the live
 *     one.
 *   • BATCH FADE — a 500 ms fade asked for on a 200 ms clip.  Capping at half
 *     the clip is what stops in+out eating it whole, and 'outer' has to know
 *     which edges butt against a neighbour.
 *   • SNAPSHOTS — a snapshot that shares its insert array with the live session
 *     follows every later edit, which is exactly what a snapshot must not do.
 *   • NOTES — an empty note has to REMOVE the field, or a session that never
 *     used notes stops serialising the way it did.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:tier-c
 */

import {
  buildPool, clipsOfFile, describePool, queryPool, removeUnusedFiles, summarisePool,
} from '../src/renderer/daw/model/clip-pool.js';
import {
  DEFAULT_BATCH_FADE, MAX_BATCH_FADE_SEC, MIN_BATCH_FADE_SEC, batchFade, clampFadeSec,
  clearFades, countSelectedClips, describeBatchFade,
} from '../src/renderer/daw/edit/batch-fade.js';
import {
  MAX_LAYOUTS, ZOOM_SLOTS, clearZoom, describeLayout, describeZoom, filledZoomSlots,
  findLayout, isZoomSlot, linkedTimeline, recallZoom, removeLayout, saveLayout, storeZoom,
  type WindowLayout, type ZoomSlots,
} from '../src/renderer/daw/model/workspace-view.js';
import {
  MAX_SNAPSHOTS, describeSnapshot, diffSnapshot, pushSnapshot, removeSnapshot,
  restoreSnapshot, takeSnapshot,
} from '../src/renderer/daw/model/mix-snapshot.js';
import {
  hasNote, noteSummary, setTrackNote, trackNote, tracksWithNotes,
} from '../src/renderer/daw/model/track-header.js';
import {
  addFile, addTrack, createClip, createPlaylist, createSession, createTrack, findTrack,
  trackClips, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { AudioFileRef, DawSession, TrackId } from '../src/renderer/daw/model/types.js';

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

const file = (id: string, name: string, dur = 60): AudioFileRef =>
  ({ id, path: `/audio/${name}`, name, durationSec: dur, sampleRate: 48_000, channels: 2 });

/**
 * Vox uses f1 on its ACTIVE playlist and f2 on an alternate take.
 * Gtr uses f1 too.  f3 is in the session and nothing points at it.
 */
function session(): { session: DawSession; vox: TrackId; gtr: TrackId } {
  resetIds();
  let s = createSession('pool', 48_000);
  for (const f of [file('f1', 'vox.wav'), file('f2', 'vox-alt.wav'), file('f3', 'orphan.wav')]) {
    s = addFile(s, f);
  }
  s = addTrack(s, createTrack('Vox', 'audio'));
  s = addTrack(s, createTrack('Gtr', 'audio'));
  const vox = s.tracks.find((t) => t.name === 'Vox')!.id;
  const gtr = s.tracks.find((t) => t.name === 'Gtr')!.id;

  s = updateClips(s, vox, () => [
    createClip('f1', 'Vox A', { startSec: 0, offsetSec: 0, durationSec: 4 }),
    createClip('f1', 'Vox B', { startSec: 8, offsetSec: 10, durationSec: 4 }),
  ]);
  // A second playlist holding the alternate take.
  s = updateTrack(s, vox, (t) => ({
    ...t,
    playlists: [...t.playlists, createPlaylist('Take 2', [
      createClip('f2', 'Vox alt', { startSec: 0, offsetSec: 0, durationSec: 6 }),
    ])],
  }));
  s = updateClips(s, gtr, () => [
    createClip('f1', 'Gtr rip', { startSec: 2, offsetSec: 2, durationSec: 3 }),
  ]);
  return { session: s, vox, gtr };
}

// ── Pool ────────────────────────────────────────────────────────────────────

check('the pool counts uses across EVERY playlist, not just the live one', () => {
  const { session: s } = session();
  const pool = buildPool(s);
  const f2 = pool.find((e) => e.fileId === 'f2')!;
  assert(!f2.unused, 'the alternate take keeps its file alive');
  assert(f2.uses.length === 1, `one use, got ${f2.uses.length}`);
  assert(f2.activeUses === 0, 'and it is not on the active playlist');
});

check('a file nothing points at is unused', () => {
  const pool = buildPool(session().session);
  assert(pool.find((e) => e.fileId === 'f3')!.unused, 'orphan.wav');
  assert(!pool.find((e) => e.fileId === 'f1')!.unused, 'vox.wav is used three times');
});

check('uses list every clip, with its track and where it sits', () => {
  const pool = buildPool(session().session);
  const f1 = pool.find((e) => e.fileId === 'f1')!;
  assert(f1.uses.length === 3, `three clips, got ${f1.uses.length}`);
  assert(f1.activeUses === 3, 'all on live playlists');
  const names = f1.uses.map((u) => `${u.trackName}:${u.clipName}`).sort();
  assert(names.join(',') === 'Gtr:Gtr rip,Vox:Vox A,Vox:Vox B', names.join(','));
  // Sorted by position, so the list reads like the timeline.
  assert(f1.uses[0]!.startSec <= f1.uses[1]!.startSec, 'sorted by start');
});

check('used seconds count overlapping regions once', () => {
  // f1 is used at offsets 0-4, 10-14 and 2-5.  0-4 and 2-5 overlap into 0-5.
  const pool = buildPool(session().session);
  near(pool.find((e) => e.fileId === 'f1')!.usedSec, 5 + 4, 1e-9,
    '0-5 plus 10-14, not the 11 seconds a plain sum gives');
});

check('missing is only reported when the caller says what exists', () => {
  const { session: s } = session();
  assert(buildPool(s).every((e) => !e.missing), 'no knowledge, no accusation');
  const partial = buildPool(s, { existingPaths: new Set(['/audio/vox.wav']) });
  assert(!partial.find((e) => e.fileId === 'f1')!.missing, 'this one is there');
  assert(partial.find((e) => e.fileId === 'f3')!.missing, 'and this one is not');
});

check('search matches the file, the clip and the track name', () => {
  const pool = buildPool(session().session);
  assert(queryPool(pool, { search: 'orphan' }).length === 1, 'by file name');
  assert(queryPool(pool, { search: 'Gtr rip' }).length === 1, 'by clip name');
  assert(queryPool(pool, { search: 'gtr' })[0]!.fileId === 'f1', 'by track name, case-insensitively');
  assert(queryPool(pool, { search: 'nothing here' }).length === 0, 'and misses cleanly');
});

check('filters and sorts do what they say', () => {
  const pool = buildPool(session().session);
  assert(queryPool(pool, { filter: 'unused' }).map((e) => e.fileId).join() === 'f3', 'unused only');
  assert(queryPool(pool, { filter: 'used' }).length === 2, 'used only');
  const cleanup = queryPool(pool, { sort: 'unused-first' });
  assert(cleanup[0]!.unused, 'the ones you are about to delete come first');
  const byUses = queryPool(pool, { sort: 'uses' });
  assert(byUses[0]!.fileId === 'f1', 'the busiest file first');
});

check('removing unused files keeps the ones an alternate take needs', () => {
  const { session: s } = session();
  const cleaned = removeUnusedFiles(s);
  const ids = cleaned.files.map((f) => f.id).sort();
  assert(ids.join(',') === 'f1,f2', `f2 survives on its alternate playlist — got ${ids.join(',')}`);
  assert(removeUnusedFiles(cleaned) === cleaned, 'and a second pass is identity');
});

check('the summary adds up, and clipsOfFile finds the live clips', () => {
  const { session: s } = session();
  const sum = summarisePool(buildPool(s));
  assert(sum.files === 3 && sum.unused === 1, `${sum.files} files, ${sum.unused} unused`);
  near(sum.totalSec, 180, 1e-9, 'three 60-second files');
  near(sum.unusedSec, 60, 1e-9, 'one of them unused');
  assert(describePool(sum).includes('안 쓰는 것 1개'), describePool(sum));
  // clipsOfFile reads the ACTIVE playlist, which is what "show me" means.
  assert(clipsOfFile(s, 'f1').length === 3, 'three live clips use f1');
  assert(clipsOfFile(s, 'f2').length === 0, 'the alternate take is not on screen');
});

// ── Batch fade ──────────────────────────────────────────────────────────────

/** Four clips on one track: two butted together, two standing alone. */
function fadeBed(): { session: DawSession; id: TrackId } {
  resetIds();
  let s = createSession('fades', 48_000);
  s = addFile(s, file('f1', 'a.wav'));
  s = addTrack(s, createTrack('Comp', 'audio'));
  const id = s.tracks.find((t) => t.name === 'Comp')!.id;
  s = updateClips(s, id, () => [
    createClip('f1', 'one',   { startSec: 0,  offsetSec: 0, durationSec: 4 }),
    createClip('f1', 'two',   { startSec: 4,  offsetSec: 4, durationSec: 4 }),   // butts onto 'one'
    createClip('f1', 'three', { startSec: 12, offsetSec: 0, durationSec: 4 }),
    createClip('f1', 'tiny',  { startSec: 20, offsetSec: 0, durationSec: 0.008 }),
  ]);
  return { session: s, id };
}

check('a batch fade lands on every selected clip, both edges', () => {
  const { session: s, id } = fadeBed();
  const sel = { startSec: 0, endSec: 30, trackIds: [id] };
  assert(countSelectedClips(s, sel) === 4, 'four clips in range');
  const { session: out, summary } = batchFade(s, sel, { durationSec: 0.01, edges: 'both' });
  assert(summary.clips === 4, `${summary.clips} clips`);
  const clips = trackClips(findTrack(out, id)!);
  for (const c of clips.filter((c) => c.name !== 'tiny')) {
    near(c.fadeIn.durationSec, 0.01, 1e-9, `${c.name} fade in`);
    near(c.fadeOut.durationSec, 0.01, 1e-9, `${c.name} fade out`);
  }
});

check('a fade longer than the clip is capped at half, not refused', () => {
  const { session: s, id } = fadeBed();
  const { session: out, summary } = batchFade(s, { startSec: 0, endSec: 30, trackIds: [id] },
    { durationSec: 1, edges: 'both' });
  const tiny = trackClips(findTrack(out, id)!).find((c) => c.name === 'tiny')!;
  assert(tiny.fadeIn.durationSec <= tiny.durationSec / 2 + 1e-9,
    `in + out cannot eat the clip — ${tiny.fadeIn.durationSec} of ${tiny.durationSec}`);
  assert(tiny.fadeIn.durationSec > 0, 'but it still got one');
  assert(summary.shortened === 1, `one clip was shortened, got ${summary.shortened}`);
  assert(describeBatchFade(summary).includes('줄임'), describeBatchFade(summary));
});

check("'outer' skips the join between two butted clips", () => {
  const { session: s, id } = fadeBed();
  const { session: out } = batchFade(s, { startSec: 0, endSec: 30, trackIds: [id] },
    { durationSec: 0.01, edges: 'outer' });
  const clips = trackClips(findTrack(out, id)!);
  const one = clips.find((c) => c.name === 'one')!;
  const two = clips.find((c) => c.name === 'two')!;
  const three = clips.find((c) => c.name === 'three')!;
  assert(one.fadeIn.durationSec > 0, 'the run still fades in at its start');
  near(one.fadeOut.durationSec, 0, 1e-9, 'but not at the join');
  near(two.fadeIn.durationSec, 0, 1e-9, 'from either side of it');
  assert(two.fadeOut.durationSec > 0, 'and it fades out at the run end');
  assert(three.fadeIn.durationSec > 0 && three.fadeOut.durationSec > 0, 'a lone clip gets both');
});

check('in-only and out-only touch one edge each', () => {
  const { session: s, id } = fadeBed();
  const inOnly = batchFade(s, { startSec: 0, endSec: 10, trackIds: [id] }, { edges: 'in' }).session;
  const c = trackClips(findTrack(inOnly, id)!)[0]!;
  assert(c.fadeIn.durationSec > 0 && c.fadeOut.durationSec === 0, 'in only');
  const outOnly = batchFade(s, { startSec: 0, endSec: 10, trackIds: [id] }, { edges: 'out' }).session;
  const d = trackClips(findTrack(outOnly, id)!)[0]!;
  assert(d.fadeIn.durationSec === 0 && d.fadeOut.durationSec > 0, 'out only');
});

check('clips outside the selection are left alone', () => {
  const { session: s, id } = fadeBed();
  const { session: out, summary } = batchFade(s, { startSec: 0, endSec: 5, trackIds: [id] });
  assert(summary.clips === 2, `only the two that overlap 0-5, got ${summary.clips}`);
  const three = trackClips(findTrack(out, id)!).find((c) => c.name === 'three')!;
  near(three.fadeIn.durationSec, 0, 1e-9, 'the clip at 12 s was not touched');
});

check('clearing takes both fades off', () => {
  const { session: s, id } = fadeBed();
  const sel = { startSec: 0, endSec: 30, trackIds: [id] };
  const faded = batchFade(s, sel, { durationSec: 0.02 }).session;
  const cleared = clearFades(faded, sel);
  for (const c of trackClips(findTrack(cleared, id)!)) {
    assert(c.fadeIn.durationSec === 0 && c.fadeOut.durationSec === 0, `${c.name} is clean`);
  }
});

check('the fade length is clamped to something sane', () => {
  near(clampFadeSec(-5), MIN_BATCH_FADE_SEC, 1e-12, 'negative');
  near(clampFadeSec(1e6), MAX_BATCH_FADE_SEC, 1e-12, 'absurd');
  near(clampFadeSec(NaN), MIN_BATCH_FADE_SEC, 1e-12, 'not a number');
  assert(DEFAULT_BATCH_FADE.durationSec === 0.005, 'the default is a declick, not an effect');
});

// ── Saved views ─────────────────────────────────────────────────────────────

check('zoom slots store, recall and clear', () => {
  let slots: ZoomSlots = {};
  slots = storeZoom(slots, 2, { pxPerSec: 200, scrollSec: 12.5 });
  assert(recallZoom(slots, 2)?.pxPerSec === 200, 'stored');
  assert(recallZoom(slots, 3) === null, 'an empty slot recalls nothing');
  assert(filledZoomSlots(slots).join() === '2', 'one slot filled');
  slots = clearZoom(slots, 2);
  assert(recallZoom(slots, 2) === null, 'cleared');
  assert(clearZoom(slots, 2) === slots, 'and clearing again is identity');
});

check('a slot out of range is refused rather than silently made', () => {
  const slots = storeZoom({}, 0, { pxPerSec: 100, scrollSec: 0 });
  assert(Object.keys(slots).length === 0, 'slot 0 is not a slot');
  assert(storeZoom({}, ZOOM_SLOTS + 1, { pxPerSec: 100, scrollSec: 0 })[ZOOM_SLOTS + 1] === undefined,
    'nor is one past the end');
  assert(isZoomSlot(1) && isZoomSlot(ZOOM_SLOTS) && !isZoomSlot(ZOOM_SLOTS + 1), 'the range');
  assert(describeZoom({ pxPerSec: 200, scrollSec: 12.5 }).includes('200 px/s'), 'and it describes');
});

check('a stored view is a copy, not a live reference', () => {
  const view = { pxPerSec: 100, scrollSec: 0 };
  const slots = storeZoom({}, 1, view);
  view.pxPerSec = 999;
  assert(recallZoom(slots, 1)?.pxPerSec === 100, 'the slot kept what it was given');
});

check('saving a layout of the same name replaces it', () => {
  const mk = (name: string, w: WindowLayout['window']): WindowLayout =>
    ({ name, window: w, panels: { inspector: true } });
  let layouts = saveLayout([], mk('Mixing', 'mix'));
  layouts = saveLayout(layouts, mk('Editing', 'edit'));
  layouts = saveLayout(layouts, mk('Mixing', 'chain'));
  assert(layouts.length === 2, `two layouts, got ${layouts.length}`);
  assert(findLayout(layouts, 'Mixing')?.window === 'chain', 'and Mixing is the newer one');
  assert(saveLayout(layouts, mk('  ', 'edit')).length === 2, 'a blank name saves nothing');
  assert(removeLayout(layouts, 'Editing').length === 1, 'and removing works');
  assert(describeLayout(mk('x', 'mix')).includes('MIX'), describeLayout(mk('x', 'mix')));
});

check('the layout list is capped, oldest out', () => {
  let layouts: WindowLayout[] = [];
  for (let i = 0; i < MAX_LAYOUTS + 3; i++) {
    layouts = saveLayout(layouts, { name: `L${i}`, window: 'edit', panels: {} });
  }
  assert(layouts.length === MAX_LAYOUTS, `${layouts.length} vs ${MAX_LAYOUTS}`);
  assert(findLayout(layouts, 'L0') === null, 'the oldest went');
  assert(findLayout(layouts, `L${MAX_LAYOUTS + 2}`) !== null, 'the newest stayed');
});

check('linked selection returns null when there is nothing to do', () => {
  const edit = { startSec: 1, endSec: 3 };
  assert(linkedTimeline(false, { startSec: 0, endSec: 0 }, edit) === null, 'link off');
  assert(linkedTimeline(true, { startSec: 1, endSec: 3 }, edit) === null, 'already agreed');
  const moved = linkedTimeline(true, { startSec: 0, endSec: 0 }, edit);
  assert(moved?.startSec === 1 && moved.endSec === 3, 'and it follows when it should');
});

// ── Mix snapshots ───────────────────────────────────────────────────────────

function mixed(): { session: DawSession; vox: TrackId } {
  const { session: s, vox } = session();
  return {
    session: updateTrack(s, vox, (t) => ({
      ...t, volumeDb: -3, pan: 0.2,
      inserts: [{ id: 'ins-1', slot: 0, pluginId: 'eq', label: 'EQ', bypass: false,
                  latencySamples: 0, sidechainSource: null, params: { gain: 2 } }],
    })),
    vox,
  };
}

check('a snapshot restores the mixer it was taken from', () => {
  const { session: s, vox } = mixed();
  const snap = takeSnapshot(s, 'A', 'snap-1');
  const changed = updateTrack(s, vox, (t) => ({ ...t, volumeDb: -20, pan: -1, mute: true }));
  const { session: back, restored } = restoreSnapshot(changed, snap);
  const track = findTrack(back, vox)!;
  near(track.volumeDb, -3, 1e-9, 'the fader came back');
  near(track.pan, 0.2, 1e-9, 'and the pan');
  assert(track.mute === false, 'and the mute');
  assert(restored === s.tracks.length, `every channel restored, got ${restored}`);
});

check('a snapshot does not follow later edits', () => {
  const { session: s, vox } = mixed();
  const snap = takeSnapshot(s, 'A', 'snap-1');
  const changed = updateTrack(s, vox, (t) => ({
    ...t, inserts: [{ id: 'ins-1', slot: 0, pluginId: 'eq', label: 'EQ', bypass: false,
                      latencySamples: 0, sidechainSource: null, params: { gain: 99 } }],
  }));
  const channel = snap.channels.find((c) => c.trackId === vox)!;
  assert(channel.inserts[0]!.params['gain'] === 2, 'the snapshot kept the old value');
  const { session: back } = restoreSnapshot(changed, snap);
  assert(findTrack(back, vox)!.inserts[0]!.params['gain'] === 2, 'and restoring puts it back');
});

check('a snapshot shares no object with the session it came from', () => {
  // The test above cannot catch a shared reference, because every writer in
  // this codebase REPLACES arrays rather than mutating them — so a snapshot
  // holding the live array still reads correctly today.  The invariant is
  // isolation itself, and a snapshot is exactly the long-lived state where a
  // shared reference would silently turn the saved mix into the current one.
  const { session: s, vox } = mixed();
  const snap = takeSnapshot(s, 'A', 'snap-1');
  const track = findTrack(s, vox)!;
  const channel = snap.channels.find((c) => c.trackId === vox)!;
  assert(channel.inserts !== track.inserts, 'the insert list is a copy');
  assert(channel.inserts[0] !== track.inserts[0], 'and so is each insert');
  assert(channel.inserts[0]!.params !== track.inserts[0]!.params, 'down to its params');
  assert(channel.sends !== track.sends, 'the sends too');
  assert(channel.output !== track.output, 'and the routing');

  // And on the way back out: restoring must not hand the snapshot's own
  // arrays to the session, or editing the session would edit the snapshot.
  const { session: back } = restoreSnapshot(s, snap);
  const restored = findTrack(back, vox)!;
  assert(restored.inserts !== channel.inserts, 'restore copies out as well as in');
  assert(restored.inserts[0]!.params !== channel.inserts[0]!.params, 'params included');
});

check('a track added since the snapshot is left alone, not reset', () => {
  const { session: s } = mixed();
  const snap = takeSnapshot(s, 'A', 'snap-1');
  let later = addTrack(s, createTrack('Synth', 'audio'));
  const synth = later.tracks.find((t) => t.name === 'Synth')!.id;
  later = updateTrack(later, synth, (t) => ({ ...t, volumeDb: -8 }));
  const result = restoreSnapshot(later, snap);
  near(findTrack(result.session, synth)!.volumeDb, -8, 1e-9,
    'the snapshot never knew about it, so it does not decide for it');
  assert(result.added.join() === 'Synth', 'but it says so');
});

check('a track removed since the snapshot is reported, not resurrected', () => {
  const { session: s, vox } = mixed();
  const snap = takeSnapshot(s, 'A', 'snap-1');
  const without = { ...s, tracks: s.tracks.filter((t) => t.id !== vox) };
  const result = restoreSnapshot(without, snap);
  assert(result.session.tracks.length === without.tracks.length, 'no track came back');
  assert(result.gone.join() === 'Vox', `named: ${result.gone.join()}`);
});

check('the diff says what would change, split by kind', () => {
  const { session: s, vox } = mixed();
  const snap = takeSnapshot(s, 'A', 'snap-1');
  assert(diffSnapshot(s, snap).same, 'nothing differs from itself');
  assert(describeSnapshot(diffSnapshot(s, snap)).includes('같습니다'), 'and it says so');

  const louder = updateTrack(s, vox, (t) => ({ ...t, volumeDb: -10 }));
  const d1 = diffSnapshot(louder, snap);
  assert(d1.levels.join() === 'Vox' && d1.inserts.length === 0, 'a fader is a level difference');

  const plugged = updateTrack(s, vox, (t) => ({ ...t, inserts: [] }));
  const d2 = diffSnapshot(plugged, snap);
  assert(d2.inserts.join() === 'Vox' && d2.levels.length === 0, 'a chain is an insert difference');
  assert(describeSnapshot(d2).includes('오토메이션은 그대로'), 'and it is honest about automation');
});

check('the snapshot list is capped, oldest out', () => {
  const { session: s } = mixed();
  let snaps = [] as ReturnType<typeof takeSnapshot>[];
  for (let i = 0; i < MAX_SNAPSHOTS + 2; i++) {
    snaps = pushSnapshot(snaps, takeSnapshot(s, `S${i}`, `id-${i}`));
  }
  assert(snaps.length === MAX_SNAPSHOTS, `${snaps.length} vs ${MAX_SNAPSHOTS}`);
  assert(snaps[0]!.name === 'S2', `the oldest two went — first is ${snaps[0]!.name}`);
  assert(removeSnapshot(snaps, 'id-5').length === MAX_SNAPSHOTS - 1, 'and one can be removed');
});

// ── Track notes ─────────────────────────────────────────────────────────────

check('a note is written, read and removed', () => {
  const { session: s, vox } = session();
  assert(trackNote(findTrack(s, vox)!) === '', 'no note to start');
  assert(!hasNote(findTrack(s, vox)!), 'and hasNote agrees');

  const noted = setTrackNote(s, vox, 'U87, -4 dB pad\n1:22 breath');
  assert(hasNote(findTrack(noted, vox)!), 'written');
  assert(noteSummary(findTrack(noted, vox)!) === 'U87, -4 dB pad', 'the summary is the first line');
});

check('an empty note REMOVES the field rather than storing a blank', () => {
  const { session: s, vox } = session();
  const noted = setTrackNote(s, vox, 'something');
  const cleared = setTrackNote(noted, vox, '   ');
  assert(!('note' in (findTrack(cleared, vox) as object)),
    'the key is gone, so a session that never used notes serialises as it always did');
  assert(setTrackNote(s, vox, '') === s, 'and clearing an absent note is identity');
});

check('a long note is cut, and the same note twice is identity', () => {
  const { session: s, vox } = session();
  const long = setTrackNote(s, vox, 'x'.repeat(5000));
  assert(trackNote(findTrack(long, vox)!).length === 2000, `capped, got ${trackNote(findTrack(long, vox)!).length}`);
  assert(setTrackNote(long, vox, 'x'.repeat(2000)) === long, 'writing the same thing changes nothing');
});

check('tracksWithNotes lists only the ones carrying one', () => {
  const { session: s, vox, gtr } = session();
  const noted = setTrackNote(setTrackNote(s, vox, 'a'), gtr, 'b');
  assert(tracksWithNotes(noted).length === 2, 'both');
  assert(tracksWithNotes(s).length === 0, 'none to start');
  const summary = noteSummary({ ...findTrack(noted, vox)!, note: 'y'.repeat(200) }, 20);
  assert(summary.length === 20 && summary.endsWith('…'), `elided: ${summary}`);
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Tier C: pool, batch fades, views, snapshots, notes ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
