// surround-config — renderer-side model for surround (5.1/7.1) fold-down.
//
// The fold-down DSP + BS.1770 channel weighting live in the main process
// (main/offline/surround.ts).  This is the editable plan for the store/UI;
// surround fold-down applies on the offline EXPORT (the source is decoded at
// full channel count, folded to stereo, then mastered by the stereo chain).

import type { SurroundOptions, SurroundTrims } from '@aimaster/shared-types';

export const SURROUND_TRIM_RANGE = { min: -12, max: 12 } as const;
export const LFE_RANGE = { min: -120, max: 12 } as const;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultSurroundOptions(): SurroundOptions {
  return { foldDownEnabled: false, trims: { centerDb: 0, surroundDb: 0, lfeDb: -120 } };
}

/** True when surround processing would not run (fold-down disabled). */
export function isSurroundUnity(s: SurroundOptions | undefined | null): boolean {
  return !s || !s.foldDownEnabled;
}

export function sanitizeSurround(s: SurroundOptions): SurroundOptions {
  const t: SurroundTrims = {
    centerDb: clamp(s.trims?.centerDb ?? 0, SURROUND_TRIM_RANGE.min, SURROUND_TRIM_RANGE.max, 0),
    surroundDb: clamp(s.trims?.surroundDb ?? 0, SURROUND_TRIM_RANGE.min, SURROUND_TRIM_RANGE.max, 0),
    lfeDb: clamp(s.trims?.lfeDb ?? -120, LFE_RANGE.min, LFE_RANGE.max, -120),
  };
  return { foldDownEnabled: !!s.foldDownEnabled, trims: t };
}
