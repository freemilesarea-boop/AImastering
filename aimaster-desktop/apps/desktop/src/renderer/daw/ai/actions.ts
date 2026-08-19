// The Intelligence Layer's vocabulary.
//
// Every intelligent feature in this DAW — diagnosis, auto-mix, auto-master,
// reference matching, auto-automation, natural language — produces the SAME
// thing: a list of typed actions.  Nothing in this layer touches the session
// directly.
//
// That constraint is what makes the whole layer trustworthy:
//
//   • Everything is previewable.  An action can be described in words before
//     it is applied, so the user reads what will happen and decides.
//   • Everything is undoable, for free.  Actions go through the same
//     `apply()` the UI uses, so one intelligent move is one undo step.
//   • Everything is testable.  A suggestion engine is a pure function from
//     measurements to actions, with no audio and no I/O in the test.
//   • The natural-language front end is replaceable.  Today a deterministic
//     parser produces these actions; a model could produce them tomorrow and
//     nothing downstream would change.
//
// An action that cannot be described in one sentence does not belong here.

import { createInsert, findTrack, setInsert, updateClip, updateTrack } from '../model/session-ops.js';
import { clipNotes, writeClipNotes } from '../model/patterns.js';
import { noteEnd, type MidiNote } from '../model/midi.js';
import { setChordTrack } from '../model/session-ops.js';
import { createLane } from '../model/automation.js';
import { setMacro, MACROS, type MacroId } from '../model/macros.js';
import { findPlugin, defaultParams } from '../engine/plugins.js';
import { reharmonize, formatProgression, type ReharmonizeOptions } from '../model/chords.js';
import type {
  AutomationMode, AutomationPoint, AutomationTarget, ClipId, DawSession, Insert, TrackId,
} from '../model/types.js';

export type IntelAction =
  /** Absolute fader position. */
  | { kind: 'trackVolume'; trackId: TrackId; db: number }
  | { kind: 'trackPan'; trackId: TrackId; pan: number }
  /** One of the seven macro knobs. */
  | { kind: 'macro'; trackId: TrackId; macroId: MacroId; value: number }
  /**
   * Set a plugin parameter.  The insert is created from defaults if the track
   * does not have that plugin yet — a suggestion should not fail because the
   * chain has not been built.
   */
  | { kind: 'insertParam'; trackId: TrackId; pluginId: string; paramId: string; value: number; slot?: number }
  | { kind: 'addInsert'; trackId: TrackId; pluginId: string; slot?: number; params?: Record<string, number> }
  | { kind: 'removeInsert'; trackId: TrackId; slot: number }
  | { kind: 'bypassInsert'; trackId: TrackId; slot: number; bypass: boolean }
  /** Write a whole automation lane — the output of auto-riding and ducking. */
  | { kind: 'automation'; trackId: TrackId; target: AutomationTarget; points: AutomationPoint[]; mode?: AutomationMode }
  | { kind: 'reharmonize'; options: ReharmonizeOptions }
  /**
   * Write notes into a MIDI part — the Riff Machine's output.
   *
   * It goes through `writeClipNotes`, so a pattern-backed clip has its
   * PATTERN rewritten and every placement of it changes at once.  `add` keeps
   * what is there, which is how a generated bass line joins a part that
   * already has something in it.
   */
  | { kind: 'writeNotes'; trackId: TrackId; clipId: ClipId; notes: MidiNote[]; mode?: 'replace' | 'add' };

export interface Suggestion {
  id: string;
  /** One sentence, in the user's language. */
  title: string;
  /** Why — the measurement that motivated it. */
  reason: string;
  /** 0…1.  Below 0.5 the UI should not pre-select it. */
  confidence: number;
  actions: IntelAction[];
}

// ── Applying ──────────────────────────────────────────────────────────────────

const FIRST_FREE_SLOT = 0;

/** The slot a plugin already occupies on a track, or the first free one. */
function slotFor(session: DawSession, trackId: TrackId, pluginId: string, preferred?: number): number {
  const track = findTrack(session, trackId);
  if (!track) return preferred ?? FIRST_FREE_SLOT;
  const existing = track.inserts.find((i) => i.pluginId === pluginId);
  if (existing) return existing.slot;
  if (preferred !== undefined && !track.inserts.some((i) => i.slot === preferred)) return preferred;
  for (let slot = 0; slot < 10; slot++) {
    if (!track.inserts.some((i) => i.slot === slot)) return slot;
  }
  return 9;
}

function insertFor(
  session: DawSession, trackId: TrackId, pluginId: string, slot: number,
): Insert {
  const track = findTrack(session, trackId);
  const existing = track?.inserts.find((i) => i.pluginId === pluginId);
  if (existing) return existing;
  const plugin = findPlugin(pluginId);
  return createInsert(slot, pluginId, plugin?.name ?? pluginId, {
    params: defaultParams(pluginId),
  });
}

/** Clamp to whatever the plugin says it accepts — a suggestion is not a bypass. */
function clampParam(pluginId: string, paramId: string, value: number): number {
  const spec = findPlugin(pluginId)?.params.find((p) => p.id === paramId);
  if (!spec) return value;
  return Math.max(spec.min, Math.min(spec.max, value));
}

export function applyAction(session: DawSession, action: IntelAction): DawSession {
  switch (action.kind) {
    case 'trackVolume':
      return updateTrack(session, action.trackId, (t) => ({
        ...t, volumeDb: Math.max(-60, Math.min(12, action.db)),
      }));

    case 'trackPan':
      return updateTrack(session, action.trackId, (t) => ({
        ...t, pan: Math.max(-1, Math.min(1, action.pan)),
      }));

    case 'macro':
      return updateTrack(session, action.trackId, (t) => ({
        ...t, macros: setMacro(t.macros, action.macroId, action.value),
      }));

    case 'insertParam': {
      const slot = slotFor(session, action.trackId, action.pluginId, action.slot);
      const insert = insertFor(session, action.trackId, action.pluginId, slot);
      return setInsert(session, action.trackId, {
        ...insert,
        params: {
          ...insert.params,
          [action.paramId]: clampParam(action.pluginId, action.paramId, action.value),
        },
      });
    }

    case 'addInsert': {
      const slot = slotFor(session, action.trackId, action.pluginId, action.slot);
      const insert = insertFor(session, action.trackId, action.pluginId, slot);
      const params = { ...insert.params };
      for (const [id, value] of Object.entries(action.params ?? {})) {
        params[id] = clampParam(action.pluginId, id, value);
      }
      return setInsert(session, action.trackId, { ...insert, params });
    }

    case 'removeInsert':
      return updateTrack(session, action.trackId, (t) => ({
        ...t, inserts: t.inserts.filter((i) => i.slot !== action.slot),
      }));

    case 'bypassInsert':
      return updateTrack(session, action.trackId, (t) => ({
        ...t,
        inserts: t.inserts.map((i) => (i.slot === action.slot ? { ...i, bypass: action.bypass } : i)),
      }));

    case 'automation':
      return updateTrack(session, action.trackId, (t) => {
        const existing = t.automation.find((l) => sameTarget(l.target, action.target));
        const points = [...action.points].sort((a, b) => a.timeSec - b.timeSec);
        if (existing) {
          return {
            ...t,
            automation: t.automation.map((l) => (l.id === existing.id
              ? { ...l, points, mode: action.mode ?? l.mode, visible: true }
              : l)),
          };
        }
        const lane = createLane(action.target, points[0]?.value ?? 0, action.mode ?? 'read');
        return { ...t, automation: [...t.automation, { ...lane, points, visible: true }] };
      });

    case 'reharmonize':
      return setChordTrack(session, reharmonize(session.chordTrack, action.options));

    case 'writeNotes': {
      const existing = clipNotesOf(session, action.trackId, action.clipId);
      const next = action.mode === 'add' ? [...existing, ...action.notes] : action.notes;
      const written = writeClipNotes(session, action.trackId, action.clipId, sortNotes(next));
      // A part always covers its notes, or the tail of the riff never plays.
      return updateClip(written, action.trackId, action.clipId, (c) => ({
        ...c,
        durationSec: Math.max(c.durationSec, next.reduce((m, n) => Math.max(m, noteEnd(n)), 0)),
      }));
    }
  }
}

function clipNotesOf(session: DawSession, trackId: TrackId, clipId: ClipId): MidiNote[] {
  const track = findTrack(session, trackId);
  const clip = track?.playlists.flatMap((p) => p.clips).find((c) => c.id === clipId);
  return clip ? clipNotes(session, clip) : [];
}

const sortNotes = (notes: MidiNote[]): MidiNote[] =>
  [...notes].sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);

function sameTarget(a: AutomationTarget, b: AutomationTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'plugin' && b.kind === 'plugin') {
    return a.insertId === b.insertId && a.paramId === b.paramId;
  }
  if ((a.kind === 'sendLevel' || a.kind === 'sendPan' || a.kind === 'sendMute')
    && (b.kind === 'sendLevel' || b.kind === 'sendPan' || b.kind === 'sendMute')) {
    return a.sendId === b.sendId;
  }
  return true;
}

export function applyActions(session: DawSession, actions: readonly IntelAction[]): DawSession {
  return actions.reduce(applyAction, session);
}

export function applySuggestions(
  session: DawSession, suggestions: readonly Suggestion[],
): DawSession {
  return suggestions.reduce((s, suggestion) => applyActions(s, suggestion.actions), session);
}

// ── Describing ────────────────────────────────────────────────────────────────

const signed = (v: number, digits = 1): string => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

/** One sentence per action.  If it cannot be said, it should not be done. */
export function describeAction(session: DawSession, action: IntelAction): string {
  const name = (id: TrackId): string => findTrack(session, id)?.name ?? '트랙';
  switch (action.kind) {
    case 'trackVolume':
      return `${name(action.trackId)} 페이더 ${signed(action.db)} dB`;
    case 'trackPan': {
      const pan = action.pan;
      const where = Math.abs(pan) < 0.02 ? '가운데'
        : `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
      return `${name(action.trackId)} 팬 ${where}`;
    }
    case 'macro': {
      const macro = MACROS.find((m) => m.id === action.macroId);
      return `${name(action.trackId)} ${macro?.name ?? action.macroId} ${Math.round(action.value * 100)}%`;
    }
    case 'insertParam': {
      const plugin = findPlugin(action.pluginId);
      const spec = plugin?.params.find((p) => p.id === action.paramId);
      const unit = spec?.unit ? ` ${spec.unit}` : '';
      const value = spec?.unit === 'dB' ? signed(action.value) : action.value.toFixed(2);
      return `${name(action.trackId)} ${plugin?.name ?? action.pluginId} · ${spec?.name ?? action.paramId} ${value}${unit}`;
    }
    case 'addInsert':
      return `${name(action.trackId)} 에 ${findPlugin(action.pluginId)?.name ?? action.pluginId} 추가`;
    case 'removeInsert':
      return `${name(action.trackId)} 슬롯 ${action.slot} 인서트 제거`;
    case 'bypassInsert':
      return `${name(action.trackId)} 슬롯 ${action.slot} ${action.bypass ? '바이패스' : '활성화'}`;
    case 'automation': {
      const target = action.target.kind === 'volume' ? '볼륨'
        : action.target.kind === 'pan' ? '팬'
        : action.target.kind === 'plugin' ? '플러그인 파라미터'
        : action.target.kind;
      return `${name(action.trackId)} ${target} 오토메이션 ${action.points.length}포인트`;
    }
    case 'reharmonize':
      return `코드 진행 리하모나이즈 → ${formatProgression(reharmonize(session.chordTrack, action.options))}`;
    case 'writeNotes':
      return `${name(action.trackId)} 에 노트 ${action.notes.length}개`
        + `${action.mode === 'add' ? ' 추가' : ' 쓰기 (기존 노트 대체)'}`;
  }
}

export function describeSuggestion(session: DawSession, suggestion: Suggestion): string {
  return suggestion.actions.map((a) => describeAction(session, a)).join(' · ');
}
