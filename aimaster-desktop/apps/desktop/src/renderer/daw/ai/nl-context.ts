// What the model is allowed to know.
//
// A language model cannot see the session, so something has to describe it.
// That description is the single most important input to this feature, and it
// is built here rather than assembled at the call site, for two reasons.
//
// FIRST, THE MODEL CAN ONLY NAME WHAT IS IN THE BRIEF.  Every track carries
// its real id, every device its real parameter list with real ranges.  A model
// that has been handed `eq3.lowDb ∈ [-18, 18] dB` does not invent `bassBoost`.
// The validator in nl-protocol.ts refuses anything unreal anyway, but a brief
// that tells the truth means the validator rarely has to fire — and a refusal
// the user never sees is worth more than a good error message.
//
// SECOND, IT IS DETERMINISTIC.  Same session, same bytes: tracks in session
// order, devices in registry order, numbers rounded to a fixed number of
// digits.  That is what makes the device catalogue — the big, unchanging half
// of the prompt — cacheable.  A `Date.now()` or an unordered `Object.keys()`
// in here would silently cost real money on every request.
//
// What is deliberately NOT in the brief: audio, file paths, note data, and
// anything the user did not put in the session themselves.  This text leaves
// the machine.  A mix brief is the smallest thing that answers "보컬 좀 더
// 앞으로", and the smallest thing is the right thing to send.

import { PLUGINS } from '../engine/plugins.js';
import { MACROS } from '../model/macros.js';
import { formatProgression } from '../model/chords.js';
import { sectionsOf, sectionLabel } from '../model/arrangement.js';
import { guessRole, roleLabel } from './roles.js';
import type { DawSession, Track, TrackId } from '../model/types.js';

/** Two digits everywhere, so a fader that did not move produces the same byte. */
const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface TrackBrief {
  id: string;
  name: string;
  kind: string;
  /** What the app thinks it is — the model may disagree, the user decides. */
  role: string;
  volumeDb: number;
  pan: number;
  muted?: true;
  soloed?: true;
  /** `slot:pluginId` — enough to say "already has an EQ in slot 0". */
  inserts: string[];
  /** Only the macros that are not at zero; seven zeroes is noise. */
  macros?: Record<string, number>;
  focused?: true;
}

export interface SessionBrief {
  name: string;
  tempoBpm: number;
  timeSignature: string;
  lengthSec: number;
  tracks: TrackBrief[];
  sections?: string[];
  chords?: string;
}

function trackBrief(track: Track, focused: boolean): TrackBrief {
  const macros: Record<string, number> = {};
  for (const macro of MACROS) {
    const value = track.macros.values[macro.id] ?? 0;
    if (value > 0) macros[macro.id] = round2(value);
  }
  return {
    id: track.id,
    name: track.name,
    kind: track.kind,
    role: roleLabel(guessRole(track.name, track.kind).role),
    volumeDb: round2(track.volumeDb),
    pan: round2(track.pan),
    ...(track.mute ? { muted: true as const } : {}),
    ...(track.solo ? { soloed: true as const } : {}),
    inserts: [...track.inserts]
      .sort((a, b) => a.slot - b.slot)
      .map((i) => `${i.slot}:${i.pluginId}${i.bypass ? ' (바이패스)' : ''}`),
    ...(Object.keys(macros).length > 0 ? { macros } : {}),
    ...(focused ? { focused: true as const } : {}),
  };
}

/** The session, as the model sees it. */
export function sessionBrief(
  session: DawSession, focusedTrackId: TrackId | null = null,
): SessionBrief {
  const sections = sectionsOf(session);
  const lengthSec = session.tracks.reduce((end, track) => track.playlists.reduce(
    (e, playlist) => playlist.clips.reduce(
      (c, clip) => Math.max(c, clip.startSec + clip.durationSec), e),
    end), 0);
  return {
    name: session.name,
    tempoBpm: round2(session.tempoBpm),
    timeSignature: `${session.timeSignature[0]}/${session.timeSignature[1]}`,
    lengthSec: round2(lengthSec),
    tracks: session.tracks.map((t) => trackBrief(t, t.id === focusedTrackId)),
    ...(sections.length > 0
      ? { sections: sections.map((s) => `${s.startSec.toFixed(1)}s ${sectionLabel(s)}`) }
      : {}),
    ...(session.chordTrack.length > 0
      ? { chords: formatProgression(session.chordTrack) }
      : {}),
  };
}

// ── The device catalogue ──────────────────────────────────────────────────────

export interface DeviceBrief {
  id: string;
  name: string;
  category: string;
  /** `paramId  name  min…max unit` — one line each. */
  params: string[];
}

/**
 * Every device and every parameter it really has.
 *
 * Built from `PLUGINS` rather than written by hand, so a device added to the
 * registry is offered to the model the same day it is offered to the user.
 * The alternative — a curated list — goes stale silently, and a model asking
 * for a device that was removed is a bug nobody notices for a month.
 *
 * Offline-only devices are marked, because "그 플러그인 걸어줘" on a device
 * that cannot run live is a different answer, not a failure.
 */
export function deviceCatalog(): DeviceBrief[] {
  return PLUGINS.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    category: plugin.category + (plugin.offline ? ' (오프라인 전용)' : ''),
    params: plugin.params.map((p) => {
      const range = p.choices
        ? `0…${p.choices.length - 1} (${p.choices.join(' / ')})`
        : `${p.min}…${p.max}${p.unit ? ` ${p.unit}` : ''}`;
      return `${p.id}  ${p.name}  ${range}  기본 ${p.default}`;
    }),
  }));
}

/** The seven macro knobs, with what each one actually moves. */
export function macroCatalog(): { id: string; name: string; what: string }[] {
  return MACROS.map((m) => ({ id: m.id, name: m.name, what: m.description }));
}

/**
 * The catalogue as the text that goes in the cached system block.
 *
 * A string rather than JSON because it is read, not parsed: one device per
 * paragraph, one parameter per line, and no braces spending tokens.  Built
 * from the registry in registry order, so the bytes are identical from one
 * request to the next — which is the only reason the cache ever hits.
 */
export function catalogText(): string {
  const devices = deviceCatalog().map((device) => [
    `${device.id} — ${device.name} (${device.category})`,
    ...device.params.map((line) => `  ${line}`),
  ].join('\n'));
  const macros = macroCatalog().map((m) => `  ${m.id} — ${m.name}: ${m.what}`);
  return [
    ...devices,
    '',
    '매크로 (값은 0…1):',
    ...macros,
  ].join('\n');
}
