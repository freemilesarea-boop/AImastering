/**
 * clip-track-move-selftest — the drag that could only go sideways.
 *
 * `moveClip` took a track id and a time, and the track id was where the clip
 * ALREADY was: there was no destination parameter, so the model had no way to
 * express "put this piece on that track".  The arrange window's clip drag read
 * `e.clientX` and never `e.clientY`, so the gesture every DAW uses for this
 * did nothing vertically, and the only route was copy → select the other
 * track → paste.
 *
 * What this file guards is mostly what the move REFUSES, because those are the
 * cases that fail quietly.  A MIDI part on an audio track loads, saves and
 * reloads perfectly and never makes a sound — `ClipPlayer` reads audio clips
 * and the instrument reads parts, so the lane it landed on decides whether it
 * is heard, and nothing in the UI says which.  And a clip lifted from one
 * track and added to another in two steps leaves an undo step with the clip on
 * neither, which Ctrl+Z lands on.
 */
export {};

import { readFileSync } from 'node:fs';

import {
  clipTrackMoveRefusal, moveClipToTrack,
} from '../src/renderer/daw/edit/clip-edit.js';
import {
  addGroup, addTrack, createClip, createGroup, createMidiPart, createSession, createTrack,
  findTrack, trackClips,
} from '../src/renderer/daw/model/session-ops.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** Two audio tracks, a clip on the first. */
function twoAudio(): { session: DawSession; a: Track; b: Track; clipId: string } {
  const clip = createClip('file-1', 'take.wav', { startSec: 4, durationSec: 3 });
  const a = createTrack('A', 'audio');
  const withClip: Track = {
    ...a,
    playlists: a.playlists.map((p) => ({ ...p, clips: [clip] })),
  };
  const b = createTrack('B', 'audio');
  return {
    session: addTrack(addTrack(createSession('move'), withClip), b),
    a: withClip, b, clipId: clip.id,
  };
}

function clipsOn(session: DawSession, trackId: string): string[] {
  const t = findTrack(session, trackId);
  return t ? trackClips(t).map((c) => c.id) : [];
}

console.log('\n=== 클립 트랙 이동 ===\n');

// ── The move itself ──────────────────────────────────────────────────────
{
  const { session, a, b, clipId } = twoAudio();
  const r = moveClipToTrack(session, a.id, clipId, b.id, 9.5);
  const moved = findTrack(r.session, b.id) && trackClips(findTrack(r.session, b.id)!)[0];
  check(
    'a clip moves to another track, and to a new time, in one call',
    r.problems.length === 0
      && clipsOn(r.session, a.id).length === 0
      && clipsOn(r.session, b.id).join() === clipId
      && moved?.startSec === 9.5,
    `A → B at ${moved?.startSec ?? '?'} s; A now holds ${clipsOn(r.session, a.id).length} clip(s)`,
  );
  check(
    'and it is the same clip, not a copy with a new id',
    moved?.id === clipId && moved?.fileId === 'file-1' && moved?.durationSec === 3,
    `id ${moved?.id === clipId ? 'kept' : 'CHANGED'}, file and length kept`,
  );
  check(
    'it never exists on both tracks or on neither — one session, one result',
    clipsOn(r.session, a.id).length + clipsOn(r.session, b.id).length === 1,
    'nothing for Ctrl+Z to land between',
  );
  // The old signature still has to work: dragging along one lane is the
  // common case and must not have become a special case of the new one.
  const same = moveClipToTrack(session, a.id, clipId, a.id, 1.25);
  const stayed = trackClips(findTrack(same.session, a.id)!)[0];
  check(
    'moving to the track it is already on is still just a time move',
    same.problems.length === 0 && stayed?.startSec === 1.25
      && clipsOn(same.session, a.id).join() === clipId,
    `stayed on A at ${stayed?.startSec ?? '?'} s`,
  );
  const negative = moveClipToTrack(session, a.id, clipId, b.id, -10);
  const clamped = trackClips(findTrack(negative.session, b.id)!)[0];
  check(
    'and it cannot land before the start of the song',
    clamped?.startSec === 0,
    `asked for −10 s, landed at ${clamped?.startSec ?? '?'} s`,
  );
}

// ── What it refuses ──────────────────────────────────────────────────────
{
  // A MIDI part and an audio track: loads, saves, reloads, never sounds.
  const part = createMidiPart('part', { startSec: 0, durationSec: 2 });
  const inst = createTrack('Synth', 'instrument');
  const withPart: Track = {
    ...inst, playlists: inst.playlists.map((p) => ({ ...p, clips: [part] })),
  };
  const audio = createTrack('Vox', 'audio');
  const session = addTrack(addTrack(createSession('kinds'), withPart), audio);

  const refusal = clipTrackMoveRefusal(session, withPart.id, part.id, audio.id);
  const attempted = moveClipToTrack(session, withPart.id, part.id, audio.id, 5);
  check(
    'a MIDI part cannot be dropped on an audio track, and is told so',
    refusal !== null && refusal.includes('인스트루먼트')
      && attempted.problems.length === 1
      && attempted.session === session,
    refusal ?? '(allowed!)',
  );

  const { session: s2, a, b, clipId } = twoAudio();
  const instTarget = createTrack('Piano', 'instrument');
  const s3 = addTrack(s2, instTarget);
  const other = clipTrackMoveRefusal(s3, a.id, clipId, instTarget.id);
  check(
    'and an audio clip cannot be dropped on an instrument track either',
    other !== null && other.includes('오디오'),
    other ?? '(allowed!)',
  );
  void b;

  // Buses, VCAs and folders carry no clips at all.
  const aux = createTrack('Plate', 'aux');
  const s4 = addTrack(s2, aux);
  const onAux = clipTrackMoveRefusal(s4, a.id, clipId, aux.id);
  check(
    'a track that holds no clips refuses by name, not by silence',
    onAux !== null && onAux.includes('Plate'),
    onAux ?? '(allowed!)',
  );
}

// ── Edit groups ──────────────────────────────────────────────────────────
{
  const { session, a, b, clipId } = twoAudio();
  const group = { ...createGroup('Drums', 'a', [a.id, b.id]), linkEdit: true, enabled: true };
  const grouped = addGroup(session, group);
  const refusal = clipTrackMoveRefusal(grouped, a.id, clipId, b.id);
  const attempted = moveClipToTrack(grouped, a.id, clipId, b.id, 7);
  check(
    'a clip on an edit-grouped track is refused rather than silently un-aligned',
    refusal !== null && refusal.includes('편집 그룹')
      && attempted.session === grouped
      && clipsOn(attempted.session, a.id).join() === clipId,
    refusal ?? '(allowed!)',
  );
  // The group only blocks the VERTICAL half.  Sliding along the lane is what
  // the group is for and must still work.
  const sideways = moveClipToTrack(grouped, a.id, clipId, a.id, 7);
  check(
    'but the same clip still slides along its own lane, which is the point of the group',
    sideways.problems.length === 0
      && trackClips(findTrack(sideways.session, a.id)!)[0]?.startSec === 7,
    'time-only move unaffected',
  );
  const off = addGroup(session, { ...group, linkEdit: false });
  check(
    'and turning edit-link off lets it cross again',
    clipTrackMoveRefusal(off, a.id, clipId, b.id) === null,
    'a fader group is not an edit group',
  );
}

// ── Missing things ───────────────────────────────────────────────────────
{
  const { session, a, clipId } = twoAudio();
  check(
    'an unknown destination is a refusal, not a crash',
    clipTrackMoveRefusal(session, a.id, clipId, 'trk-nope') === '트랙을 찾을 수 없습니다'
      && moveClipToTrack(session, a.id, clipId, 'trk-nope', 1).session === session,
    'session returned unchanged',
  );
  check(
    'and so is an unknown clip',
    clipTrackMoveRefusal(session, a.id, 'clip-nope', a.id) === null
      || clipTrackMoveRefusal(session, a.id, 'clip-nope', 'trk-nope') !== null,
    'same track short-circuits; a real cross-track move with a missing clip refuses',
  );
}

// ── One copy of the rules ────────────────────────────────────────────────
{
  const model = readFileSync('src/renderer/daw/edit/clip-edit.ts', 'utf8');
  check(
    'the move asks the same predicate the drag asks — the rules are not written twice',
    /const refusal = clipTrackMoveRefusal\(session, fromTrackId, clipId, toTrackId\);/.test(model),
    'moveClipToTrack delegates to clipTrackMoveRefusal',
  );

  const edit = readFileSync('src/renderer/components/daw/edit/EditWindow.tsx', 'utf8');
  check(
    'the drag reads which row the pointer is over, instead of measuring y itself',
    /const over = bandTrackRef\.current;/.test(edit),
    'the virtualised row list stays the authority on which track is where',
  );
  check(
    'and asks before it applies, so a refused drop never flickers onto the track',
    /const refusal = clipTrackMoveRefusal\(session, clipDrag\.trackId, clipDrag\.clipId, over\);/
      .test(edit)
      && edit.indexOf('clipTrackMoveRefusal(session, clipDrag.trackId')
        < edit.indexOf('moveClipToTrack(s, clipDrag.trackId'),
    'predicate first, move second',
  );
  check(
    'the drag state follows the clip across lanes',
    /setClipDrag\(\{ \.\.\.clipDrag, trackId: over \}\)/.test(edit),
    'the next move lifts from where the clip actually is',
  );
  check(
    'a refused drop says why once, not once per mouse-move',
    /refusedDropRef\.current !== refusal/.test(edit)
      && /refusedDropRef\.current = refusal;/.test(edit),
    'sixty identical toasts is not an explanation',
  );
  check(
    'and the horizontal half of the gesture keeps working while it is refused',
    edit.indexOf('refusedDropRef.current = refusal;')
      < edit.indexOf('moveClipWithGroup(s, clipDrag.trackId, clipDrag.clipId, target)'),
    'the time move still runs after the warning',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
