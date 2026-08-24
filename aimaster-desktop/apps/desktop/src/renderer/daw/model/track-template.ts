// Track and session templates — starting from where you always start.
//
// Every record begins the same way: the vocal track named the same thing, in
// the same colour, with the same de-esser and the same reverb send; the drum
// bus, the parallel compressor, the tempo, the markers for verse and chorus.
// Rebuilding that by hand is twenty minutes of work that produces no music,
// and doing it slightly differently each time is how two sessions for the same
// artist stop being comparable.
//
// A template is that setup with the MUSIC TAKEN OUT.  What travels is what
// describes a channel; what stays behind is everything that describes a
// performance.  The line between those two is the whole design:
//
//   CLIPS, PLAYLISTS, AUTOMATION AND FREEZE DO NOT TRAVEL.  They are the
//   session, not the setup.  An automation lane carried into a new project
//   would be fader moves at timecodes from a different song, and a frozen
//   state would point at a rendered file that this session has never heard of.
//
//   BUSES TRAVEL BY NAME.  A bus id from the session a template was saved in
//   names nothing anywhere else.  Applying a template looks for a bus with
//   that name, uses it if it is there and creates it if it is not — so "the
//   vocal goes to the Reverb bus" survives, which is the part that was
//   actually meant.
//
//   A DEVICE THIS BUILD DOES NOT HAVE IS SKIPPED BY NAME.  The same rule the
//   rack presets follow, for the same reason: losing one device silently gives
//   you a chain that is quietly missing its de-esser, and refusing the whole
//   template loses the other six.
//
//   GROUPS AND VCAs DO NOT TRAVEL WITH A SINGLE TRACK.  "Member of the Drums
//   group" is a relationship with a specific object in one session, not a
//   property of the channel.  A SESSION template carries them, because there
//   the group is part of what is being described.

import { captureRack, loadRack, createRackPreset, type RackDevice } from './rack-preset.js';
import { findPlugin } from '../engine/plugins.js';
import { EMPTY_RACK, type MacroRack } from './macros.js';
import { trackDelayMs } from './track-delay.js';
import {
  DEFAULT_TRACK_HEIGHT, addGroup, addTrack, createBus, createGroup, createSend,
  createSession, createTrack,
} from './session-ops.js';
import { uniqueTrackName } from './track-header.js';
import { SEND_SLOTS } from './types.js';
import type {
  BusDef, DawSession, Send, TrackId, TrackKind,
} from './types.js';

const MAX_NAME_LEN = 60;
const MAX_NOTE_LEN = 160;

export function sanitiseName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}
export function sanitiseNote(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LEN);
}

// ── Shapes ────────────────────────────────────────────────────────────────────

/** A send, pointed at a bus by name because ids do not survive the trip. */
export interface TemplateSend {
  slot: number;
  busName: string;
  levelDb: number;
  pan: number;
  preFader: boolean;
  mute: boolean;
}

/** Where the channel's main output goes. */
export type TemplateOutput =
  | { kind: 'master' }
  | { kind: 'none' }
  | { kind: 'bus'; busName: string };

export interface TrackTemplate {
  id: string;
  /** What the template is called in the picker. */
  name: string;
  note: string;
  createdAt: number;
  updatedAt: number;

  /** What the TRACK is called when made from this — not the template's name. */
  trackName: string;
  kind: TrackKind;
  color: string;
  height: number;
  volumeDb: number;
  pan: number;
  soloSafe: boolean;
  /** Track Delay in ms — part of the channel, so it comes along. */
  delayMs: number;
  instrumentId: string | null;
  instrumentParams: Record<string, number>;
  /** Insert chain, slots kept — the same shape a rack preset saves. */
  inserts: RackDevice[];
  macros: MacroRack;
  sends: TemplateSend[];
  output: TemplateOutput;
  /** For an aux: the bus it listens to, by name. */
  inputBusName: string | null;
}

export interface SessionTemplate {
  id: string;
  name: string;
  note: string;
  createdAt: number;
  updatedAt: number;

  tempoBpm: number;
  timeSignature: [number, number];
  delayCompensation: boolean;
  /** Buses by name, in order — created before the tracks that point at them. */
  buses: string[];
  /** Groups by name, with their members named the same way. */
  groups: { name: string; symbol: string; memberTrackNames: string[] }[];
  /** A song map is part of a template: verse, chorus, the same every time. */
  markers: { name: string; timeSec: number }[];
  tracks: TrackTemplate[];
}

// ── Capturing ─────────────────────────────────────────────────────────────────

export interface CaptureTrackResult {
  template: TrackTemplate;
  /** One line per thing that could not be saved, naming it. */
  problems: string[];
}

const busNameOf = (session: DawSession, id: string): string | null =>
  session.buses.find((b) => b.id === id)?.name ?? null;

/**
 * Read a track into a template.
 *
 * `name` is the TEMPLATE's name; the track's own name is kept separately, so
 * "Lead Vocal Chain" can make tracks called "Vox".
 */
export function captureTrackTemplate(
  session: DawSession, trackId: TrackId, name: string, note = '',
): CaptureTrackResult | null {
  const track = session.tracks.find((t) => t.id === trackId);
  if (!track) return null;

  const problems: string[] = [];
  const rack = captureRack(track);
  for (const skipped of rack.skipped) {
    problems.push(`${skipped} — 이 빌드가 저장할 수 없는 장치라 제외했습니다`);
  }

  const sends: TemplateSend[] = [];
  for (const send of track.sends) {
    const busName = busNameOf(session, send.target);
    if (!busName) {
      problems.push(`센드 ${send.slot + 1} — 가리키는 버스가 없어 제외했습니다`);
      continue;
    }
    sends.push({
      slot: send.slot, busName,
      levelDb: send.levelDb, pan: send.pan,
      preFader: send.preFader, mute: send.mute,
    });
  }

  let output: TemplateOutput;
  if (track.output.kind === 'bus') {
    const busName = busNameOf(session, track.output.busId);
    if (busName) output = { kind: 'bus', busName };
    else {
      output = { kind: 'master' };
      problems.push('출력 버스를 찾을 수 없어 마스터로 저장했습니다');
    }
  } else {
    output = { kind: track.output.kind };
  }

  const inputBusName = track.input ? busNameOf(session, track.input) : null;
  if (track.input && !inputBusName) {
    problems.push('입력 버스를 찾을 수 없어 비워 두었습니다');
  }
  if (track.frozen) {
    problems.push('얼린 상태는 저장하지 않았습니다 — 템플릿은 렌더된 파일을 가리킬 수 없습니다');
  }
  if (track.automation.length > 0) {
    problems.push(`오토메이션 레인 ${track.automation.length}개는 저장하지 않았습니다 — 세션의 것입니다`);
  }

  const now = Date.now();
  return {
    template: {
      id: '', name: sanitiseName(name) || track.name, note: sanitiseNote(note),
      createdAt: now, updatedAt: now,
      trackName: track.name,
      kind: track.kind,
      color: track.color,
      height: track.height,
      volumeDb: track.volumeDb,
      pan: track.pan,
      soloSafe: track.soloSafe,
      delayMs: trackDelayMs(track),
      instrumentId: track.instrumentId,
      instrumentParams: { ...track.instrumentParams },
      inserts: rack.devices,
      macros: { ...track.macros, values: { ...track.macros.values }, overrides: { ...track.macros.overrides } },
      sends,
      output,
      inputBusName,
    },
    problems,
  };
}

/** Every bus name a template needs, output and sends together. */
export function requiredBuses(template: TrackTemplate): string[] {
  const names = new Set<string>();
  if (template.output.kind === 'bus') names.add(template.output.busName);
  for (const send of template.sends) names.add(send.busName);
  if (template.inputBusName) names.add(template.inputBusName);
  return [...names];
}

export interface CaptureSessionResult {
  template: SessionTemplate;
  problems: string[];
}

/**
 * Read a whole session into a template.
 *
 * The master track is deliberately left out: every session already has one,
 * and a template that carried a second would either duplicate it or have to
 * decide whose master chain wins.  Its processing belongs in a rack preset.
 */
export function captureSessionTemplate(
  session: DawSession, name: string, note = '',
): CaptureSessionResult {
  const problems: string[] = [];
  const tracks: TrackTemplate[] = [];
  for (const track of session.tracks) {
    if (track.kind === 'master') continue;
    const captured = captureTrackTemplate(session, track.id, track.name, '');
    if (!captured) continue;
    tracks.push(captured.template);
    for (const p of captured.problems) problems.push(`${track.name}: ${p}`);
  }

  const clipCount = session.tracks.reduce(
    (sum, t) => sum + t.playlists.reduce((n, pl) => n + pl.clips.length, 0), 0);
  if (clipCount > 0) {
    problems.push(`클립 ${clipCount}개는 저장하지 않았습니다 — 템플릿은 설정이지 연주가 아닙니다`);
  }

  const now = Date.now();
  return {
    template: {
      id: '', name: sanitiseName(name) || session.name, note: sanitiseNote(note),
      createdAt: now, updatedAt: now,
      tempoBpm: session.tempoBpm,
      timeSignature: [session.timeSignature[0], session.timeSignature[1]],
      delayCompensation: session.delayCompensation,
      buses: session.buses.map((b) => b.name),
      groups: session.groups.map((g) => ({
        name: g.name, symbol: g.symbol,
        memberTrackNames: g.memberIds
          .map((id) => session.tracks.find((t) => t.id === id)?.name)
          .filter((n): n is string => !!n),
      })),
      markers: session.markers.map((m) => ({ name: m.name, timeSec: m.timeSec })),
      tracks,
    },
    problems,
  };
}

// ── Applying ──────────────────────────────────────────────────────────────────

export interface ApplyResult {
  session: DawSession;
  /** Ids of the tracks that were created, in order. */
  trackIds: TrackId[];
  /** Buses the template needed and this session did not have. */
  createdBuses: string[];
  problems: string[];
}

/** The bus with this name, creating it when the session has none. */
function ensureBus(
  session: DawSession, name: string, created: string[],
): { session: DawSession; bus: BusDef } {
  const existing = session.buses.find((b) => b.name === name);
  if (existing) return { session, bus: existing };
  const bus = createBus(name);
  created.push(name);
  return { session: { ...session, buses: [...session.buses, bus] }, bus };
}

export interface ApplyOptions {
  /** How many tracks to make.  Names get numbered: Vox, Vox 2, Vox 3. */
  count?: number;
  /** Override the track name the template carries. */
  trackName?: string;
  /** Insert at this index rather than at the end. */
  atIndex?: number;
}

/**
 * Add tracks built from a template.
 *
 * Buses come first, because a send cannot point at a bus that does not exist
 * yet, and the whole reason names travel instead of ids is so this step can
 * reuse a bus the session already has rather than making a second "Reverb".
 */
export function applyTrackTemplate(
  session: DawSession, template: TrackTemplate, options: ApplyOptions = {},
): ApplyResult {
  const count = Math.max(1, Math.min(64, Math.round(options.count ?? 1)));
  const problems: string[] = [];
  const createdBuses: string[] = [];
  const trackIds: TrackId[] = [];

  let out = session;
  const busIds = new Map<string, string>();
  for (const name of requiredBuses(template)) {
    const step = ensureBus(out, name, createdBuses);
    out = step.session;
    busIds.set(name, step.bus.id);
  }

  const missing = template.inserts.filter((d) => !findPlugin(d.pluginId));
  for (const device of missing) {
    problems.push(`${device.label || device.pluginId} — 이 빌드에 없는 장치입니다`);
  }

  for (let n = 0; n < count; n++) {
    const base = sanitiseName(options.trackName ?? template.trackName) || '트랙';
    const name = uniqueTrackName(base, out.tracks);

    const sends: Send[] = [];
    for (const s of template.sends) {
      const busId = busIds.get(s.busName);
      if (!busId) continue;
      if (!Number.isInteger(s.slot) || s.slot < 0 || s.slot >= SEND_SLOTS) {
        problems.push(`센드 슬롯 ${s.slot} 은 이 채널에 없습니다`);
        continue;
      }
      sends.push(createSend(s.slot, busId, {
        levelDb: s.levelDb, pan: s.pan, preFader: s.preFader, mute: s.mute,
      }));
    }

    const outputBusId = template.output.kind === 'bus'
      ? busIds.get(template.output.busName)
      : undefined;

    const track = createTrack(name, template.kind, {
      color: template.color,
      height: Number.isFinite(template.height) ? template.height : DEFAULT_TRACK_HEIGHT,
      volumeDb: template.volumeDb,
      pan: template.pan,
      soloSafe: template.soloSafe === true,
      delayMs: template.delayMs,
      instrumentId: template.instrumentId,
      instrumentParams: { ...template.instrumentParams },
      macros: template.macros ?? EMPTY_RACK,
      sends,
      input: template.inputBusName ? busIds.get(template.inputBusName) ?? null : null,
      output: outputBusId
        ? { kind: 'bus', busId: outputBusId }
        : { kind: template.output.kind === 'none' ? 'none' : 'master' },
    });

    out = addTrack(out, track, options.atIndex === undefined ? undefined : options.atIndex + n);
    // The insert chain goes on through the rack loader, so every stored value
    // is checked against the device that receives it — a template is data.
    const loaded = loadRack(out, track.id, createRackPreset('', name, template.inserts), 'replace');
    out = loaded.session;
    trackIds.push(track.id);
  }

  return { session: out, trackIds, createdBuses, problems };
}

/**
 * A new session from a session template.
 *
 * Built from an empty session rather than by editing the current one: "new
 * from template" must not be able to half-apply over work in progress.
 */
export function sessionFromTemplate(
  template: SessionTemplate, name?: string, sampleRate = 48_000,
): ApplyResult {
  let out = createSession(sanitiseName(name ?? template.name) || 'Untitled', sampleRate);
  out = {
    ...out,
    tempoBpm: template.tempoBpm > 0 ? template.tempoBpm : 120,
    timeSignature: template.timeSignature,
    delayCompensation: template.delayCompensation !== false,
    markers: template.markers.map((m) => ({
      id: `mk-${Math.round(m.timeSec * 1000)}-${m.name}`,
      name: m.name,
      timeSec: Math.max(0, m.timeSec),
    })),
  };

  const problems: string[] = [];
  const createdBuses: string[] = [];
  // Buses first and in order, so a template's own naming survives even for
  // buses nothing points at.
  for (const busName of template.buses) {
    const step = ensureBus(out, busName, createdBuses);
    out = step.session;
  }

  const trackIds: TrackId[] = [];
  const byName = new Map<string, TrackId>();
  for (const track of template.tracks) {
    const applied = applyTrackTemplate(out, track, { count: 1 });
    out = applied.session;
    for (const p of applied.problems) problems.push(`${track.trackName}: ${p}`);
    for (const b of applied.createdBuses) if (!createdBuses.includes(b)) createdBuses.push(b);
    const id = applied.trackIds[0];
    if (id) { trackIds.push(id); byName.set(track.trackName, id); }
  }

  // Groups last: they name tracks, and the tracks have to exist first.
  for (const g of template.groups) {
    const lost = g.memberTrackNames.filter((n) => !byName.has(n));
    if (lost.length > 0) {
      problems.push(`${g.name} 그룹 — ${lost.join(', ')} 트랙이 템플릿에 없습니다`);
    }
    const memberIds = g.memberTrackNames
      .map((n) => byName.get(n))
      .filter((id): id is TrackId => !!id);
    out = addGroup(out, createGroup(g.name, g.symbol, memberIds));
  }

  return { session: out, trackIds, createdBuses, problems };
}

// ── Reading one back ──────────────────────────────────────────────────────────

/** Devices this build does not ship, named — for a warning before applying. */
export function missingDevices(template: TrackTemplate): string[] {
  return template.inserts
    .filter((d) => !findPlugin(d.pluginId))
    .map((d) => d.label || d.pluginId);
}

export function describeTrackTemplate(template: TrackTemplate): string {
  const parts = [`${template.trackName} · ${template.kind}`];
  if (template.inserts.length > 0) parts.push(`인서트 ${template.inserts.length}`);
  if (template.sends.length > 0) parts.push(`센드 ${template.sends.length}`);
  if (template.output.kind === 'bus') parts.push(`→ ${template.output.busName}`);
  if (template.delayMs !== 0) parts.push(`딜레이 ${template.delayMs} ms`);
  return parts.join(' · ');
}

export function describeSessionTemplate(template: SessionTemplate): string {
  const parts = [`트랙 ${template.tracks.length}`];
  if (template.buses.length > 0) parts.push(`버스 ${template.buses.length}`);
  if (template.groups.length > 0) parts.push(`그룹 ${template.groups.length}`);
  if (template.markers.length > 0) parts.push(`마커 ${template.markers.length}`);
  parts.push(`${template.tempoBpm} BPM`);
  parts.push(`${template.timeSignature[0]}/${template.timeSignature[1]}`);
  return parts.join(' · ');
}
