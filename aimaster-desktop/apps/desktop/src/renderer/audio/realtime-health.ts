// Is the realtime preview healthy? One answer, in one place.
//
// The worklet has counted everything needed to tell since it was written —
// process time per block, the block period, xruns, safety bypasses, and
// three cumulative counters that separate "never pulled" from "pulled but
// no audio" from "audio but silent". Nothing judged any of it. The
// thresholds lived in two components, which read different fields and
// therefore disagreed: the debug panel called any CUMULATIVE xrun danger,
// while the transport mentioned only the current snapshot's. One of them
// went red forever after a single glitch at startup; the other forgot a
// sustained problem between snapshots.
//
// So the judgement moves here, where it can be tested and where the smoke
// harness can apply the same rule to a real app's metrics.
//
// # The thresholds, and why these numbers
//
// `load` is process time over the block period: 1.0 means the chain uses
// its whole deadline. Measured against the 2.667 ms quantum a 48 kHz
// 128-frame graph gives:
//
//   0.11  a default chain, comfortable            (0.3 ms per block)
//   0.50  half the budget — a heavier preset or a
//         slower machine will cross the line
//   1.00  at the deadline; glitches start here
//   3.00  8 ms per block, unusable
//
// Half the budget is the warning because the margin above it is all the
// headroom there is, and the thing that eats it — another app, a laptop
// dropping its clock — arrives without warning.

/** What a verdict needs. Both metric shapes in the app satisfy it. */
export interface PreviewHealthInput {
  /** Average process() ms per block over the window. */
  avgProcessMs: number;
  /** The quantum's period in ms. 0 when the worklet has not said yet. */
  blockPeriodMs: number;
  /** Xruns in the recent window — NOT a cumulative total. */
  recentXruns: number;
  /** Blocks the chain's safety layer had to replace. Cumulative. */
  safetyEvents: number;
  /**
   * The three cumulative counters that separate a preview which is not
   * running from one that is running on nothing.
   *
   * Optional, because only the accumulator keeps them: the preview store
   * throws them away and derives a single `running` from `audioBlocks > 0`.
   * A caller without them cannot be asked "not pulled / no audio / all
   * silence", so it passes `running` instead and gets the load half of the
   * verdict, which is what its one-line readout shows.
   */
  processCalls?: number;
  audioBlocks?: number;
  nonSilentBlocks?: number;
  /** For a caller with no counters: is the chain processing at all. */
  running?: boolean;
  /** The chain is passing audio through untouched. */
  bypass: boolean;
}

export type PreviewHealthLevel =
  /** The worklet is not being pulled. Nothing is running. */
  | 'off'
  /** Pulled, but no audio has arrived at its input yet. */
  | 'waiting'
  /** Audio arrives and every block of it is silence. */
  | 'silent'
  /** Running, and deliberately passing through. */
  | 'bypassed'
  /** Processing, with room to spare. */
  | 'ok'
  /** Processing, but more than half the deadline is gone. */
  | 'tight'
  /** At or past the deadline, or glitching now. */
  | 'over';

export interface PreviewHealth {
  level: PreviewHealthLevel;
  /** One line, in the user's language, naming what was measured. */
  reason: string;
  /** avgProcessMs / blockPeriodMs, or null when the budget is unknown. */
  load: number | null;
}

/** Half the deadline: the point past which there is no margin left. */
export const TIGHT_LOAD = 0.5;
/** The deadline itself. */
export const OVER_LOAD = 1.0;

/**
 * Judge one snapshot.
 *
 * The order of the tests is the order of the questions: is it running at
 * all, is audio reaching it, is that audio anything, is it meant to be
 * processing — and only then, how close to the deadline is it. Asking about
 * load first is how a stopped preview gets reported as healthy.
 */
export function previewHealth(m: PreviewHealthInput): PreviewHealth {
  const known = m.blockPeriodMs > 0;
  const load = known ? m.avgProcessMs / m.blockPeriodMs : null;

  const counted = typeof m.processCalls === 'number';
  if (counted) {
    if ((m.processCalls ?? 0) <= 0) {
      return { level: 'off', load, reason: '프리뷰 체인이 호출되지 않고 있습니다' };
    }
    if ((m.audioBlocks ?? 0) <= 0) {
      return { level: 'waiting', load, reason: '체인은 돌지만 오디오가 아직 들어오지 않았습니다' };
    }
    if ((m.nonSilentBlocks ?? 0) <= 0) {
      return { level: 'silent', load, reason: '들어오는 오디오가 전부 무음입니다' };
    }
  } else if (m.running === false) {
    return { level: 'off', load, reason: '프리뷰 체인이 돌지 않고 있습니다' };
  }

  // Safety bypasses mean the chain produced something it could not ship —
  // reported before the load, because a chain that is being rescued is not
  // "healthy with a comfortable margin".
  if (m.safetyEvents > 0) {
    return {
      level: 'over', load,
      reason: `체인 출력이 ${m.safetyEvents}회 안전 복구되었습니다`,
    };
  }
  if (m.bypass) {
    return { level: 'bypassed', load, reason: '체인이 바이패스 상태입니다' };
  }

  // A glitch now outweighs a comfortable average: the average is what the
  // EMA smoothed, and the glitch is what was heard.
  if (m.recentXruns > 0) {
    return {
      level: 'over', load,
      reason: `최근 ${m.recentXruns}블록이 마감을 넘겼습니다 — 소리가 끊깁니다`,
    };
  }
  if (!known) {
    return {
      level: 'tight', load,
      reason: `블록당 ${m.avgProcessMs.toFixed(2)} ms — 블록 주기를 아직 몰라 여유를 계산할 수 없습니다`,
    };
  }
  const pct = (load! * 100).toFixed(0);
  if (load! >= OVER_LOAD) {
    return {
      level: 'over', load,
      reason: `블록 예산의 ${pct}%를 쓰고 있습니다 — 마감을 넘겼습니다`,
    };
  }
  if (load! >= TIGHT_LOAD) {
    return {
      level: 'tight', load,
      reason: `블록 예산의 ${pct}%를 쓰고 있습니다 — 여유가 절반 아래입니다`,
    };
  }
  return { level: 'ok', load, reason: `블록 예산의 ${pct}%를 쓰고 있습니다` };
}

// There is deliberately no `isPreviewProblem(level)` helper here.
//
// One was written, and `dead-exports` caught that the only caller was this
// module's own test — the exact thing that check exists to find, and the
// thing this session has been auditing for elsewhere. The readout it was
// meant to serve needs three states, not two: the debug panel maps 'over'
// to danger, 'tight' to warn and the rest to ok, right where it chooses the
// colour. A two-way predicate could not have served it, so adding the
// export only moved the mapping somewhere it was harder to read.
