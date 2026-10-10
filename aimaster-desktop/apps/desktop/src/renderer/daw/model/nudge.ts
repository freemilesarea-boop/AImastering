// How far one nudge moves the selection.
//
// This used to be a bare number on the store, `nudgeSec: 0.1`, with a setter
// nothing in the app ever called — so the two numpad commands moved the
// selection by exactly 100 ms for the life of the session, and the toolbar
// drew `Nudge 0.1s` as a label the user could look at and nothing more.
//
// 100 ms is not a musical length at any tempo: it is 1/40 of a note at
// 60 BPM, 1/20 at 120, 1/13.8 at 174.  The grid the ruler draws right beside
// that label offers 1/16 = 125 ms and 1/32 = 62 ms at 120 BPM, so the one
// nudge amount the user could reach was the one amount that could never land
// on a grid line.
//
// So the amount is a CHOICE rather than a number.  Either the grid itself —
// held as a choice, not copied as a value, so a tempo change carries the
// nudge with it — or an absolute time, for the work that really is measured
// in milliseconds and frames: pulling a double four frames back, sliding a
// hit a millisecond off its twin to stop it combing.

import { beatToSec, secToBeat, type TempoMap } from './tempo-map.js';
import { gridLabel } from './snap-modes.js';

export type NudgeSetting =
  | { kind: 'grid' }
  | { kind: 'frame' }
  | { kind: 'fixed'; sec: number };

/**
 * What the toolbar offers, in ascending order of distance.
 *
 * `1 Frame` sits where it lands at 24 fps (41.7 ms).  It is in the list at
 * all because the frame nudge commands next door only move the PLAY HEAD;
 * there was no way to move a clip by a frame, which is most of what lining
 * audio up to picture is.
 */
export const NUDGE_CHOICES: ReadonlyArray<{ id: string; label: string; setting: NudgeSetting }> = [
  { id: 'grid',  label: 'Grid',    setting: { kind: 'grid' } },
  { id: '1ms',   label: '1ms',     setting: { kind: 'fixed', sec: 0.001 } },
  { id: '10ms',  label: '10ms',    setting: { kind: 'fixed', sec: 0.01 } },
  { id: 'frame', label: '1 Frame', setting: { kind: 'frame' } },
  { id: '100ms', label: '100ms',   setting: { kind: 'fixed', sec: 0.1 } },
  { id: '1s',    label: '1s',      setting: { kind: 'fixed', sec: 1 } },
];

export const DEFAULT_NUDGE: NudgeSetting = { kind: 'grid' };

export function nudgeChoiceId(setting: NudgeSetting): string {
  const hit = NUDGE_CHOICES.find((c) => c.setting.kind === setting.kind
    && (setting.kind !== 'fixed' || (c.setting.kind === 'fixed' && c.setting.sec === setting.sec)));
  return hit?.id ?? 'grid';
}

export function nudgeSettingFromId(id: string): NudgeSetting | undefined {
  return NUDGE_CHOICES.find((c) => c.id === id)?.setting;
}

export interface NudgeContext {
  tempoMap: TempoMap;
  /** The ruler's grid, in quarter notes. */
  gridDivision: number;
  /**
   * Where the nudge happens.  The grid is measured THERE rather than at the
   * song start, so one nudge inside a ritardando is one grid line of that
   * slower bar and not of the tempo the song opened at.
   */
  atSec: number;
  /** The picture's frame rate, or null when the session has no picture. */
  fps: number | null;
}

/**
 * The distance in seconds, or null when the choice cannot be honoured.
 *
 * Null rather than a fallback on purpose: a frame nudge in a session with no
 * picture has no defensible answer, and quietly moving by 100 ms instead is
 * exactly the kind of silent substitution that makes an edit window feel
 * haunted.  The caller says so instead — see `nudgeProblem`.
 */
export function nudgeAmountSec(setting: NudgeSetting, ctx: NudgeContext): number | null {
  if (setting.kind === 'fixed') return setting.sec > 0 ? setting.sec : null;
  if (setting.kind === 'frame') return ctx.fps !== null && ctx.fps > 0 ? 1 / ctx.fps : null;
  if (!(ctx.gridDivision > 0)) return null;
  const at = Math.max(0, ctx.atSec);
  const amount = beatToSec(ctx.tempoMap, secToBeat(ctx.tempoMap, at) + ctx.gridDivision) - at;
  return amount > 0 ? amount : null;
}

/** Why the chosen amount cannot be used, in the words the toast will carry. */
export function nudgeProblem(setting: NudgeSetting, ctx: NudgeContext): string | null {
  if (nudgeAmountSec(setting, ctx) !== null) return null;
  if (setting.kind === 'frame') return '넛지 단위가 프레임인데 이 세션에는 픽처가 없습니다';
  if (setting.kind === 'grid') return '그리드가 꺼져 있어 넛지 거리를 알 수 없습니다';
  return '넛지 값이 0입니다';
}

/**
 * A distance, written the way the toolbar and the toasts both want it.
 *
 * Milliseconds to two decimals, trailing zeros dropped: 125 ms reads as
 * `125ms` and a frame as `41.67ms`.  Rounding a frame to `42ms` would read
 * fine and hide the thing a frame readout is for — 23.976 fps gives 41.71 ms
 * and 24 gives 41.67, and a session running one against the other is
 * exactly the mismatch a user is checking for when they look.
 */
export function formatNudgeAmount(sec: number): string {
  if (sec >= 1) return `${Number(sec.toFixed(3))}s`;
  return `${Number((sec * 1000).toFixed(2))}ms`;
}

/**
 * What the toolbar draws.
 *
 * A musical choice shows the resolved time as well, because "1/16" alone
 * leaves the user converting in their head to know whether the next press
 * clears the twin eight milliseconds away.
 */
export function describeNudge(setting: NudgeSetting, ctx: NudgeContext): string {
  const amount = nudgeAmountSec(setting, ctx);
  if (setting.kind === 'fixed') return formatNudgeAmount(setting.sec);
  const name = setting.kind === 'frame' ? '1 Frame' : gridLabel(ctx.gridDivision);
  if (amount === null) return `${name} (?)`;
  return `${name} (${formatNudgeAmount(amount)})`;
}
