// A whole channel strip, saved under one name.
//
// The user presets in `engine/user-presets.ts` save ONE device.  This saves the
// chain: the compressor and the EQ and the reverb, in their slots, with their
// settings and their bypasses — the thing an engineer actually means by "my
// vocal chain".
//
// Everything here is pure.  Three rules shape it, and each one is a decision
// that could plausibly have gone the other way:
//
//   SLOTS ARE PART OF THE SOUND.  "The compressor is in C" is how a channel is
//   remembered, and a rack that reflows its devices on load destroys that.  So
//   a saved rack keeps its slot numbers, and loading it puts them back where
//   they were rather than packing them from A.
//
//   A DEVICE THIS BUILD DOES NOT HAVE IS SKIPPED BY NAME.  Dropping it silently
//   would give you a chain that is quietly missing its de-esser; refusing the
//   whole rack would lose the other six.  Neither is right, so it loads what it
//   can and says what it could not.
//
//   THE SIDECHAIN SOURCE DOES NOT TRAVEL.  It points at a bus in the session it
//   was saved from, and that bus does not exist in the session it is loaded
//   into.  Carrying the id would silently key a ducker off the wrong thing —
//   the one failure here nobody would hear until the mix was wrong.

import { sanitiseParams } from '../engine/user-presets.js';
import { findPlugin } from '../engine/plugins.js';
import { createInsert, findTrack } from './session-ops.js';
import { INSERT_SLOTS } from './types.js';
import type { DawSession, Insert, Track, TrackId } from './types.js';

const MAX_NAME_LEN = 60;
const MAX_NOTE_LEN = 160;

/** One device inside a saved rack. */
export interface RackDevice {
  /** 0–9 → slot A–J.  Kept, because where a device sits is part of the chain. */
  slot: number;
  pluginId: string;
  label: string;
  bypass: boolean;
  params: Record<string, number>;
}

export interface RackPreset {
  id: string;
  name: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  devices: RackDevice[];
}

export function sanitiseName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

export function sanitiseNote(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LEN);
}

// ── Capturing ─────────────────────────────────────────────────────────────────

export interface CaptureResult {
  devices: RackDevice[];
  /** Inserts that could not be saved, named — third-party plugins. */
  skipped: string[];
}

/**
 * Read a track's insert chain into a saveable rack.
 *
 * Third-party plugins reached through the external host are skipped: they have
 * no parameter list in this build to validate against, and a rack file that
 * claimed to carry one would be a rack file that silently loses it on the
 * machine where the plugin is not installed.
 */
export function captureRack(track: Track): CaptureResult {
  const devices: RackDevice[] = [];
  const skipped: string[] = [];
  for (const insert of [...track.inserts].sort((a, b) => a.slot - b.slot)) {
    if (insert.external || !findPlugin(insert.pluginId)) {
      skipped.push(insert.label || insert.pluginId);
      continue;
    }
    devices.push({
      slot: insert.slot,
      pluginId: insert.pluginId,
      label: insert.label,
      bypass: insert.bypass === true,
      params: sanitiseParams(insert.pluginId, insert.params).params,
    });
  }
  return { devices, skipped };
}

export function createRackPreset(
  id: string, name: string, devices: readonly RackDevice[], note = '',
): RackPreset {
  const now = Date.now();
  return {
    id,
    name: sanitiseName(name),
    note: sanitiseNote(note),
    createdAt: now,
    updatedAt: now,
    devices: [...devices].sort((a, b) => a.slot - b.slot),
  };
}

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * What to do with what is already in the rack.
 *
 *   replace   the track's inserts become exactly this rack
 *   merge     the rack's devices land in their own slots, and anything the
 *             rack does not mention is left alone
 */
export type LoadMode = 'replace' | 'merge';

export interface LoadResult {
  session: DawSession;
  /** Devices that landed, in slot order. */
  loaded: RackDevice[];
  /** One line per device that did not, naming it and why. */
  problems: string[];
}

/**
 * Put a saved rack onto a track.
 *
 * Every value is checked against the device that will receive it — the same
 * discipline the single-device presets use, and for the same reason: a rack
 * file is data, and data from a newer build must not be able to put a knob
 * somewhere it cannot go.
 */
export function loadRack(
  session: DawSession, trackId: TrackId, preset: RackPreset, mode: LoadMode = 'replace',
): LoadResult {
  const track = findTrack(session, trackId);
  if (!track) {
    return { session, loaded: [], problems: ['트랙을 찾을 수 없습니다'] };
  }

  const problems: string[] = [];
  const loaded: RackDevice[] = [];
  const kept: Insert[] = mode === 'merge' ? [...track.inserts] : [];

  for (const device of [...preset.devices].sort((a, b) => a.slot - b.slot)) {
    const descriptor = findPlugin(device.pluginId);
    if (!descriptor) {
      problems.push(`${device.label || device.pluginId} — 이 빌드에 없는 장치입니다`);
      continue;
    }
    if (!Number.isInteger(device.slot) || device.slot < 0 || device.slot >= INSERT_SLOTS) {
      problems.push(`${descriptor.name} — 슬롯 ${device.slot} 은 이 랙에 없습니다`);
      continue;
    }
    const params = sanitiseParams(device.pluginId, device.params).params;
    const insert = createInsert(device.slot, device.pluginId, device.label || descriptor.name, {
      bypass: device.bypass === true,
      params,
      // Deliberately NOT carried: it points at a bus in another session.
      sidechainSource: null,
      latencySamples: descriptor.latencyFor(params, session.sampleRate),
    });
    // A merge overwrites the slot it lands in — two devices cannot share one.
    const at = kept.findIndex((i) => i.slot === device.slot);
    if (at >= 0) kept[at] = insert; else kept.push(insert);
    loaded.push(device);
  }

  if (loaded.length === 0 && preset.devices.length > 0) {
    return { session, loaded, problems };
  }

  return {
    session: {
      ...session,
      tracks: session.tracks.map((t) => (t.id === trackId
        ? { ...t, inserts: [...kept].sort((a, b) => a.slot - b.slot) }
        : t)),
    },
    loaded,
    problems,
  };
}

/** True when every device in the rack exists in this build. */
export function isLoadable(preset: RackPreset): boolean {
  return preset.devices.every((d) => findPlugin(d.pluginId) !== undefined);
}

/** Devices this build does not ship, named — for a warning before loading. */
export function missingDevices(preset: RackPreset): string[] {
  return preset.devices
    .filter((d) => !findPlugin(d.pluginId))
    .map((d) => d.label || d.pluginId);
}

// ── Describing ────────────────────────────────────────────────────────────────

const SLOT_NAMES = 'ABCDEFGHIJ';

/** `A Trim · C Compressor · E Space Reverb` — the chain, in one line. */
export function describeRack(preset: RackPreset): string {
  if (preset.devices.length === 0) return '빈 랙';
  return [...preset.devices]
    .sort((a, b) => a.slot - b.slot)
    .map((d) => {
      const slot = SLOT_NAMES[d.slot] ?? String(d.slot);
      const name = findPlugin(d.pluginId)?.name ?? d.label ?? d.pluginId;
      return `${slot} ${name}${d.bypass ? ' (바이패스)' : ''}`;
    })
    .join(' · ');
}

/** `4개 장치 · 3개 로드 · 1개 건너뜀` — what a load actually did. */
export function describeLoad(result: LoadResult): string {
  const parts = [`${result.loaded.length}개 로드`];
  if (result.problems.length > 0) parts.push(`${result.problems.length}개 건너뜀`);
  return parts.join(' · ');
}
