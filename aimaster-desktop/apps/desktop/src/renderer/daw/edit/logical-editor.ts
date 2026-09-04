// logical-editor.ts — select by rule, change by rule.
//
// Every MIDI edit in this app until now has been a fixed verb: quantize,
// transpose, humanise, legato.  Each one is a good verb and none of them can
// answer "take every note under velocity 40 that lands on an off-beat and
// move it to the previous 1/16, but leave the downbeats alone".  That is not
// an exotic request — it is Tuesday — and there is no way to express it
// except by hand, note by note, which is how a part gets half-edited.
//
// The Logical Editor is the general case: a list of CONDITIONS that picks the
// notes, and a list of ACTIONS that changes them.
//
// Three things about the design are worth stating because they are the parts
// that go quietly wrong:
//
//   THE MATCHED SET IS A SNAPSHOT OF THE ORIGINALS.  It is decided in its own
//   pass and never rewritten by the actions, because it is what the caller
//   uses afterwards: `copy` and `extract` build from it, and the UI selects
//   those notes so you can see what the rule caught.  Reporting the CHANGED
//   notes instead would leave "it matched these" describing something that
//   did not exist when the rule was written.
//
//   VELOCITY IS SPOKEN IN 7-BIT.  The model stores 0…1; every musician,
//   every piece of gear and every other DAW says 1…127.  A rule that reads
//   "velocity < 40" has to mean 40 out of 127, not forty times full scale.
//   The conversion happens at this boundary and nowhere else.
//
//   NOTHING IS SILENTLY DROPPED.  A transpose that would push a note past
//   MIDI's ends CLAMPS and the result says how many it clamped; a divide by
//   zero is refused when the rule is built rather than producing Infinity in
//   the part.  A rule that quietly deletes half a take is worse than one that
//   refuses to run.

import {
  from7bit, sortNotes, to7bit, type MidiNote,
} from '../model/midi.js';
import {
  barBeatAt, beatsPerBar, defaultTempoMap, meterAtBeat, type TempoMap,
} from '../model/tempo-map.js';

// ── What a rule can look at ─────────────────────────────────────────────────

export type Property =
  | 'pitch'
  /** 1…127, the way everything outside this file says it. */
  | 'velocity'
  /** Beats from the part start. */
  | 'position'
  /** Beats. */
  | 'length'
  /** 1-based beat WITHIN the bar — 1 is the downbeat. */
  | 'barBeat'
  /** 1-based bar number. */
  | 'bar'
  /** 0-based. */
  | 'channel'
  /** 0…1. */
  | 'probability'
  /** 0 or 1, so the same comparisons work on it. */
  | 'muted';

export const PROPERTY_LABELS: Record<Property, string> = {
  pitch: '음정',
  velocity: '벨로시티',
  position: '위치 (박)',
  length: '길이 (박)',
  barBeat: '마디 안 박',
  bar: '마디',
  channel: '채널',
  probability: '재생 확률',
  muted: '음소거',
};

export type Comparison =
  | 'equal' | 'unequal' | 'greater' | 'less'
  | 'greaterOrEqual' | 'lessOrEqual'
  | 'inside' | 'outside';

export const COMPARISON_LABELS: Record<Comparison, string> = {
  equal: '=', unequal: '≠', greater: '>', less: '<',
  greaterOrEqual: '≥', lessOrEqual: '≤',
  inside: '범위 안', outside: '범위 밖',
};

export const RANGE_COMPARISONS: ReadonlySet<Comparison> = new Set(['inside', 'outside']);

export interface Condition {
  property: Property;
  comparison: Comparison;
  value: number;
  /** Only read by `inside` / `outside`. */
  value2?: number;
  /**
   * How this line joins the one BEFORE it.  Ignored on the first line.
   *
   * `and` binds tighter than `or`, as it does everywhere else — so
   * `a or b and c` is `a or (b and c)`, which is what somebody writing these
   * left to right expects and what every other rule engine does.
   */
  join?: 'and' | 'or';
}

// ── What a rule can do ──────────────────────────────────────────────────────

export type Operation =
  | 'set' | 'add' | 'subtract' | 'multiply' | 'divide'
  /** Snap to a multiple of `value` — quantise one property by rule. */
  | 'roundTo'
  /** Deterministic spread of ±value, seeded so a rerun repeats exactly. */
  | 'randomize'
  /** Mirror around `value`: 2·value − x.  Inverting a velocity ramp. */
  | 'mirror';

export const OPERATION_LABELS: Record<Operation, string> = {
  set: '값으로', add: '더하기', subtract: '빼기',
  multiply: '곱하기', divide: '나누기',
  roundTo: '배수로 반올림', randomize: '±범위 랜덤', mirror: '기준으로 반전',
};

export interface Action {
  property: Property;
  operation: Operation;
  value: number;
}

/** What the rule does with the notes it matched. */
export type RuleMode =
  /** Change them, leave everything else alone. */
  | 'transform'
  /** Change nothing; hand back which notes matched. */
  | 'select'
  /** Remove them from the part. */
  | 'delete'
  /** Leave the originals and ADD a transformed copy of each. */
  | 'copy'
  /** Remove them from the part and hand them back separately. */
  | 'extract';

export const MODE_LABELS: Record<RuleMode, string> = {
  transform: '변형', select: '선택만', delete: '삭제',
  copy: '복사 후 변형', extract: '빼내기',
};

export interface Rule {
  name: string;
  mode: RuleMode;
  conditions: Condition[];
  actions: Action[];
  /** Seeds `randomize` so the same rule on the same part repeats exactly. */
  seed?: number;
}

export const EMPTY_RULE: Rule = {
  name: '새 규칙', mode: 'transform', conditions: [], actions: [],
};

// ── Reading a property ──────────────────────────────────────────────────────

export interface RuleContext {
  /** Needed only by `bar` and `barBeat`; 4/4 from beat 0 when absent. */
  tempoMap?: TempoMap;
  /** Beats from the SONG start to the part start, for `bar`. */
  partStartBeat?: number;
}

/** Used only by `bar` / `barBeat` when the caller did not pass the song's. */
const FOUR_FOUR: TempoMap = defaultTempoMap(120, [4, 4]);

export function readProperty(
  note: MidiNote, property: Property, context: RuleContext = {},
): number {
  switch (property) {
    case 'pitch':       return note.pitch;
    // The one conversion in the file.  Everything the user types, every
    // number a preset holds, and every comparison here is 1…127.
    case 'velocity':    return to7bit(note.velocity);
    case 'position':    return note.startBeat;
    case 'length':      return note.durationBeat;
    case 'channel':     return note.channel;
    case 'probability': return note.playProbability;
    case 'muted':       return note.muted ? 1 : 0;
    case 'bar':
    case 'barBeat': {
      const map = context.tempoMap ?? FOUR_FOUR;
      const at = barBeatAt(map, (context.partStartBeat ?? 0) + note.startBeat);
      return property === 'bar' ? at.bar : at.beat + at.tick / 960;
    }
  }
}

// ── Matching ────────────────────────────────────────────────────────────────

function compare(value: number, condition: Condition): boolean {
  const { comparison, value: a } = condition;
  if (RANGE_COMPARISONS.has(comparison)) {
    // A range typed backwards is still the range that was meant.  Refusing it
    // would be defensible; silently matching nothing would not.
    const b = condition.value2 ?? a;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const inside = value >= low && value <= high;
    return comparison === 'inside' ? inside : !inside;
  }
  switch (comparison) {
    case 'equal':          return Math.abs(value - a) < 1e-9;
    case 'unequal':        return Math.abs(value - a) >= 1e-9;
    case 'greater':        return value > a;
    case 'less':           return value < a;
    case 'greaterOrEqual': return value >= a - 1e-9;
    case 'lessOrEqual':    return value <= a + 1e-9;
    default:               return false;
  }
}

/**
 * Does this note match?
 *
 * No conditions matches EVERYTHING, which is the useful default: a rule that
 * is only actions is "do this to the whole part", and a rule that matched
 * nothing until a condition was added would look broken.
 *
 * `and` binds tighter than `or`: the conditions are cut into `or`-separated
 * runs, each run is an `and`, and the rule matches if any run does.
 */
export function matches(
  note: MidiNote, conditions: readonly Condition[], context: RuleContext = {},
): boolean {
  if (conditions.length === 0) return true;
  let anyRun = false;
  let run = true;
  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i] as Condition;
    const hit = compare(readProperty(note, condition.property, context), condition);
    if (i > 0 && condition.join === 'or') {
      anyRun = anyRun || run;
      run = hit;
    } else {
      run = i === 0 ? hit : run && hit;
    }
  }
  return anyRun || run;
}

export function selectNotes(
  notes: readonly MidiNote[], rule: Rule, context: RuleContext = {},
): MidiNote[] {
  return notes.filter((n) => matches(n, rule.conditions, context));
}

// ── Changing ────────────────────────────────────────────────────────────────

/** Deterministic from the note id and the seed — a rerun repeats exactly. */
function noteRandom(id: string, seed: number, salt: number): number {
  let h = (seed ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // xorshift32, then to 0…1.
  h ^= h << 13; h >>>= 0;
  h ^= h >> 17;
  h ^= h << 5;  h >>>= 0;
  return h / 4294967296;
}

function applyOperation(
  current: number, action: Action, note: MidiNote, seed: number, index: number,
): number {
  const { operation, value } = action;
  switch (operation) {
    case 'set':       return value;
    case 'add':       return current + value;
    case 'subtract':  return current - value;
    case 'multiply':  return current * value;
    // Refused when the rule is validated; guarded here too so a rule built by
    // hand cannot put Infinity into a part.
    case 'divide':    return value === 0 ? current : current / value;
    case 'roundTo':   return value === 0 ? current : Math.round(current / value) * value;
    case 'mirror':    return 2 * value - current;
    case 'randomize': return current + (noteRandom(note.id, seed, index) * 2 - 1) * value;
  }
}

/** The legal range of each property, and whether it counts in whole numbers. */
const LIMITS: Record<Property, { min: number; max: number; integer: boolean }> = {
  pitch:       { min: 0, max: 127, integer: true },
  velocity:    { min: 1, max: 127, integer: true },
  position:    { min: 0, max: Infinity, integer: false },
  // A note of zero length is inaudible and un-clickable; 1/128 is the floor.
  length:      { min: 1 / 32, max: Infinity, integer: false },
  barBeat:     { min: 1, max: Infinity, integer: false },
  bar:         { min: 1, max: Infinity, integer: true },
  channel:     { min: 0, max: 15, integer: true },
  probability: { min: 0, max: 1, integer: false },
  muted:       { min: 0, max: 1, integer: true },
};

export interface RuleResult {
  notes: MidiNote[];
  /** Which notes the conditions picked, BEFORE anything changed them. */
  matched: MidiNote[];
  /** Removed by `delete` / `extract`. */
  removed: MidiNote[];
  /** Extracted notes, for `extract`.  Empty in every other mode. */
  extracted: MidiNote[];
  /**
   * How many values ran into a limit and were held there.
   *
   * Reported rather than swallowed: a transpose that pushed twelve notes past
   * the top of the keyboard has flattened them onto one pitch, and that is
   * something to be told about rather than to discover by listening.
   */
  clamped: number;
}

function applyActions(
  note: MidiNote, actions: readonly Action[], seed: number,
  context: RuleContext, report: { clamped: number },
): MidiNote {
  let next = note;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i] as Action;
    // `bar` and `barBeat` are read-only: they are a VIEW of the position
    // through the meter, and writing one would mean solving for a beat under
    // a tempo map that can change signature underneath the answer.
    if (action.property === 'bar' || action.property === 'barBeat') continue;

    const current = readProperty(next, action.property, context);
    const raw = applyOperation(current, action, note, seed, i);
    const limit = LIMITS[action.property];
    let value = limit.integer ? Math.round(raw) : raw;
    if (value < limit.min || value > limit.max) {
      report.clamped += 1;
      value = Math.max(limit.min, Math.min(limit.max, value));
    }

    switch (action.property) {
      case 'pitch':       next = { ...next, pitch: value }; break;
      case 'velocity':    next = { ...next, velocity: from7bit(value) }; break;
      case 'position':    next = { ...next, startBeat: value }; break;
      case 'length':      next = { ...next, durationBeat: value }; break;
      case 'channel':     next = { ...next, channel: value }; break;
      case 'probability': next = { ...next, playProbability: value }; break;
      case 'muted':       next = { ...next, muted: value >= 0.5 }; break;
      default: break;
    }
  }
  return next;
}

/**
 * Run a rule over a part.
 *
 * The matched set is decided FIRST, from the untouched notes, and only then
 * changed — see the note at the top of the file about why.
 */
export function runRule(
  notes: readonly MidiNote[], rule: Rule, context: RuleContext = {},
): RuleResult {
  const seed = rule.seed ?? 0x5EED;
  const report = { clamped: 0 };
  const matchedIds = new Set<string>();
  const matched: MidiNote[] = [];
  for (const note of notes) {
    if (!matches(note, rule.conditions, context)) continue;
    matchedIds.add(note.id);
    matched.push(note);
  }

  const empty = { matched, removed: [] as MidiNote[], extracted: [] as MidiNote[] };

  switch (rule.mode) {
    case 'select':
      return { ...empty, notes: [...notes], clamped: 0 };

    case 'delete':
      return {
        ...empty,
        notes: notes.filter((n) => !matchedIds.has(n.id)),
        removed: matched,
        clamped: 0,
      };

    case 'extract': {
      const taken = matched.map((n) => applyActions(n, rule.actions, seed, context, report));
      return {
        ...empty,
        notes: notes.filter((n) => !matchedIds.has(n.id)),
        removed: matched,
        extracted: sortNotes(taken),
        clamped: report.clamped,
      };
    }

    case 'copy': {
      // The copies get new ids, or the part would hold two notes claiming to
      // be the same one and every id-keyed thing downstream — selection, the
      // drum-map cache, undo — would pick whichever it found first.
      const copies = matched.map((n, i) => applyActions(
        { ...n, id: `${n.id}-copy${i}` }, rule.actions, seed, context, report));
      return { ...empty, notes: sortNotes([...notes, ...copies]), clamped: report.clamped };
    }

    default:
      return {
        ...empty,
        notes: sortNotes(notes.map((n) => (matchedIds.has(n.id)
          ? applyActions(n, rule.actions, seed, context, report)
          : n))),
        clamped: report.clamped,
      };
  }
}

// ── Refusing a rule that cannot mean anything ───────────────────────────────

/**
 * Why this rule will not run, or null.
 *
 * Checked when the rule is built rather than while it runs, so a broken rule
 * is a message next to the button instead of a part full of Infinity.
 */
export function ruleProblem(rule: Rule): string | null {
  for (const action of rule.actions) {
    if (action.operation === 'divide' && action.value === 0) {
      return '0 으로 나눌 수 없습니다';
    }
    if (action.operation === 'roundTo' && action.value <= 0) {
      return '반올림 단위는 0보다 커야 합니다';
    }
    if (action.property === 'bar' || action.property === 'barBeat') {
      return `${PROPERTY_LABELS[action.property]} 은(는) 위치를 보는 방식이라 직접 바꿀 수 없습니다 — 위치를 바꾸세요`;
    }
  }
  // `select`, `delete` and `extract` all do something on their own — taking
  // the bass line out of a part unchanged is the point of extract, not an
  // unfinished rule.  `transform` and `copy` are the two that need an action:
  // a transform that changes nothing is a no-op, and a copy that changes
  // nothing lays a second identical note on top of every first one.
  if ((rule.mode === 'transform' || rule.mode === 'copy') && rule.actions.length === 0) {
    return '동작이 하나도 없습니다';
  }
  return null;
}

// ── Saying what it will do ──────────────────────────────────────────────────

export function describeCondition(condition: Condition): string {
  const name = PROPERTY_LABELS[condition.property];
  const op = COMPARISON_LABELS[condition.comparison];
  if (RANGE_COMPARISONS.has(condition.comparison)) {
    const b = condition.value2 ?? condition.value;
    return `${name} ${op} ${Math.min(condition.value, b)}…${Math.max(condition.value, b)}`;
  }
  return `${name} ${op} ${condition.value}`;
}

export function describeAction(action: Action): string {
  return `${PROPERTY_LABELS[action.property]} ${OPERATION_LABELS[action.operation]} ${action.value}`;
}

export function describeRule(rule: Rule): string {
  const conditions = rule.conditions.length === 0
    ? '모든 노트'
    : rule.conditions.map((c, i) =>
      (i > 0 ? `${c.join === 'or' ? '또는 ' : '그리고 '}` : '') + describeCondition(c)).join(' ');
  const actions = rule.actions.map(describeAction).join(', ');
  const tail = rule.mode === 'select' ? '' : rule.mode === 'delete' ? '' : ` → ${actions}`;
  return `${MODE_LABELS[rule.mode]}: ${conditions}${tail}`;
}

/** What a run did, for the notification after the button. */
export function describeResult(rule: Rule, result: RuleResult): string {
  const n = result.matched.length;
  if (n === 0) return '조건에 맞는 노트가 없습니다';
  const clamped = result.clamped > 0 ? ` · 한계에 걸린 값 ${result.clamped}개` : '';
  switch (rule.mode) {
    case 'select':  return `${n}개 선택${clamped}`;
    case 'delete':  return `${n}개 삭제`;
    case 'extract': return `${n}개 빼냄${clamped}`;
    case 'copy':    return `${n}개 복사 후 변형${clamped}`;
    default:        return `${n}개 변형${clamped}`;
  }
}

// ── Presets ─────────────────────────────────────────────────────────────────

/**
 * Rules worth having ready.
 *
 * Each one is something the fixed verbs cannot express, which is the test for
 * whether it belongs here: "quantize everything" is not a preset, it is the
 * quantize button.
 */
export const RULE_PRESETS: readonly Rule[] = [
  {
    name: '고스트 노트만 더 여리게',
    mode: 'transform',
    conditions: [{ property: 'velocity', comparison: 'less', value: 45 }],
    actions: [{ property: 'velocity', operation: 'multiply', value: 0.7 }],
  },
  {
    name: '다운비트 강조',
    mode: 'transform',
    conditions: [{ property: 'barBeat', comparison: 'equal', value: 1 }],
    actions: [{ property: 'velocity', operation: 'add', value: 18 }],
  },
  {
    name: '엇박만 살짝 뒤로 (스윙 흉내)',
    mode: 'transform',
    conditions: [
      { property: 'barBeat', comparison: 'unequal', value: 1 },
      { property: 'barBeat', comparison: 'unequal', value: 3, join: 'and' },
    ],
    actions: [{ property: 'position', operation: 'add', value: 0.03 }],
  },
  {
    name: '아주 짧은 노트 지우기',
    mode: 'delete',
    conditions: [{ property: 'length', comparison: 'less', value: 0.05 }],
    actions: [],
  },
  {
    name: '베이스 음역만 빼내기',
    mode: 'extract',
    conditions: [{ property: 'pitch', comparison: 'lessOrEqual', value: 47 }],
    actions: [],
  },
  {
    name: '한 옥타브 아래 더블링',
    mode: 'copy',
    conditions: [],
    actions: [
      { property: 'pitch', operation: 'subtract', value: 12 },
      { property: 'velocity', operation: 'multiply', value: 0.8 },
    ],
  },
  {
    name: '벨로시티 뒤집기 (크레셴도 ↔ 디크레셴도)',
    mode: 'transform',
    conditions: [],
    actions: [{ property: 'velocity', operation: 'mirror', value: 64 }],
  },
  {
    name: '사람 손처럼 — 세게 친 것만 살짝 앞으로',
    mode: 'transform',
    conditions: [{ property: 'velocity', comparison: 'greater', value: 100 }],
    actions: [{ property: 'position', operation: 'randomize', value: 0.012 }],
  },
];

/** Bars are the one place a rule needs the song's meter, so expose the width. */
export function barWidthBeats(map: TempoMap | undefined, atBeat: number): number {
  return beatsPerBar(meterAtBeat(map ?? FOUR_FOUR, atBeat));
}
