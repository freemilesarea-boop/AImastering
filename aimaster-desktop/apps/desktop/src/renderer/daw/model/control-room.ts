// control-room.ts — the monitoring path, which is not the mix.
//
// A studio has two completely different level controls and confusing them
// ruins records.  The MASTER FADER is part of the mix: it is printed, it is
// bounced, it is what the listener hears.  The CONTROL ROOM level is how loud
// the speakers are in this room right now, and it must reach the speakers and
// NOTHING ELSE — not the bounce, not the stems, not the file that goes to
// mastering.
//
// Every DAW that lacks a control room grows the same bug: somebody turns the
// master fader down because it is too loud in the room, and every export after
// that is 8 dB quiet.  It is not noticed until a client says so.
//
// So this module models the monitor path only, and the architecture keeps the
// promise structurally rather than by remembering: the offline render builds
// its graph straight into the render destination and never constructs a
// control room at all.  There is no flag to forget to check — the code that
// would apply it does not exist in that path.
//
// What is here is what a monitor path actually needs:
//
//   LEVEL   how loud the room is
//   DIM     a fixed drop you can hit and un-hit without losing your place,
//           for talking over the music
//   MONO    sum to one channel, which is how you catch a phase problem that
//           a stereo speaker pair hides completely
//   MUTE    silence, without touching the level you had set
//   SOURCE  which set of speakers, or the headphones
//   CUES    the performers' headphone mixes, which are not what you hear
//
// The one rule everything obeys: none of it is in the mix.

/** Where the control room is listening. */
export type MonitorSource = 'main' | 'alt' | 'phones';

export const MONITOR_LABELS: Record<MonitorSource, string> = {
  main: '메인 스피커',
  alt: '보조 스피커',
  phones: '헤드폰',
};

/**
 * How far DIM drops the level.
 *
 * Twenty decibels is the studio convention: quiet enough to talk over
 * comfortably, loud enough that you can still hear what the music is doing.
 * A dim that only takes off six is one you press twice; one that takes off
 * forty is a mute with extra steps.
 */
export const DEFAULT_DIM_DB = -20;

export const MIN_LEVEL_DB = -60;
export const MAX_LEVEL_DB = 12;

/** Below this the monitor path is silent; above it, a real gain. */
export const SILENCE_DB = MIN_LEVEL_DB;

export interface CueSend {
  id: string;
  name: string;
  levelDb: number;
  muted: boolean;
  /**
   * True when this cue carries the main mix; false when the performer has
   * their own balance.  The per-channel cue levels live on the channels
   * themselves, the way sends do.
   */
  followsMain: boolean;
}

export const MAX_CUES = 4;

export interface ControlRoomState {
  /** Monitor level in dB.  NOT the master fader. */
  levelDb: number;
  dim: boolean;
  dimDb: number;
  mono: boolean;
  muted: boolean;
  source: MonitorSource;
  /** Per-set trims, so switching speakers does not change how loud it is. */
  trimDb: Record<MonitorSource, number>;
  cues: CueSend[];
  /**
   * Reference level in dB SPL that `levelDb: 0` is calibrated to, or null.
   *
   * Purely a label — nothing here can measure a room.  It exists so somebody
   * who HAS calibrated can write the number down next to the fader instead of
   * on a strip of tape, and so the panel never implies a calibration it did
   * not perform.
   */
  referenceSpl: number | null;
}

export const DEFAULT_CONTROL_ROOM: ControlRoomState = {
  levelDb: -12,
  dim: false,
  dimDb: DEFAULT_DIM_DB,
  mono: false,
  muted: false,
  source: 'main',
  trimDb: { main: 0, alt: 0, phones: 0 },
  cues: [
    { id: 'cue-1', name: 'Cue 1', levelDb: -6, muted: false, followsMain: true },
    { id: 'cue-2', name: 'Cue 2', levelDb: -6, muted: false, followsMain: true },
  ],
  referenceSpl: null,
};

// ── Level ───────────────────────────────────────────────────────────────────

export function clampLevelDb(db: number): number {
  if (!Number.isFinite(db)) return MIN_LEVEL_DB;
  return Math.max(MIN_LEVEL_DB, Math.min(MAX_LEVEL_DB, db));
}

export function dbToGain(db: number): number {
  return db <= SILENCE_DB ? 0 : Math.pow(10, db / 20);
}

/**
 * The dB the monitor path is actually at, before it becomes a gain.
 *
 * Order matters and is the studio's: the speaker-set trim is a calibration
 * that belongs UNDER the fader, so switching from mains to alts does not
 * change how loud the room is; dim comes after, because it is a thing you do
 * to whatever level you had.
 */
export function monitorDb(state: ControlRoomState): number {
  if (state.muted) return SILENCE_DB;
  const trim = state.trimDb[state.source] ?? 0;
  const level = clampLevelDb(state.levelDb) + trim;
  return state.dim ? level + state.dimDb : level;
}

/** Linear gain for the monitor node.  Zero when muted or fully down. */
export function monitorGain(state: ControlRoomState): number {
  return dbToGain(monitorDb(state));
}

/** Set the level, holding it in range. */
export function setLevel(state: ControlRoomState, db: number): ControlRoomState {
  return { ...state, levelDb: clampLevelDb(db) };
}

/**
 * Nudge the level by a step.
 *
 * Separate from `setLevel` because a keyboard nudge from a muted or dimmed
 * state should change the LEVEL, not un-mute — the two are different controls
 * and a nudge that silently un-dims loses your place.
 */
export function nudgeLevel(state: ControlRoomState, deltaDb: number): ControlRoomState {
  return setLevel(state, state.levelDb + deltaDb);
}

export function toggleDim(state: ControlRoomState): ControlRoomState {
  return { ...state, dim: !state.dim };
}

export function toggleMono(state: ControlRoomState): ControlRoomState {
  return { ...state, mono: !state.mono };
}

export function toggleMute(state: ControlRoomState): ControlRoomState {
  return { ...state, muted: !state.muted };
}

/**
 * Switch speaker sets.
 *
 * The level is untouched: each set has its own trim, and that is exactly the
 * point — you A/B two speakers at a matched loudness, or the comparison is
 * about volume rather than about the speakers.
 */
export function setSource(state: ControlRoomState, source: MonitorSource): ControlRoomState {
  return { ...state, source };
}

export function setTrim(
  state: ControlRoomState, source: MonitorSource, db: number,
): ControlRoomState {
  return { ...state, trimDb: { ...state.trimDb, [source]: clampLevelDb(db) } };
}

// ── Cues ────────────────────────────────────────────────────────────────────

export function setCue(
  state: ControlRoomState, id: string, patch: Partial<CueSend>,
): ControlRoomState {
  return { ...state, cues: state.cues.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function addCue(state: ControlRoomState): ControlRoomState {
  if (state.cues.length >= MAX_CUES) return state;
  // Numbered from the highest one that exists, not from the count.  Counting
  // means removing Cue 2 and adding one hands out `cue-3` a second time, and
  // from then on setting one cue's level sets the other one's too.
  const n = state.cues.reduce((hi, c) => {
    const num = Number(/^cue-(\d+)$/.exec(c.id)?.[1] ?? 0);
    return Number.isFinite(num) && num > hi ? num : hi;
  }, 0) + 1;
  return {
    ...state,
    cues: [...state.cues,
      { id: `cue-${n}`, name: `Cue ${n}`, levelDb: -6, muted: false, followsMain: true }],
  };
}

export function removeCue(state: ControlRoomState, id: string): ControlRoomState {
  return { ...state, cues: state.cues.filter((c) => c.id !== id) };
}

/** A cue's own gain.  Independent of the control room level, on purpose:
 *  turning the room down must not turn the singer's headphones down. */
export function cueGain(cue: CueSend): number {
  return cue.muted ? 0 : dbToGain(clampLevelDb(cue.levelDb));
}

// ── Reading it back ─────────────────────────────────────────────────────────

export function describeMonitor(state: ControlRoomState): string {
  if (state.muted) return '뮤트';
  const db = monitorDb(state);
  const parts = [`${db.toFixed(1)} dB`, MONITOR_LABELS[state.source]];
  if (state.dim) parts.push(`DIM ${state.dimDb}`);
  if (state.mono) parts.push('MONO');
  return parts.join(' · ');
}

/**
 * The line that says this is not the mix.
 *
 * Shown in the panel because it is the one thing a person has to believe for
 * the control room to be useful: turning it down does not make the export
 * quiet.  A monitor section people do not trust is a monitor section people
 * use the master fader instead of.
 */
export const NOT_IN_THE_MIX =
  '컨트롤 룸은 이 방에서 들리는 소리만 바꿉니다 — 바운스·스템·마스터링 파일에는 들어가지 않습니다';

export function describeCue(cue: CueSend): string {
  if (cue.muted) return `${cue.name} 뮤트`;
  return `${cue.name} ${cue.levelDb.toFixed(1)} dB · ${cue.followsMain ? '메인 믹스' : '개별 밸런스'}`;
}
