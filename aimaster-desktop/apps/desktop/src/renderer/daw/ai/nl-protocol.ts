// The contract with the model — and the wall in front of it.
//
// A language model is a text generator.  It does not know that `trk_7` was
// deleted, it will happily write `paramId: "presence"` on a device that has no
// such parameter, and asked for "boost the vocal" it may return `db: 400`.
// None of that is a reason not to use one.  It is a reason to never let its
// output reach the session directly.
//
// So the model does not edit anything.  It proposes, in the vocabulary the
// auto-mix and auto-master already speak (`IntelAction`), and every proposal
// passes through `parsePlan` first:
//
//   NAMES ARE CHECKED AGAINST THE REAL SESSION.  A track id that is not in
//   this session, a pluginId that is not in the registry, a paramId that
//   device does not have, a macro that is not one of the seven — refused.
//
//   NUMBERS ARE CHECKED AND CLAMPED.  Non-finite is refused outright; a value
//   outside a real device's range is clamped to the range and SAID SO, because
//   silently clamping a request for +400 dB to +18 tells the user their
//   instruction was understood when it was not.
//
//   REFUSALS ARE REPORTED, NOT DROPPED.  A plan where three of four actions
//   were thrown away is a plan the user must not read as "understood".
//
// Everything a hallucination can do, then, is: get refused, or produce a
// legal-but-wrong fader move that the user reads as a sentence and declines.
// That is the same exposure the rule parser has, which is the point — the
// front end changed, the trust boundary did not.
//
// Pure.  No network, no SDK types, no Electron.  The thing that talks to
// Anthropic lives in the main process; this file is what makes its answer safe
// and is therefore the one part of the feature that must be testable offline.

import { findPlugin } from '../engine/plugins.js';
import { MACROS, type MacroId } from '../model/macros.js';
import { findTrack } from '../model/session-ops.js';
import type { IntelAction } from './actions.js';
import type { DawSession, TrackId } from '../model/types.js';

/** What the model is asked to return, and what a plan is once it is safe. */
export interface Plan {
  /** One sentence, in the user's language, describing the whole plan. */
  understood: string;
  actions: IntelAction[];
  /** Actions that did not survive validation, each with why. */
  rejected: string[];
  /** Set when the model itself declined to act, with its reason. */
  refusal?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

const MAX_ACTIONS = 24;
const MAX_SLOT = 9;

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.length > 0 ? v : null);

/** Clamp, and say whether it had to.  The caller turns that into a refusal note. */
function clamped(value: number, min: number, max: number): { value: number; hit: boolean } {
  const next = Math.min(max, Math.max(min, value));
  return { value: next, hit: next !== value };
}

interface Checked { action?: IntelAction; problem?: string }

/**
 * One action, checked against this session.
 *
 * Returns either an action or a sentence saying why there is none.  There is
 * deliberately no third outcome: an action that is silently skipped is the
 * failure mode this whole file exists to prevent.
 */
function checkAction(session: DawSession, raw: unknown, index: number): Checked {
  const where = `${index + 1}번째 동작`;
  if (!isRaw(raw)) return { problem: `${where}: 형식이 잘못됐습니다` };

  const kind = str(raw['kind']);
  if (!kind) return { problem: `${where}: 종류가 없습니다` };

  // Every kind below needs a real track, so resolve it once and refuse early.
  const trackId = str(raw['trackId']);
  if (!trackId) return { problem: `${where}(${kind}): 트랙을 지정하지 않았습니다` };
  const track = findTrack(session, trackId as TrackId);
  if (!track) return { problem: `${where}(${kind}): '${trackId}' 트랙이 없습니다` };

  switch (kind) {
    case 'trackVolume': {
      const db = num(raw['db']);
      if (db === null) return { problem: `${where}: 볼륨 값이 숫자가 아닙니다` };
      const fit = clamped(db, -60, 12);
      return {
        action: { kind: 'trackVolume', trackId: track.id, db: fit.value },
        ...(fit.hit ? { problem: `${track.name} 볼륨 ${db.toFixed(1)} dB → ${fit.value} dB 로 제한했습니다` } : {}),
      };
    }

    case 'trackPan': {
      const pan = num(raw['pan']);
      if (pan === null) return { problem: `${where}: 팬 값이 숫자가 아닙니다` };
      const fit = clamped(pan, -1, 1);
      return {
        action: { kind: 'trackPan', trackId: track.id, pan: fit.value },
        ...(fit.hit ? { problem: `${track.name} 팬을 ${fit.value} 로 제한했습니다` } : {}),
      };
    }

    case 'macro': {
      const macroId = str(raw['macroId']);
      if (!macroId || !MACROS.some((m) => m.id === macroId)) {
        return { problem: `${where}: '${macroId ?? '?'}' 는 매크로가 아닙니다` };
      }
      const value = num(raw['value']);
      if (value === null) return { problem: `${where}: 매크로 값이 숫자가 아닙니다` };
      const fit = clamped(value, 0, 1);
      return {
        action: { kind: 'macro', trackId: track.id, macroId: macroId as MacroId, value: fit.value },
        ...(fit.hit ? { problem: `${track.name} ${macroId} 를 ${fit.value} 로 제한했습니다` } : {}),
      };
    }

    case 'insertParam': {
      const pluginId = str(raw['pluginId']);
      const plugin = pluginId ? findPlugin(pluginId) : undefined;
      if (!plugin) return { problem: `${where}: '${pluginId ?? '?'}' 라는 장치가 없습니다` };
      const paramId = str(raw['paramId']);
      const spec = plugin.params.find((p) => p.id === paramId);
      if (!spec) {
        return { problem: `${where}: ${plugin.name} 에 '${paramId ?? '?'}' 파라미터가 없습니다` };
      }
      const value = num(raw['value']);
      if (value === null) return { problem: `${where}: ${spec.name} 값이 숫자가 아닙니다` };
      const fit = clamped(value, spec.min, spec.max);
      const slot = num(raw['slot']);
      return {
        action: {
          kind: 'insertParam', trackId: track.id, pluginId: plugin.id,
          paramId: spec.id, value: fit.value,
          ...(slot !== null && slot >= 0 && slot <= MAX_SLOT ? { slot: Math.round(slot) } : {}),
        },
        ...(fit.hit
          ? { problem: `${plugin.name} · ${spec.name} ${value} → ${fit.value}${spec.unit ? ` ${spec.unit}` : ''} 로 제한했습니다` }
          : {}),
      };
    }

    case 'addInsert': {
      const pluginId = str(raw['pluginId']);
      const plugin = pluginId ? findPlugin(pluginId) : undefined;
      if (!plugin) return { problem: `${where}: '${pluginId ?? '?'}' 라는 장치가 없습니다` };
      const slot = num(raw['slot']);
      return {
        action: {
          kind: 'addInsert', trackId: track.id, pluginId: plugin.id,
          ...(slot !== null && slot >= 0 && slot <= MAX_SLOT ? { slot: Math.round(slot) } : {}),
        },
      };
    }

    case 'removeInsert':
    case 'bypassInsert': {
      const slot = num(raw['slot']);
      if (slot === null) return { problem: `${where}: 슬롯 번호가 없습니다` };
      // Refusing a slot the track does not use is not pedantry: "3번 빼줘" on a
      // chain of two is a misunderstanding, and removing nothing while saying
      // "제거했습니다" is the worst of the three possible outcomes.
      const occupied = track.inserts.some((i) => i.slot === Math.round(slot));
      if (!occupied) {
        return { problem: `${where}: ${track.name} 슬롯 ${Math.round(slot)} 은 비어 있습니다` };
      }
      if (kind === 'removeInsert') {
        return { action: { kind: 'removeInsert', trackId: track.id, slot: Math.round(slot) } };
      }
      const bypass = raw['bypass'];
      if (typeof bypass !== 'boolean') return { problem: `${where}: 바이패스 여부가 없습니다` };
      return { action: { kind: 'bypassInsert', trackId: track.id, slot: Math.round(slot), bypass } };
    }

    default:
      return { problem: `${where}: '${kind}' 는 할 수 있는 동작이 아닙니다` };
  }
}

/**
 * Turn whatever the model returned into a plan that is safe to preview.
 *
 * Never throws.  A model that returns nonsense produces an empty plan with the
 * reason attached, which is a state the UI already knows how to draw.
 */
export function parsePlan(session: DawSession, raw: unknown): Plan {
  if (!isRaw(raw)) {
    return { understood: '', actions: [], rejected: ['모델이 계획을 돌려주지 않았습니다'] };
  }

  const refusal = str(raw['refusal']);
  const understood = str(raw['understood']) ?? '';
  const list = Array.isArray(raw['actions']) ? raw['actions'] : [];

  const actions: IntelAction[] = [];
  const rejected: string[] = [];

  // A plan of two hundred fader moves is not a plan, it is a runaway.  The cap
  // is reported rather than applied quietly.
  const considered = list.slice(0, MAX_ACTIONS);
  if (list.length > MAX_ACTIONS) {
    rejected.push(`동작이 ${list.length}개라 앞의 ${MAX_ACTIONS}개만 봤습니다`);
  }

  considered.forEach((entry, index) => {
    const checked = checkAction(session, entry, index);
    if (checked.action) actions.push(checked.action);
    if (checked.problem) rejected.push(checked.problem);
  });

  return {
    understood,
    actions,
    rejected,
    ...(refusal ? { refusal } : {}),
  };
}

export { PLAN_SCHEMA, PLAN_TOOL_NAME, systemPrompt } from './nl-schema.js';
