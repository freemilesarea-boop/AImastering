// 세션 파일이 세션이 아닐 때 — what to keep, what to fill, what to say.
//
// `deserializeDawSession` checked two things and then asserted the rest:
//
//   const session = migrated.session as unknown as DawSession;
//
// The checks were that `version` is a number in range and that `tracks` is an
// array.  Nothing looked INSIDE a track, so a file whose tracks array held
// objects that were not tracks parsed with `ok: true` and crashed at the first
// consumer — `trackClips()` reading `.playlists.find` on undefined.
//
// That is the same shape as the bug this app shipped and then hot-fixed: a
// cast tells the compiler to stop asking, the object is truthy so no fallback
// runs, and the failure surfaces as a stack trace in front of a student.  The
// only difference is the doorway.  There it was a render result; here it is a
// FILE — hand-edited, half-written by a crash, or copied between people.
//
// ── The discipline is the one this codebase already uses ────────────────────
//
// `loadRack`, `importTemplates` and `sanitiseParams` all answer this question
// the same way, so this does too:
//
//   NOTHING IS SILENTLY LOST.  Every field filled in and every track dropped
//   is reported, by name, in the warnings the open dialog already shows.
//   WHAT CAN BE KEPT IS KEPT.  A track missing its `sends` array is a track
//   with no sends, not a reason to refuse somebody's song.
//   DEFAULTS COME FROM THE APP, NOT FROM HERE.  A repaired track is
//   `createTrack(...)` with the file's usable fields laid over it, so the
//   values a repair produces cannot drift from the values a new track gets.

import {
  DEFAULT_TRACK_HEIGHT, activePlaylist, createPlaylist, createTrack,
} from './session-ops.js';
import type { DawSession, Track, TrackKind } from './types.js';

const TRACK_KINDS: readonly TrackKind[] = [
  'audio', 'instrument', 'aux', 'master', 'vca', 'folder',
];

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A finite number, or `fallback` — the guard the rest of this file is built on. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function arr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/**
 * The three structured fields, each checked for the members its readers use.
 *
 * Narrowing predicates rather than casts: `MacroRack` without `values` throws
 * in the mixer's macro chip row, `FrozenState` without `fileId` throws on
 * unfreeze, and `DeviceGraph` without `nodes` throws in `topoOrder`.  A field
 * that does not have its members is dropped, and the track keeps the default
 * `createTrack` gave it.
 */
function hasMacroRack(v: unknown): v is Track['macros'] {
  return isObject(v) && typeof v['enabled'] === 'boolean'
    && isObject(v['values']) && isObject(v['overrides']);
}

function hasFrozenState(v: unknown): v is NonNullable<Track['frozen']> {
  return isObject(v) && typeof v['fileId'] === 'string'
    && Array.isArray(v['renderedInsertIds']) && typeof v['frozenAt'] === 'number';
}

/**
 * The record input, which is the field that caught the whitelist.
 *
 * `repairTrack` carried the fields it knew and let the rest fall back to the
 * defaults — and `record-selftest` failed with `the device name came back:
 * got null, want "Scarlett 18i20"`.  A whitelist that forgets a field does
 * not crash; it quietly resets it, which is worse, and four others went with
 * it: `drumMapId`, `midiInserts`, `delayMs`, `hidden`.  `firstChannel` is
 * optional in the type on purpose — sessions saved before multi-channel
 * input existed have no such field — so it is checked separately.
 */
function hasRecordInput(v: unknown): v is NonNullable<Track['recordInput']> {
  if (!isObject(v)) return false;
  const label = v['deviceLabel'];
  const id = v['deviceId'];
  const ch = v['channels'];
  return (typeof label === 'string' || label === null)
    && (typeof id === 'string' || id === null)
    && (ch === 1 || ch === 2);
}

function hasDeviceGraph(v: unknown): v is NonNullable<Track['deviceGraph']> {
  return isObject(v) && Array.isArray(v['nodes']) && Array.isArray(v['edges']);
}

export interface TrackRepair {
  /** null when the entry cannot be a track at all. */
  track: Track | null;
  notes: string[];
  /**
   * Labels of empty collections that were absent and are now `[]`.
   *
   * Separate from `notes` because of what a real old file does: `racks` was
   * added to `Track` long after the session format's version last moved, so
   * every track of a healthy v3.6 session is missing it.  A note per track
   * put TWENTY-ONE lines on the load toast for a file with nothing wrong
   * with it, which teaches the reader to dismiss the toast — and the toast
   * is where "트랙 3개를 제외했습니다" has to be read.  `repairSession`
   * folds these into one line that names the fields and counts the tracks.
   */
  filled: string[];
}

/**
 * One track from a file, made into a `Track` or refused.
 *
 * Refused only when there is nothing to build on: a non-object, or an entry
 * with no usable `id`.  An id is the one field nothing can invent — clips,
 * sends, automation lanes and group memberships all point at it, so a made-up
 * id would silently orphan every reference to the real one.
 */
export function repairTrack(raw: unknown, index: number): TrackRepair {
  if (!isObject(raw)) {
    return {
      track: null, filled: [],
      notes: [`${index + 1}번째 트랙이 트랙 형식이 아니어서 제외했습니다`],
    };
  }
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return {
      track: null, filled: [],
      notes: [`${index + 1}번째 트랙에 id 가 없어 제외했습니다`],
    };
  }

  const notes: string[] = [];
  const name = typeof raw['name'] === 'string' && raw['name'].length > 0
    ? raw['name'] : `Track ${index + 1}`;
  if (name !== raw['name']) notes.push(`"${name}" — 이름이 없어 채웠습니다`);

  const rawKind = raw['kind'];
  const kind: TrackKind = TRACK_KINDS.includes(rawKind as TrackKind)
    ? rawKind as TrackKind : 'audio';
  if (kind !== rawKind) notes.push(`"${name}" — 알 수 없는 종류라 오디오 트랙으로 읽었습니다`);

  // The defaults, from the function the app itself uses.  Everything below
  // lays the file's usable fields over this.
  const base = createTrack(name, kind, { id });

  // Playlists are the field whose absence crashed: `trackClips` reads
  // `activePlaylist(t).clips`, and `activePlaylist` reads `t.playlists`.
  const playlists = arr(raw['playlists']);
  let repaired: Track = base;
  if (playlists === null || playlists.length === 0) {
    notes.push(`"${name}" — 플레이리스트가 없어 빈 것을 만들었습니다`);
  } else {
    const kept = playlists.filter(isObject).map((p, n) => {
      const pid = typeof p['id'] === 'string' && p['id'].length > 0 ? p['id'] : `pl-${id}-${n}`;
      const pname = typeof p['name'] === 'string' ? p['name'] : `${name}.${String(n + 1).padStart(2, '0')}`;
      const clips = arr(p['clips']);
      return { ...createPlaylist(pname), id: pid, clips: (clips ?? []) as never };
    });
    if (kept.length !== playlists.length) {
      notes.push(`"${name}" — 플레이리스트 ${playlists.length - kept.length}개가 형식이 맞지 않아 제외했습니다`);
    }
    if (kept.length === 0) {
      notes.push(`"${name}" — 쓸 수 있는 플레이리스트가 없어 빈 것을 만들었습니다`);
    } else {
      const wantedActive = raw['activePlaylistId'];
      const active = typeof wantedActive === 'string'
        && kept.some((p) => p.id === wantedActive) ? wantedActive : kept[0]!.id;
      if (active !== wantedActive) {
        notes.push(`"${name}" — 활성 플레이리스트를 찾을 수 없어 첫 번째를 골랐습니다`);
      }
      repaired = { ...base, playlists: kept, activePlaylistId: active };
    }
  }

  // The arrays whose absence throws on `.length`, `.map` or `.find`.
  const listFields: { key: keyof Track & string; label: string }[] = [
    { key: 'inserts', label: '인서트' },
    { key: 'sends', label: '센드' },
    { key: 'automation', label: '오토메이션' },
    { key: 'groupIds', label: '그룹' },
    { key: 'racks', label: '랙' },
  ];
  const lists: Partial<Record<string, unknown[]>> = {};
  const filled: string[] = [];
  for (const { key, label } of listFields) {
    const got = arr(raw[key]);
    if (got === null) filled.push(label);
    lists[key] = got ?? [];
  }

  // The scalars.  Out-of-range and non-finite both fall back rather than
  // being clamped: a height of NaN is not a height that needs clamping, it is
  // a field that was not written.
  const height = num(raw['height'], DEFAULT_TRACK_HEIGHT);

  return {
    track: {
      ...repaired,
      volumeDb: num(raw['volumeDb'], 0),
      pan: Math.max(-1, Math.min(1, num(raw['pan'], 0))),
      mute: bool(raw['mute'], false),
      solo: bool(raw['solo'], false),
      soloSafe: bool(raw['soloSafe'], false),
      recordArm: bool(raw['recordArm'], false),
      height: height > 0 ? height : DEFAULT_TRACK_HEIGHT,
      collapsed: bool(raw['collapsed'], false),
      ...(lists as Pick<Track, 'inserts' | 'sends' | 'automation' | 'groupIds' | 'racks'>),
      ...(isObject(raw['output']) ? { output: raw['output'] as Track['output'] } : {}),
      ...(typeof raw['input'] === 'string' ? { input: raw['input'] } : {}),
      ...(typeof raw['color'] === 'string' ? { color: raw['color'] } : {}),
      ...(typeof raw['parentId'] === 'string' ? { parentId: raw['parentId'] } : {}),
      ...(typeof raw['vcaId'] === 'string' ? { vcaId: raw['vcaId'] } : {}),
      ...(typeof raw['instrumentId'] === 'string' ? { instrumentId: raw['instrumentId'] } : {}),
      ...(isObject(raw['instrumentParams']) ? { instrumentParams: raw['instrumentParams'] as Record<string, number> } : {}),
      // The three structured fields are carried only when they HAVE the
      // shape, checked field by field.  A cast here would be the exact sin
      // this file exists to undo — and the compiler said so when the first
      // draft tried it.
      ...(hasMacroRack(raw['macros']) ? { macros: raw['macros'] } : {}),
      ...(hasFrozenState(raw['frozen']) ? { frozen: raw['frozen'] } : {}),
      ...(hasDeviceGraph(raw['deviceGraph']) ? { deviceGraph: raw['deviceGraph'] } : {}),
      ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
      // The five the first draft forgot.  `track-fields` in the selftest
      // reads `Track` out of `types.ts` and fails if this file stops
      // mentioning any field of it, so the next one added cannot be lost the
      // same way.
      ...(hasRecordInput(raw['recordInput'])
        ? {
          recordInput: {
            ...raw['recordInput'],
            ...(typeof raw['recordInput']['firstChannel'] === 'number'
              ? { firstChannel: raw['recordInput']['firstChannel'] } : {}),
          },
        }
        : {}),
      ...(typeof raw['drumMapId'] === 'string' ? { drumMapId: raw['drumMapId'] } : {}),
      ...(Array.isArray(raw['midiInserts'])
        ? { midiInserts: raw['midiInserts'] as NonNullable<Track['midiInserts']> } : {}),
      ...(typeof raw['delayMs'] === 'number' && Number.isFinite(raw['delayMs'])
        ? { delayMs: raw['delayMs'] } : {}),
      ...(typeof raw['hidden'] === 'boolean' ? { hidden: raw['hidden'] } : {}),
    },
    notes,
    filled,
  };
}

export interface SessionRepair {
  session: DawSession;
  notes: string[];
}

/**
 * Every track repaired, and a master guaranteed.
 *
 * The master is CREATED, not merely mentioned.  The old code pushed the
 * warning "마스터 트랙이 없어 새로 만들었습니다" and made nothing — so the
 * message said an action had been taken that had not, and the session opened
 * with every track's `output` pointing at a master that was not there.
 */
export function repairSession(raw: Record<string, unknown>): SessionRepair {
  const notes: string[] = [];
  const entries = Array.isArray(raw['tracks']) ? raw['tracks'] : [];
  const tracks: Track[] = [];
  // Which absent collections were filled, and on how many tracks — one line
  // at the end rather than one line per track.  See `TrackRepair.filled`.
  const fills = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const result = repairTrack(entries[i], i);
    notes.push(...result.notes);
    for (const label of result.filled) fills.set(label, (fills.get(label) ?? 0) + 1);
    if (result.track) tracks.push(result.track);
  }
  if (fills.size > 0) {
    const most = Math.max(...fills.values());
    notes.push(`없던 항목을 기본값으로 채웠습니다 — ${[...fills.keys()].join(' · ')}`
      + ` (트랙 ${most}개)`);
  }

  if (!tracks.some((t) => t.kind === 'master')) {
    tracks.push(createTrack('Master', 'master', { output: { kind: 'none' } }));
    notes.push('마스터 트랙이 없어 새로 만들었습니다.');
  }

  const session = { ...raw, tracks } as unknown as DawSession;
  // The one thing the repair cannot be wrong about: every track it returns
  // must survive the call that used to crash.  Asserted here rather than
  // trusted, because the whole point of this file is that the type said
  // "Track" and the object was not one.
  for (const t of session.tracks) {
    if (activePlaylist(t) === undefined) {
      notes.push(`"${t.name}" — 플레이리스트를 복구할 수 없어 제외했습니다`);
    }
  }
  return {
    session: { ...session, tracks: session.tracks.filter((t) => activePlaylist(t) !== undefined) },
    notes,
  };
}
