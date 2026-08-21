// Natural language control.
//
// "보컬 좀 더 앞으로", "킥 2dB 올려", "여기 코드 좀 재즈스럽게 바꿔".
//
// This is a DETERMINISTIC intent parser, and calling it that matters.  It is
// not a language model and does not pretend to be one: it matches a small
// grammar of targets, verbs and amounts, and when it does not understand
// something it says so instead of guessing.  For a tool that moves faders on
// someone's mix, "I did not understand that" is a much better failure than a
// plausible wrong action.
//
// The important design decision is the SEAM.  The parser's output is
// `IntelAction[]` — the same vocabulary the auto-mix and auto-master emit —
// so a model could replace this file entirely and nothing downstream would
// change.  A model would produce actions; the preview, the undo, the
// descriptions and the tests all keep working.
//
// One matching rule is worth stating because it is a real hazard: a keyword
// that is a SUBSTRING of an unrelated word will fire on it.  "스" (the start of
// a Korean word for sibilance) sits inside "재즈스럽게"; "up" sits inside
// "output".  So ASCII keywords are matched on word boundaries, and Korean
// keywords are never shorter than two characters.
//
// Grammar, roughly:
//
//   [target]  [band]  [verb]  [amount]
//   보컬       고역     올려    2dB
//   vocal     high    up      2db
//
// Every parse returns what it understood, so the UI can show the
// interpretation BEFORE anything moves.  Nothing here applies itself.

import { findTrack } from '../model/session-ops.js';
import { guessRole, roleLabel, type TrackRole } from './roles.js';
import { MACROS, type MacroId } from '../model/macros.js';
import type { IntelAction } from './actions.js';
import type { DawSession, Track, TrackId } from '../model/types.js';

export interface Interpretation {
  /** What the parser is confident it understood. */
  understood: string;
  actions: IntelAction[];
  /** Set when nothing could be done, with a reason the user can act on. */
  error?: string;
  /** Alternatives, when the phrasing was ambiguous. */
  hint?: string;
}

/**
 * Keyword matching that does not fire on the inside of another word.
 *
 * Korean is written without spaces between a noun and its particles, so a
 * substring test is the only thing that works there — which is exactly why no
 * Korean keyword below is a single character.  Latin keywords get real word
 * boundaries, so "up" does not match "output".
 */
function mentions(text: string, keyword: string): boolean {
  if (/^[a-z0-9 '-]+$/.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
  }
  return text.includes(keyword);
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** Words that name a track, beyond the track's own name. */
const ROLE_WORDS: readonly { words: readonly string[]; role: TrackRole }[] = [
  { words: ['보컬', 'vocal', 'vox', '보컬트랙', '노래'], role: 'vocal' },
  { words: ['코러스', '백보컬', 'backing', 'harmony'], role: 'backing' },
  { words: ['킥', 'kick', '베이스드럼'], role: 'kick' },
  { words: ['스네어', 'snare', '스네어드럼'], role: 'snare' },
  { words: ['하이햇', '햇', 'hat', 'hihat'], role: 'hat' },
  { words: ['드럼', 'drum', 'drums', '퍼커션'], role: 'drums' },
  { words: ['베이스', 'bass', '808'], role: 'bass' },
  { words: ['기타', 'guitar', 'gtr'], role: 'guitar' },
  { words: ['건반', '피아노', 'piano', 'keys'], role: 'keys' },
  { words: ['신스', 'synth'], role: 'synth' },
  { words: ['패드', 'pad', '스트링', 'strings'], role: 'pad' },
];

const MASTER_WORDS = ['마스터', 'master', '전체', '믹스', 'mix', '곡'];

interface Verb {
  words: readonly string[];
  /** What it does. */
  apply: (context: VerbContext) => IntelAction[] | null;
  /** How it reads back. */
  describe: (context: VerbContext) => string;
}

interface VerbContext {
  session: DawSession;
  track: Track;
  /** dB when the phrase carried a number, else null. */
  amountDb: number | null;
  /** Qualifier multiplier: 조금 = 0.5, 많이 = 2. */
  scale: number;
  band: 'low' | 'mid' | 'high' | null;
}

const DEFAULT_STEP_DB = 2;

function amountOf(context: VerbContext, fallback = DEFAULT_STEP_DB): number {
  return (context.amountDb ?? fallback) * (context.amountDb === null ? context.scale : 1);
}

function macroAction(track: Track, macroId: MacroId, value: number): IntelAction {
  return { kind: 'macro', trackId: track.id, macroId, value: Math.max(0, Math.min(1, value)) };
}

function currentMacro(track: Track, macroId: MacroId): number {
  return track.macros.values[macroId] ?? 0;
}

const VERBS: readonly Verb[] = [
  {
    words: ['올려', '올려줘', '키워', '키워줘', '크게', 'up', 'louder', 'boost', 'raise'],
    apply: (c) => [{ kind: 'trackVolume', trackId: c.track.id, db: c.track.volumeDb + amountOf(c) }],
    describe: (c) => `${c.track.name} 를 ${amountOf(c).toFixed(1)} dB 올립니다`,
  },
  {
    words: ['내려', '내려줘', '줄여', '줄여줘', '작게', '다운', 'down', 'quieter', 'lower', 'cut'],
    apply: (c) => [{ kind: 'trackVolume', trackId: c.track.id, db: c.track.volumeDb - amountOf(c) }],
    describe: (c) => `${c.track.name} 를 ${amountOf(c).toFixed(1)} dB 내립니다`,
  },
  {
    words: ['앞으로', '앞에', 'front', 'forward', '살려', '드러나게'],
    // "Forward" is not one control: a little level, a little presence, a
    // little less space.  That is what an engineer does when asked this.
    apply: (c) => [
      { kind: 'trackVolume', trackId: c.track.id, db: c.track.volumeDb + 1.5 * c.scale },
      macroAction(c.track, 'clarity', currentMacro(c.track, 'clarity') + 0.25 * c.scale),
      macroAction(c.track, 'depth', Math.max(0, currentMacro(c.track, 'depth') - 0.15 * c.scale)),
    ],
    describe: (c) => `${c.track.name} 를 앞으로 — 레벨 +${(1.5 * c.scale).toFixed(1)} dB, CLARITY 상승, DEPTH 감소`,
  },
  {
    words: ['뒤로', '뒤에', 'back', 'behind', '묻어', '눕혀'],
    apply: (c) => [
      { kind: 'trackVolume', trackId: c.track.id, db: c.track.volumeDb - 1.5 * c.scale },
      macroAction(c.track, 'depth', currentMacro(c.track, 'depth') + 0.25 * c.scale),
    ],
    describe: (c) => `${c.track.name} 를 뒤로 — 레벨 −${(1.5 * c.scale).toFixed(1)} dB, DEPTH 상승`,
  },
  {
    words: ['따뜻하게', '따듯하게', '두껍게', 'warm', 'warmer', 'thick'],
    apply: (c) => [macroAction(c.track, 'warmth', currentMacro(c.track, 'warmth') + 0.3 * c.scale)],
    describe: (c) => `${c.track.name} WARMTH ${Math.round(Math.min(1, currentMacro(c.track, 'warmth') + 0.3 * c.scale) * 100)}%`,
  },
  {
    words: ['밝게', '선명하게', '또렷하게', 'bright', 'brighter', 'clear', 'clarity'],
    apply: (c) => [macroAction(c.track, 'clarity', currentMacro(c.track, 'clarity') + 0.3 * c.scale)],
    describe: (c) => `${c.track.name} CLARITY ${Math.round(Math.min(1, currentMacro(c.track, 'clarity') + 0.3 * c.scale) * 100)}%`,
  },
  {
    words: ['공기감', '에어', 'air', 'airy', '반짝'],
    apply: (c) => [macroAction(c.track, 'air', currentMacro(c.track, 'air') + 0.3 * c.scale)],
    describe: (c) => `${c.track.name} AIR ${Math.round(Math.min(1, currentMacro(c.track, 'air') + 0.3 * c.scale) * 100)}%`,
  },
  {
    words: ['펀치', '때려', 'punch', 'punchy', '단단하게'],
    apply: (c) => [macroAction(c.track, 'punch', currentMacro(c.track, 'punch') + 0.3 * c.scale)],
    describe: (c) => `${c.track.name} PUNCH ${Math.round(Math.min(1, currentMacro(c.track, 'punch') + 0.3 * c.scale) * 100)}%`,
  },
  {
    words: ['넓게', '넓혀', 'wide', 'wider', '벌려'],
    apply: (c) => [macroAction(c.track, 'width', currentMacro(c.track, 'width') + 0.3 * c.scale)],
    describe: (c) => `${c.track.name} WIDTH ${Math.round(Math.min(1, currentMacro(c.track, 'width') + 0.3 * c.scale) * 100)}%`,
  },
  {
    words: ['좁게', '좁혀', 'narrow', 'mono', '모노로'],
    apply: (c) => [macroAction(c.track, 'width', currentMacro(c.track, 'width') - 0.3 * c.scale)],
    describe: (c) => `${c.track.name} WIDTH ${Math.round(Math.max(0, currentMacro(c.track, 'width') - 0.3 * c.scale) * 100)}%`,
  },
  {
    words: ['왼쪽', '좌로', 'left', '왼쪽으로'],
    apply: (c) => [{ kind: 'trackPan', trackId: c.track.id, pan: c.track.pan - 0.3 * c.scale }],
    describe: (c) => `${c.track.name} 를 왼쪽으로`,
  },
  {
    words: ['오른쪽', '우로', 'right', '오른쪽으로'],
    apply: (c) => [{ kind: 'trackPan', trackId: c.track.id, pan: c.track.pan + 0.3 * c.scale }],
    describe: (c) => `${c.track.name} 를 오른쪽으로`,
  },
  {
    words: ['가운데', '센터', 'center', 'centre'],
    apply: (c) => [{ kind: 'trackPan', trackId: c.track.id, pan: 0 }],
    describe: (c) => `${c.track.name} 를 가운데로`,
  },
  {
    words: ['치찰음', '시빌런스', '디에서', 'de-ess', 'deess', 'sibilance'],
    apply: (c) => [
      { kind: 'addInsert', trackId: c.track.id, pluginId: 'deesser' },
      { kind: 'insertParam', trackId: c.track.id, pluginId: 'deesser', paramId: 'amount', value: 0.5 * c.scale },
    ],
    describe: (c) => `${c.track.name} 에 디에서를 걸어 치찰음을 잡습니다`,
  },
  {
    words: ['재즈', 'jazz', 'jazzy', '재즈스럽게', '재즈풍으로'],
    apply: (c) => (c.session.chordTrack.length === 0
      ? null
      : [{ kind: 'reharmonize', options: { extend: true, insertTwoFive: true } }]),
    describe: () => '코드 진행을 재즈풍으로 리하모나이즈합니다',
  },
];

// ── Parsing ───────────────────────────────────────────────────────────────────

const BAND_WORDS: readonly { words: readonly string[]; band: 'low' | 'mid' | 'high' }[] = [
  { words: ['저역', '저음', '로우', 'low', 'bass end', '베이스감'], band: 'low' },
  { words: ['중역', '중음', '미드', 'mid', 'middle'], band: 'mid' },
  { words: ['고역', '고음', '하이', 'high', 'treble', '트레블'], band: 'high' },
];

const MORE = ['많이', '확', '아주', '훨씬', 'a lot', 'much', 'more'];
const LESS = ['조금', '살짝', '약간', '쬐끔', 'a bit', 'slightly', 'little'];

/** A number followed by dB, or a bare number treated as dB. */
function parseAmount(text: string): number | null {
  const explicit = /(-?\d+(?:\.\d+)?)\s*(?:db|dB|디비|데시벨)/.exec(text);
  if (explicit?.[1]) return Math.abs(Number(explicit[1]));
  const bare = /(-?\d+(?:\.\d+)?)/.exec(text);
  if (bare?.[1]) {
    const value = Math.abs(Number(bare[1]));
    // A bare number bigger than 24 is almost certainly a frequency or a bar
    // number, not a decibel amount.
    return value > 0 && value <= 24 ? value : null;
  }
  return null;
}

function parseScale(text: string): number {
  if (MORE.some((w) => mentions(text, w))) return 2;
  if (LESS.some((w) => mentions(text, w))) return 0.5;
  return 1;
}

function parseBand(text: string): 'low' | 'mid' | 'high' | null {
  for (const entry of BAND_WORDS) {
    if (entry.words.some((w) => mentions(text, w))) return entry.band;
  }
  return null;
}

/** Find the track the phrase is about. */
export function resolveTarget(
  session: DawSession, text: string, focusedTrackId?: TrackId | null,
): { track: Track; how: string } | null {
  const lower = text.toLowerCase();

  // 1. An exact track name wins — the user typed what they see.
  const named = session.tracks
    .filter((t) => t.name.length >= 2 && lower.includes(t.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return { track: named, how: `이름 "${named.name}"` };

  // 2. The master, by any of its words.
  if (MASTER_WORDS.some((w) => mentions(lower, w))) {
    const master = session.tracks.find((t) => t.kind === 'master');
    if (master) return { track: master, how: '마스터' };
  }

  // 3. A role word, matched against the tracks' own inferred roles.
  for (const entry of ROLE_WORDS) {
    if (!entry.words.some((w) => mentions(lower, w))) continue;
    const match = session.tracks.find((t) => guessRole(t.name, t.kind).role === entry.role);
    if (match) return { track: match, how: `${roleLabel(entry.role)} 트랙` };
    return null;                      // the word was understood, the track is missing
  }

  // 4. "여기" / "this" — whatever is focused.
  if (focusedTrackId && /여기|이거|이 트랙|this/.test(lower)) {
    const focused = findTrack(session, focusedTrackId);
    if (focused) return { track: focused, how: '선택된 트랙' };
  }
  return null;
}

/**
 * Parse one instruction.  Never applies anything: the caller shows the
 * interpretation, the user agrees, and only then are the actions applied.
 */
export function interpret(
  session: DawSession, text: string, focusedTrackId: TrackId | null = null,
): Interpretation {
  const raw = text.trim();
  if (raw.length === 0) return { understood: '', actions: [], error: '무엇을 할까요?' };
  const lower = raw.toLowerCase();

  const verb = VERBS.find((v) => v.words.some((w) => mentions(lower, w)));
  if (!verb) {
    return {
      understood: '',
      actions: [],
      error: '무슨 동작인지 모르겠습니다',
      hint: '예: "보컬 2dB 올려", "킥 펀치 더", "마스터 넓게", "코드 재즈스럽게"',
    };
  }

  // Chord work is about the session, not a track.
  const chordOnly = verb.words.includes('재즈');
  const target = chordOnly ? null : resolveTarget(session, raw, focusedTrackId);
  if (!chordOnly && !target) {
    return {
      understood: '',
      actions: [],
      error: '어떤 트랙인지 모르겠습니다',
      hint: '트랙 이름을 그대로 쓰거나 "보컬 · 킥 · 베이스 · 마스터" 처럼 말해 주세요',
    };
  }

  const track = target?.track ?? session.tracks.find((t) => t.kind === 'master');
  if (!track) return { understood: '', actions: [], error: '트랙이 없습니다' };

  const context: VerbContext = {
    session,
    track,
    amountDb: parseAmount(raw),
    scale: parseScale(lower),
    band: parseBand(lower),
  };

  const actions = verb.apply(context);
  if (!actions || actions.length === 0) {
    return {
      understood: '',
      actions: [],
      error: chordOnly ? '코드 트랙이 비어 있습니다' : '적용할 동작을 만들지 못했습니다',
      ...(chordOnly ? { hint: '먼저 코드를 감지하세요 (Mod+Shift+C)' } : {}),
    };
  }

  // A band word narrows a level move into an EQ move — "보컬 저역 좀 줄여".
  const narrowed = context.band && !chordOnly
    ? narrowToBand(context, actions)
    : actions;

  return {
    understood: context.band && !chordOnly
      ? `${track.name} ${bandLabel(context.band)} ${describeBandMove(context, actions)}`
      : verb.describe(context),
    actions: narrowed,
    ...(target ? { hint: `대상: ${target.how}` } : {}),
  };
}

function bandLabel(band: 'low' | 'mid' | 'high'): string {
  return band === 'low' ? '저역' : band === 'mid' ? '중역' : '고역';
}

/** A level verb plus a band word means EQ, not fader. */
function narrowToBand(context: VerbContext, actions: readonly IntelAction[]): IntelAction[] {
  const volume = actions.find((a) => a.kind === 'trackVolume');
  if (!volume || volume.kind !== 'trackVolume') return [...actions];
  const move = volume.db - context.track.volumeDb;
  const paramId = context.band === 'low' ? 'lowDb' : context.band === 'high' ? 'highDb' : 'midDb';
  const out: IntelAction[] = [{
    kind: 'insertParam', trackId: context.track.id, pluginId: 'eq3', paramId, value: move,
  }];
  if (context.band === 'mid') {
    out.unshift({
      kind: 'insertParam', trackId: context.track.id, pluginId: 'eq3', paramId: 'midHz', value: 1000,
    });
  }
  return out;
}

function describeBandMove(context: VerbContext, actions: readonly IntelAction[]): string {
  const volume = actions.find((a) => a.kind === 'trackVolume');
  if (!volume || volume.kind !== 'trackVolume') return '조정';
  const move = volume.db - context.track.volumeDb;
  return `${move >= 0 ? '+' : ''}${move.toFixed(1)} dB (EQ)`;
}

/** Everything the parser knows, for the help panel. */
export function vocabulary(): { verbs: string[]; targets: string[]; macros: string[] } {
  return {
    verbs: VERBS.map((v) => v.words[0] ?? '').filter(Boolean),
    targets: [...ROLE_WORDS.map((r) => r.words[0] ?? ''), ...MASTER_WORDS.slice(0, 2)].filter(Boolean),
    macros: MACROS.map((m) => m.name),
  };
}
