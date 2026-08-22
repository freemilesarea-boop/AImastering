// What each track records FROM, saved with the project.
//
// The assignment already existed and lived in a Zustand map keyed by track
// id, which meant it survived exactly as long as the window did.  Reopen the
// session tomorrow and every track is back on the system default — six
// microphones on an interface, and the app has forgotten which is the kick.
//
// Saving it is not just moving the map into the session file, because the
// thing being saved is TWO facts wearing one name:
//
//   A PROJECT FACT.  "The vocal records from the Scarlett's input 1."  That
//   belongs in the session and should come back tomorrow, and next month, and
//   on the engineer's other machine.
//
//   A MACHINE FACT.  "The Scarlett is media device 8f2c…".  That id is issued
//   by the browser, is scoped to this machine and this origin, and ROTATES —
//   the same interface can have a different id after a reboot.  Writing it
//   into a session file and trusting it later is how a take gets recorded off
//   the laptop's built-in microphone while somebody sings into a condenser.
//
// So the session stores the NAME, keeps the id only as a hint for the machine
// that wrote it, and resolves the two against what is actually plugged in.
// Same rule as buses in a track template: an id from somewhere else names
// nothing, a name is what was meant.
//
// And when the named device is not here, nothing is substituted quietly.  The
// track falls back to the system default AND says which device is missing,
// because a silent substitution is a ruined take that nobody hears until
// playback.

import type { Track } from './types.js';

export interface TrackInputRef {
  /** What the device called itself.  This is the part that travels. */
  deviceLabel: string | null;
  /** The id it had when it was chosen — a hint, never a promise. */
  deviceId: string | null;
  channels: 1 | 2;
}

export const DEFAULT_INPUT_REF: TrackInputRef = {
  deviceLabel: null, deviceId: null, channels: 1,
};

/** A device as the machine currently reports it — `engine/recorder.ts`'s shape. */
export interface InputDeviceLike {
  id: string;
  label: string;
}

/** The saved assignment, tolerating a session that predates the field. */
export function trackInputRef(track: Track): TrackInputRef {
  const raw = track.recordInput;
  if (!raw || typeof raw !== 'object') return DEFAULT_INPUT_REF;
  const channels = raw.channels === 2 ? 2 : 1;
  return {
    deviceLabel: typeof raw.deviceLabel === 'string' && raw.deviceLabel ? raw.deviceLabel : null,
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : null,
    channels,
  };
}

export function hasInputAssignment(track: Track): boolean {
  const ref = trackInputRef(track);
  return ref.deviceLabel !== null || ref.deviceId !== null || ref.channels !== 1;
}

/** Build a ref from a device the user just picked. */
export function inputRefFor(
  device: InputDeviceLike | null, channels: 1 | 2,
): TrackInputRef {
  return {
    deviceLabel: device?.label || null,
    deviceId: device?.id || null,
    channels,
  };
}

// ── Resolving ─────────────────────────────────────────────────────────────────

export type ResolveKind =
  /** The saved id is present and still calls itself the same thing. */
  | 'id'
  /** Found by name — the id had rotated, or this is a different machine. */
  | 'label'
  /** Nothing was saved; the system default is the right answer. */
  | 'default'
  /** Something WAS saved and it is not here. */
  | 'missing';

export interface InputResolution {
  /** What to hand `getUserMedia`.  Null means the system default. */
  deviceId: string | null;
  channels: 1 | 2;
  kind: ResolveKind;
  /** Non-null exactly when the user needs to know something. */
  reason: string | null;
}

/**
 * Turn a saved assignment into a device on THIS machine.
 *
 * The order matters and each step earns its place:
 *
 *   1. The saved id, but only if the device still has the saved name.  An id
 *      that has been reissued to a different interface is worse than no id.
 *   2. The name.  This is the case that makes the feature work at all — the
 *      same interface after a reboot, or on the other machine in the studio.
 *   3. Nothing saved → the default, silently, because that is not a failure.
 *   4. Saved and absent → the default, LOUDLY.
 */
export function resolveTrackInput(
  ref: TrackInputRef, devices: readonly InputDeviceLike[],
): InputResolution {
  const channels: 1 | 2 = ref.channels === 2 ? 2 : 1;
  const base = { channels };

  if (!ref.deviceLabel && !ref.deviceId) {
    return { ...base, deviceId: null, kind: 'default', reason: null };
  }

  if (ref.deviceId) {
    const byId = devices.find((d) => d.id === ref.deviceId);
    // A device whose id matches but whose name has changed is a different
    // box that inherited the id, which browsers do after a replug.
    if (byId && (!ref.deviceLabel || byId.label === ref.deviceLabel)) {
      return { ...base, deviceId: byId.id, kind: 'id', reason: null };
    }
  }

  if (ref.deviceLabel) {
    const byLabel = devices.find((d) => d.label === ref.deviceLabel);
    if (byLabel) {
      return { ...base, deviceId: byLabel.id, kind: 'label', reason: null };
    }
  }

  const name = ref.deviceLabel ?? '저장된 입력 장치';
  return {
    ...base,
    deviceId: null,
    kind: 'missing',
    reason: `${name} — 지금 연결되어 있지 않습니다. 시스템 기본 입력으로 무장했습니다`,
  };
}

/**
 * Re-point a saved assignment at the device that answered for it.
 *
 * Called after a successful resolve so the hint is fresh next time.  Only the
 * id moves; the name is what was chosen and is not rewritten by a lookup.
 */
export function refreshHint(ref: TrackInputRef, resolution: InputResolution): TrackInputRef {
  if (resolution.kind !== 'label' || !resolution.deviceId) return ref;
  return { ...ref, deviceId: resolution.deviceId };
}

// ── Reading it back ───────────────────────────────────────────────────────────

export function describeInput(ref: TrackInputRef): string {
  const name = ref.deviceLabel ?? '시스템 기본';
  return `${name} · ${ref.channels === 2 ? '스테레오' : '모노'}`;
}

export function describeResolution(resolution: InputResolution): string {
  switch (resolution.kind) {
    case 'id':      return '저장된 장치';
    case 'label':   return '이름으로 다시 찾음';
    case 'default': return '시스템 기본 입력';
    default:        return '장치 없음 — 기본 입력';
  }
}
