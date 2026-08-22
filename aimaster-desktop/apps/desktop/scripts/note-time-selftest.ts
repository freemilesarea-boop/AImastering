// MIDI notes live in beats.  This suite is about the one place that stops
// being an abstraction: where beats become the seconds the graph plays.
//
// The tests that matter here are the ones with a tempo CHANGE in them.  At a
// constant tempo, beats and seconds are the same fact scaled, and almost any
// wrong implementation passes; under a ramp they diverge, and the difference
// between "beats × secondsPerBeat" and "the distance between two points on
// the map" is the whole point of the module.

import {
  beatIntoNote, beatToTimelineSec, beatsToSecAt, noteEndSec, noteSpan,
  noteStartSec, partClock, secToBeatsAt, timelineSecToBeat,
} from '../src/renderer/daw/model/note-time.js';
import { createNote, resetNoteIds, noteEndBeat } from '../src/renderer/daw/model/midi.js';
import {
  addTempoEvent, compileTempoMap, defaultTempoMap, beatToSec, secToBeat,
} from '../src/renderer/daw/model/tempo-map.js';
import { migrateSession, needsMigration } from '../src/renderer/daw/model/session-migrate.js';
import { deserializeDawSession, serializeDawSession } from '../src/renderer/daw/model/session-io.js';
import {
  addTrack, createMidiPart, createSession, createTrack, findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { DAW_SESSION_VERSION } from '../src/renderer/daw/model/types.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';

const results: { name: string; pass: boolean; detail?: string }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail });
    console.log(`[FAIL] ${name} — ${detail}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, msg: string, tol = 1e-9): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} — got ${a}, want ${b} ±${tol}`);
}

const at120 = defaultTempoMap(120);
const at60 = defaultTempoMap(60);

// ── The frame ─────────────────────────────────────────────────────────────────

check('a part anchored in seconds gives its notes an origin in beats', () => {
  const clock = partClock(at120, 4);
  close(clock.startSec, 4, 'the anchor is where it was put');
  close(clock.startBeat, 8, 'four seconds at 120 BPM is eight beats');
  close(beatToTimelineSec(clock, 0), 4, 'beat zero of the part is the part start');
  close(beatToTimelineSec(clock, 2), 5, 'and two beats in is one second later');
  close(timelineSecToBeat(clock, 5), 2, 'and back again');
});

check('a note is placed relative to its part, not to the session', () => {
  resetNoteIds();
  const note = createNote({ startBeat: 2, durationBeat: 1 });
  const early = partClock(at120, 0);
  const late = partClock(at120, 10);
  close(noteStartSec(early, note), 1, 'beat 2 of a part at 0:00');
  close(noteStartSec(late, note), 11, 'the same note in a part ten seconds later');
  close(noteEndSec(late, note) - noteStartSec(late, note), 0.5, 'a beat at 120 BPM');
});

check('a note outside the part is still placed — clipping is not this module’s job', () => {
  resetNoteIds();
  // A note past the end of its part box is a real thing (the box was shrunk).
  // Returning something sensible and letting the caller decide beats
  // silently snapping it back inside.
  const clock = partClock(at120, 0);
  const note = createNote({ startBeat: 64, durationBeat: 1 });
  close(noteStartSec(clock, note), 32, 'placed where it says it is');
});

// ── Under a tempo change ──────────────────────────────────────────────────────

/** 120 BPM, dropping to 60 at beat 4. */
function stepped(): ReturnType<typeof compileTempoMap>['map'] {
  return compileTempoMap(addTempoEvent(defaultTempoMap(120), 4, 60)).map;
}

check('a note after a tempo change moves in seconds without moving in beats', () => {
  resetNoteIds();
  const note = createNote({ startBeat: 6, durationBeat: 1 });
  const before = partClock(defaultTempoMap(120), 0);
  const after = partClock(stepped(), 0);

  close(noteStartSec(before, note), 3, 'beat 6 at a flat 120');
  // Four beats at 120 is 2 s; the next two are at 60, so 2 s each.
  // Four beats at 120 is 2 s, then two at 60 is 2 s more.
  close(noteStartSec(after, note), 4, 'and beat 6 once the tempo halves at beat 4');
  eq(note.startBeat, 6, 'the note itself never changed');
});

check('a note that STRADDLES a tempo change is measured, not multiplied', () => {
  resetNoteIds();
  // Beats 3→5 crosses the change at beat 4: one beat at 120 (0.5 s) plus one
  // at 60 (1 s) = 1.5 s.  Multiplying its length by either tempo's beat gives
  // 1 s or 2 s — both wrong, and this is the case that catches it.
  const note = createNote({ startBeat: 3, durationBeat: 2 });
  const clock = partClock(stepped(), 0);
  const span = noteSpan(clock, note);
  close(span.startSec, 1.5, 'starts three beats in at 120');
  close(span.durationSec, 1.5, 'and is neither one second nor two');
  close(span.endSec - span.startSec, span.durationSec, 'the span agrees with itself');
});

check('the same note in a part that starts after the change is read at the new tempo', () => {
  resetNoteIds();
  const note = createNote({ startBeat: 2, durationBeat: 1 });
  // The part starts at 4 s — beat 6, past the change — so its beats are the
  // slow ones.
  const clock = partClock(stepped(), 4);
  close(clock.startBeat, 6, 'four seconds in is beat 6 on this map');
  close(noteSpan(clock, note).durationSec, 1, 'a beat here is a second');
});

check('beatsToSecAt and secToBeatsAt are inverses within a part', () => {
  const clock = partClock(stepped(), 1);
  for (const beats of [0, 0.25, 1, 3.75, 12]) {
    close(secToBeatsAt(clock, beatsToSecAt(clock, beats)), beats, `round trip at ${beats}`, 1e-9);
  }
});

check('a per-note curve is read in the note’s own beats and clamped to it', () => {
  resetNoteIds();
  const note = createNote({ startBeat: 2, durationBeat: 2 });
  const clock = partClock(at120, 0);
  close(beatIntoNote(clock, note, 1), 0, 'before the note reads as its start');
  close(beatIntoNote(clock, note, noteStartSec(clock, note)), 0, 'at the attack');
  close(beatIntoNote(clock, note, noteEndSec(clock, note)), 2, 'at the release');
  close(beatIntoNote(clock, note, 99), 2, 'past the end is clamped, never extrapolated');
});

// ── Agreement with the tempo map ──────────────────────────────────────────────

check('a part at zero is exactly the session tempo map', () => {
  const clock = partClock(stepped(), 0);
  for (const beat of [0, 1, 4, 4.5, 10]) {
    close(beatToTimelineSec(clock, beat), beatToSec(stepped(), beat), `beat ${beat}`);
  }
  for (const sec of [0, 0.5, 2, 3, 7]) {
    close(timelineSecToBeat(clock, sec), secToBeat(stepped(), sec), `second ${sec}`);
  }
});

check('sixty BPM is the identity, which is why the other suites use it', () => {
  const clock = partClock(at60, 0);
  for (const v of [0, 0.5, 2, 7.25]) {
    close(beatToTimelineSec(clock, v), v, `beat ${v} is second ${v}`);
  }
});

// ── The v1 → v2 migration ─────────────────────────────────────────────────────

/** A v1 session as it would have been written to disk. */
function legacySession(partStartSec: number, bpm = 120): Record<string, unknown> {
  resetIds();
  let s = { ...createSession('old'), tempoBpm: bpm };
  const track = createTrack('Keys', 'instrument');
  s = addTrack(s, track);
  s = updateClips(s, track.id, () => [createMidiPart('Part', {
    startSec: partStartSec, durationSec: 4,
  })]);
  const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  const tracks = raw['tracks'] as Array<Record<string, unknown>>;
  const clip = (tracks[0]!['playlists'] as Array<Record<string, unknown>>)[0]!;
  ((clip['clips'] as Array<Record<string, unknown>>)[0]!)['notes'] = [{
    id: 'n1', pitch: 60, pitchOffsetSemitones: 0,
    startSec: 1, durationSec: 0.5,
    velocity: 0.8, releaseVelocity: 0.5, channel: 0, muted: false,
    expression: [{ target: { kind: 'pitchBend' }, points: [
      { timeSec: 0, value: 0 }, { timeSec: 0.5, value: 1 },
    ] }],
    articulation: null, playProbability: 1,
  }];
  raw['version'] = 1;
  return raw;
}

check('a v1 file is converted rather than refused', () => {
  const raw = legacySession(0);
  assert(needsMigration(raw), 'it is recognised as old');
  const { session, notes } = migrateSession(raw);
  eq(session['version'], DAW_SESSION_VERSION, 'stamped with the current version');
  assert(notes.some((n) => n.includes('노트')), 'and it says what it did');
  assert(!needsMigration(session), 'and does not want converting twice');
});

check('a v1 note keeps the moment it was written for', () => {
  const raw = legacySession(0);
  const { session } = migrateSession(raw);
  const tracks = session['tracks'] as Array<Record<string, unknown>>;
  const clips = ((tracks[0]!['playlists'] as Array<Record<string, unknown>>)[0]!)['clips'] as
    Array<Record<string, unknown>>;
  const note = ((clips[0]!['notes']) as Array<Record<string, unknown>>)[0]!;
  close(note['startBeat'] as number, 2, 'one second at 120 BPM is two beats');
  close(note['durationBeat'] as number, 1, 'and half a second is one');
  assert(note['startSec'] === undefined, 'the old field is gone, not left to rot');

  const points = ((note['expression'] as Array<Record<string, unknown>>)[0]!)['points'] as
    Array<Record<string, number>>;
  close(points[0]!['timeBeat']!, 0, 'the curve starts at the note');
  close(points[1]!['timeBeat']!, 1, 'and ends at its release');
});

check('a v1 note in a part that does not start at zero is read from the PART', () => {
  // The trap: a v1 `startSec` was measured from the part, so reading it from
  // second zero would move every note in every part further down the song.
  const { session } = migrateSession(legacySession(10));
  const tracks = session['tracks'] as Array<Record<string, unknown>>;
  const clips = ((tracks[0]!['playlists'] as Array<Record<string, unknown>>)[0]!)['clips'] as
    Array<Record<string, unknown>>;
  const note = ((clips[0]!['notes']) as Array<Record<string, unknown>>)[0]!;
  close(note['startBeat'] as number, 2, 'still two beats into its own part');
});

check('a v1 file at another tempo converts by that tempo, not by 120', () => {
  const { session } = migrateSession(legacySession(0, 60));
  const tracks = session['tracks'] as Array<Record<string, unknown>>;
  const clips = ((tracks[0]!['playlists'] as Array<Record<string, unknown>>)[0]!)['clips'] as
    Array<Record<string, unknown>>;
  const note = ((clips[0]!['notes']) as Array<Record<string, unknown>>)[0]!;
  close(note['startBeat'] as number, 1, 'one second at 60 BPM is one beat');
});

check('migrating twice is not converting twice', () => {
  const once = migrateSession(legacySession(0)).session;
  const twice = migrateSession({ ...once, version: 1 }).session;
  const noteOf = (s: Record<string, unknown>): Record<string, unknown> => {
    const tracks = s['tracks'] as Array<Record<string, unknown>>;
    const clips = ((tracks[0]!['playlists'] as Array<Record<string, unknown>>)[0]!)['clips'] as
      Array<Record<string, unknown>>;
    return ((clips[0]!['notes']) as Array<Record<string, unknown>>)[0]!;
  };
  close(noteOf(twice)['startBeat'] as number, noteOf(once)['startBeat'] as number,
    'a converted note is left alone');
});

check('loading routes an old file through the migration and says so', () => {
  const parsed = deserializeDawSession(JSON.stringify(legacySession(0)));
  assert(parsed.ok, 'a v1 file opens');
  if (!parsed.ok) return;
  assert(parsed.warnings.some((w) => w.includes('노트')), 'the conversion is reported, not silent');
  const track = findTrack(parsed.session, parsed.session.tracks[0]!.id)!;
  const note = trackClips(track)[0]!.notes[0]!;
  close(note.startBeat, 2, 'and the note arrives in beats');
});

check('a file from the future is refused, not guessed at', () => {
  const raw = { ...legacySession(0), version: DAW_SESSION_VERSION + 1 };
  const parsed = deserializeDawSession(JSON.stringify(raw));
  eq(parsed.ok, false, 'refused');
});

check('a current session round-trips untouched', () => {
  resetIds();
  resetNoteIds();
  let s = createSession('new');
  const track = createTrack('Keys', 'instrument');
  s = addTrack(s, track);
  s = updateClips(s, track.id, () => [createMidiPart('Part', {
    startSec: 2, durationSec: 4,
    notes: [createNote({ pitch: 60, startBeat: 1.5, durationBeat: 0.75 })],
  })]);
  const parsed = deserializeDawSession(serializeDawSession(s));
  assert(parsed.ok, 'it opens');
  if (!parsed.ok) return;
  eq(parsed.warnings.length, 0, 'with nothing to report');
  const note = trackClips(findTrack(parsed.session, track.id)!)[0]!.notes[0]!;
  close(note.startBeat, 1.5, 'the beat survives');
  close(noteEndBeat(note), 2.25, 'and so does the length');
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
