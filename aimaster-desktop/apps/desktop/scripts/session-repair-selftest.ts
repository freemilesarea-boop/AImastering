/**
 * session-repair-selftest — the cast that said "Track" about something else.
 *
 * Three defects with one shape, found in one audit and fixed together:
 *
 *   · `deserializeDawSession` checked that `version` was in range and that
 *     `tracks` was an array, then asserted the rest with
 *     `as unknown as DawSession`.  A file whose tracks array held objects that
 *     were not tracks parsed with `ok: true` and crashed at the first
 *     consumer — `trackClips()` reading `.playlists.find` on undefined.
 *   · the warning "마스터 트랙이 없어 새로 만들었습니다" was pushed and no
 *     master was made, so the message claimed an action nobody took and the
 *     session opened with every `output: { kind: 'master' }` pointing at
 *     nothing.
 *   · `createSend` defaulted `levelDb` to `-Infinity`, the one value this app
 *     cannot save: `JSON.stringify(-Infinity)` is `null`, so a send came back
 *     from its own file as `null` under a type that says `number`, and
 *     `send.levelDb.toFixed(1)` in the mixer threw.
 *
 * All three are the shape of the crash this app hot-fixed: the type stops
 * being asked, the value is not what it claims, and the stack trace lands in
 * front of a student.  So every check here ends at a CONSUMER — the call that
 * used to throw — rather than at the parse returning `ok`.
 */
export {};

import { readFileSync } from 'node:fs';

import { repairTrack } from '../src/renderer/daw/model/session-repair.js';
import {
  deserializeDawSession, serializeDawSession,
} from '../src/renderer/daw/model/session-io.js';
import {
  DEFAULT_TRACK_HEIGHT, activePlaylist, addTrack, createBus, createSend, createSession,
  createTrack, findTrack, setSend, trackClips,
} from '../src/renderer/daw/model/session-ops.js';
import { SEND_LEVEL_MIN_DB } from '../src/renderer/daw/model/types.js';
import { SEND_CLOSED_DB } from '../src/renderer/daw/edit/region-live.js';

let passed = 0;
let failed = 0;
/**
 * `detail` may be a thunk, and a thunk that throws is reported rather than
 * fatal.  This is not politeness.  A detail string that reads a field the
 * check is asserting the existence of — `t.inserts.length` — dies on exactly
 * the broken input the check exists to catch, and the run dies with it, so
 * the failure is never printed and every check after it never runs.  One
 * deliberately broken fix took three checks with it this way.  The judge does
 * not get to have the disease it is diagnosing.
 */
function check(name: string, ok: boolean, detail: string | (() => string)): void {
  let text: string;
  if (typeof detail === 'string') text = detail;
  else {
    try { text = detail(); }
    catch (e) { text = `(세부 설명을 만들다 throw: ${(e as Error).message})`; }
  }
  if (ok) { passed++; console.log(`[PASS] ${name} — ${text}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${text}`); }
}

/** A session file body with whatever tracks are handed in. */
function fileWith(tracks: unknown[]): string {
  return JSON.stringify({
    version: 3, id: 'ses-t', name: 'file', sampleRate: 48_000, tempoBpm: 120,
    timeSignature: [4, 4], files: [], buses: [], groups: [], markers: [],
    chordTrack: [], delayCompensation: true, tracks,
  });
}


console.log('\n=== 세션 복구 ===\n');

// ── A-1: the half-written track ──────────────────────────────────────────
{
  // The exact payload from the audit: an id, a name, a kind, and nothing else.
  const parsed = deserializeDawSession(fileWith([
    { id: 'trk-1', name: 'half a track', kind: 'audio' },
  ]));
  check(
    'a file whose track is missing everything but its id still opens',
    parsed.ok,
    parsed.ok ? 'parsed' : `refused: ${parsed.error}`,
  );
  if (parsed.ok) {
    const t = findTrack(parsed.session, 'trk-1');
    check(
      'and the track survives the call that used to throw',
      (() => {
        if (!t) return false;
        try { return Array.isArray(trackClips(t)); } catch { return false; }
      })(),
      t ? `trackClips() → ${(() => { try { return `${trackClips(t).length} clip(s)`; } catch (e) { return `THREW ${(e as Error).message}`; } })()}`
        : 'track not found',
    );
    check(
      'every array a consumer reaches for is an array, not undefined',
      t !== undefined && Array.isArray(t.inserts) && Array.isArray(t.sends)
        && Array.isArray(t.automation) && Array.isArray(t.groupIds)
        && Array.isArray(t.racks) && Array.isArray(t.playlists),
      () => (t ? `inserts ${t.inserts.length} · sends ${t.sends.length} · automation ${t.automation.length} · racks ${t.racks.length}` : '-'),
    );
    check(
      'and it says what it filled in, rather than filling it in silently',
      parsed.warnings.some((w) => w.includes('플레이리스트'))
        && parsed.warnings.some((w) => w.includes('인서트')),
      `${parsed.warnings.length} warning(s): ${parsed.warnings.slice(0, 2).join(' | ')}`,
    );
  }
}

// ── A-1: what cannot be repaired is named, not guessed ───────────────────
{
  const parsed = deserializeDawSession(fileWith([
    'not a track at all',
    { name: 'no id here', kind: 'audio' },
    { id: 'trk-ok', name: 'fine', kind: 'audio' },
  ]));
  check(
    'an entry that is not an object, and one with no id, are dropped by name',
    parsed.ok
      && parsed.warnings.some((w) => w.includes('1번째'))
      && parsed.warnings.some((w) => w.includes('2번째'))
      && parsed.warnings.some((w) => w.includes('id')),
    parsed.ok ? parsed.warnings.filter((w) => w.includes('번째')).join(' | ') : 'refused',
  );
  check(
    'an id is the one field nothing invents — clips and groups point at it',
    parsed.ok && parsed.session.tracks.some((t) => t.id === 'trk-ok')
      && !parsed.session.tracks.some((t) => t.name === 'no id here'),
    parsed.ok ? `kept ${parsed.session.tracks.filter((t) => t.kind !== 'master').length} of 3` : '-',
  );
  const unknownKind = repairTrack({ id: 'x', name: 'odd', kind: 'telepathy' }, 0);
  check(
    'an unknown track kind is read as audio and said so',
    unknownKind.track?.kind === 'audio'
      && unknownKind.notes.some((n) => n.includes('알 수 없는 종류')),
    unknownKind.notes.join(' | ') || '(no note)',
  );
}

// ── A-1: a value that is not a number is not clamped, it is replaced ─────
{
  const r = repairTrack({
    id: 'x', name: 'junk numbers', kind: 'audio',
    volumeDb: 'loud', pan: 42, height: Number.NaN, mute: 'yes',
  }, 0);
  const t = r.track;
  check(
    'junk scalars fall back to the app\'s own defaults rather than through',
    t !== null && t.volumeDb === 0 && t.pan === 1
      && t.height === DEFAULT_TRACK_HEIGHT && t.mute === false,
    t ? `volumeDb ${t.volumeDb} · pan ${t.pan} (clamped from 42) · height ${t.height} · mute ${String(t.mute)}` : '-',
  );
  const noShape = repairTrack({
    id: 'y', name: 'shapes', kind: 'audio',
    macros: { nope: 1 }, frozen: { fileId: 'f' }, deviceGraph: { nodes: [] },
  }, 0);
  check(
    'and a structured field without its members is dropped, not cast',
    noShape.track !== null
      && noShape.track.frozen === null && noShape.track.deviceGraph === null
      && typeof noShape.track.macros.values === 'object',
    'macros · frozen · deviceGraph each checked member by member',
  );
}

// ── A-2: the master is made, not merely mentioned ────────────────────────
{
  const full = createTrack('Audio 1', 'audio');
  const parsed = deserializeDawSession(fileWith([JSON.parse(JSON.stringify(full))]));
  check(
    'a session with no master gets one, which is what the warning always said',
    parsed.ok && parsed.session.tracks.some((t) => t.kind === 'master'),
    parsed.ok ? `kinds → ${parsed.session.tracks.map((t) => t.kind).join(', ')}` : 'refused',
  );
  check(
    'and the warning is still raised, because something did change',
    parsed.ok && parsed.warnings.some((w) => w.includes('마스터 트랙이 없어')),
    parsed.ok ? (parsed.warnings.find((w) => w.includes('마스터')) ?? '-') : '-',
  );
  // A session that HAS a master must not grow a second one.
  const withMaster = deserializeDawSession(serializeDawSession(createSession('ok')));
  check(
    'a session that already has a master is left alone',
    withMaster.ok && withMaster.session.tracks.filter((t) => t.kind === 'master').length === 1
      && !withMaster.warnings.some((w) => w.includes('마스터')),
    withMaster.ok ? `${withMaster.session.tracks.length} track(s), no master warning` : 'refused',
  );
}

// ── A-3: the default that could not survive its own file ─────────────────
{
  const bus = createBus('B');
  const track = createTrack('T', 'audio');
  let s = addTrack({ ...createSession('inf'), buses: [bus] }, track);
  // The bare default — the call that used to store -Infinity.
  s = setSend(s, track.id, createSend(0, bus.id));
  const before = findTrack(s, track.id)!.sends[0]!;
  check(
    'the default send level is a finite number',
    Number.isFinite(before.levelDb) && before.levelDb === SEND_LEVEL_MIN_DB,
    `levelDb = ${before.levelDb} (was -Infinity)`,
  );

  const json = serializeDawSession(s);
  check(
    'so it is still a number in the file, not null',
    /"levelDb": *-?\d/.test(json) && !/"levelDb": *null/.test(json),
    /"levelDb":[^,}\n]*/.exec(json)?.[0] ?? '(not found)',
  );

  const back = deserializeDawSession(json);
  const after = back.ok ? findTrack(back.session, track.id)?.sends[0] : undefined;
  check(
    'and it comes back a number, so the mixer can format it',
    after !== undefined && typeof after.levelDb === 'number'
      && Number.isFinite(after.levelDb),
    after ? `levelDb = ${after.levelDb}, typeof ${typeof after.levelDb}` : 'send lost',
  );
  check(
    'the call that used to throw now produces a string',
    (() => {
      try { return typeof after!.levelDb.toFixed(1) === 'string'; } catch { return false; }
    })(),
    () => (after ? `toFixed(1) → "${after.levelDb.toFixed(1)}"` : '-'),
  );
  check(
    '"shut" is one number, shared by the fader floor and the automated throw',
    SEND_CLOSED_DB === SEND_LEVEL_MIN_DB,
    `region-live SEND_CLOSED_DB === types SEND_LEVEL_MIN_DB === ${SEND_LEVEL_MIN_DB}`,
  );
}

// ── Nothing was broken on the way ────────────────────────────────────────
{
  // A real session, saved and reloaded, must come back unchanged and warn
  // about nothing — a repair that rewrites healthy sessions is worse than no
  // repair at all.
  const a = createTrack('Vox', 'audio');
  const b = createTrack('Synth', 'instrument');
  const original = addTrack(addTrack(createSession('healthy'), a), b);
  const round = deserializeDawSession(serializeDawSession(original));
  check(
    'a healthy session round-trips with no warnings and no changes',
    round.ok && round.warnings.length === 0
      && JSON.stringify(round.session) === JSON.stringify(original),
    round.ok ? `${round.session.tracks.length} tracks, ${round.warnings.length} warnings, byte-identical`
      : `refused: ${round.error}`,
  );
  check(
    'and every track in it still answers the consumer',
    round.ok && round.session.tracks.every((t) => activePlaylist(t) !== undefined),
    () => (round.ok
      ? `${round.session.tracks.filter((t) => activePlaylist(t) !== undefined).length}/${round.session.tracks.length} have an active playlist`
      : '-'),
  );
}

// ── The parse no longer asserts ──────────────────────────────────────────
{
  const io = readFileSync('src/renderer/daw/model/session-io.ts', 'utf8');
  const ops = readFileSync('src/renderer/daw/model/session-ops.ts', 'utf8');
  check(
    'session-io repairs instead of casting',
    /repairSession\(migrated\.session as Record<string, unknown>\)/.test(io)
      // The CODE, not the string: the comment above the fix quotes the old
      // line on purpose, which is how this codebase records what something
      // cost.  A grep for the text finds the gravestone.
      && !/^\s*const session = .*as unknown as DawSession;/m.test(io),
    'no assignment casts the parsed object into a session any more',
  );
  check(
    'and the master branch creates one rather than only warning',
    !/warnings\.push\('마스터 트랙이 없어/.test(io),
    'the claim and the action are in one place now — session-repair',
  );
  check(
    'createSend carries no -Infinity',
    !/-Infinity/.test(ops),
    'the one persisted field that held it is a finite constant',
  );
  const repair = readFileSync('src/renderer/daw/model/session-repair.ts', 'utf8');
  check(
    'and the repair takes its defaults from the function the app uses',
    /createTrack\(name, kind, \{ id \}\)/.test(repair),
    'a repaired track cannot drift from a new one',
  );
}

// ── Every field of Track, or the next one is lost too ────────────────────
//
// This is the check that was missing.  `repairTrack` builds on
// `createTrack`'s defaults and lays the file's fields over it, and the first
// draft laid over the fields it happened to think of — so `recordInput`,
// `drumMapId`, `midiInserts`, `delayMs` and `hidden` were silently reset to
// their defaults by a function whose job is to preserve what the file says.
// Nothing crashed.  `record-selftest` failed with "the device name came back:
// got null, want Scarlett 18i20", two steps into a 234-step suite, which is
// the only reason it was found.
//
// So the list is not maintained by hand: `Track` is read out of `types.ts`,
// and a field this file never mentions is a failure.
{
  const types = readFileSync(
    new URL('../src/renderer/daw/model/types.ts', import.meta.url), 'utf8');
  const start = types.indexOf('export interface Track ');
  const block = types.slice(start, types.indexOf('\n}\n', start));
  const fields = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
  const repair = readFileSync(
    new URL('../src/renderer/daw/model/session-repair.ts', import.meta.url), 'utf8');
  // Scoped to the object literal that BUILDS the track, not the whole file.
  // The first version of this check grepped the file and passed while the
  // carry was deleted, because `hasRecordInput` and the paragraph explaining
  // the bug both contain the word.  A check that a comment can satisfy is a
  // check of the comments.
  const carryStart = repair.indexOf('    track: {');
  const carry = repair.slice(carryStart, repair.indexOf('\n    },', carryStart));
  // These five are laid in above the literal, by `createTrack` and the
  // playlist repair, and arrive through `...repaired`.
  const viaBase = new Set(['id', 'name', 'kind', 'playlists', 'activePlaylistId']);
  const forgotten = fields.filter(
    (f) => !viaBase.has(f) && !new RegExp(`\\b${f}\\b`).test(carry));
  check(
    'every field Track has is carried in the literal, so none is reset by omission',
    carryStart > 0 && fields.length > 20 && forgotten.length === 0,
    carryStart < 0 ? 'could not find the track literal'
      : forgotten.length === 0
        ? `${fields.length} fields: ${viaBase.size} via createTrack, ${fields.length - viaBase.size} laid over it`
        : `not carried: ${forgotten.join(', ')}`,
  );
}

// ── A real old file, which is the common case ────────────────────────────
//
// `racks` was added to `Track` long after the session format's version last
// moved, so EVERY track of a perfectly healthy v3.6 session is missing it.
// The first version of this repair pushed a note per track and put 21 lines
// on the load toast for a file with nothing wrong with it — which teaches the
// reader to dismiss the toast, and the toast is where "트랙 3개를
// 제외했습니다" has to be read.  Measured: 21 warnings before, 2 after.
{
  const oldTrack = (i: number): Record<string, unknown> => ({
    id: `trk-${i}`, name: `Stem ${i}`, kind: 'audio', color: '#888',
    playlists: [{ id: `pl-${i}`, name: 'A', clips: [] }], activePlaylistId: `pl-${i}`,
    volumeDb: 0, pan: 0, mute: false, solo: false, soloSafe: false, recordArm: false,
    inserts: [], sends: [], input: { kind: 'none' }, output: { kind: 'master' },
    groupIds: [], automation: [], height: 96,
  });
  const file = JSON.stringify({
    version: 1, id: 'old', name: 'v3.6 세션', sampleRate: 48_000, tempoBpm: 120,
    timeSignature: [4, 4], files: [], buses: [], groups: [], markers: [],
    tracks: [...Array(20).keys()].map((i) => oldTrack(i + 1)),
  });
  const old = deserializeDawSession(file);
  check(
    'a v3.6-era session opens with every track it had',
    old.ok && old.session.tracks.filter((t) => t.kind !== 'master').length === 20,
    old.ok ? `${old.session.tracks.length} tracks incl. master` : `refused: ${old.error}`,
  );
  const perTrack = old.ok
    ? old.warnings.filter((w) => /^"Stem \d+"/.test(w)).length : -1;
  check(
    'and the fields added since are reported once, not once per track',
    old.ok && perTrack === 0 && old.warnings.length <= 3,
    old.ok
      ? `${old.warnings.length} warning(s), ${perTrack} of them per-track: `
        + old.warnings.join(' | ')
      : 'refused',
  );
  check(
    'and the one line still names the field, so it is not silent either',
    old.ok && old.warnings.some((w) => w.includes('랙') && w.includes('트랙 20개')),
    old.ok ? (old.warnings.find((w) => w.includes('기본값')) ?? '(no fill note)') : 'refused',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
