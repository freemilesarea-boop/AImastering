// surround-config — renderer-side model for surround (5.1/7.1) fold-down.
//
// The fold-down DSP + BS.1770 channel weighting live in the main process
// (main/offline/surround.ts).  This is the editable plan for the store/UI;
// surround fold-down applies on the offline EXPORT (the source is decoded at
// full channel count, folded to stereo, then mastered by the stereo chain).

import type { SurroundOptions, SurroundTrims, SurroundBeds, SurroundBedAdjust } from '@aimaster/shared-types';

export const SURROUND_TRIM_RANGE = { min: -12, max: 12 } as const;
export const LFE_RANGE = { min: -120, max: 12 } as const;
export const MASTER_GAIN_RANGE = { min: -12, max: 12 } as const;
export const CEILING_RANGE = { min: -6, max: 0 } as const;
export const BED_GAIN_RANGE = { min: -12, max: 12 } as const;
export const BED_SHELF_RANGE = { min: -9, max: 9 } as const;

const neutralBed = (): SurroundBedAdjust => ({ gainDb: 0, lowShelfDb: 0, highShelfDb: 0 });
export function defaultSurroundBeds(): SurroundBeds {
  return { front: neutralBed(), center: neutralBed(), surround: neutralBed(), lfeGainDb: 0 };
}

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultSurroundOptions(): SurroundOptions {
  return {
    foldDownEnabled: false,
    trims: { centerDb: 0, surroundDb: 0, lfeDb: -120 },
    mode: 'foldDown',
    masterGainDb: 0,
    ceilingDb: -1,
    perChannelChain: false,
    beds: defaultSurroundBeds(),
    admBwf: false,
    dolbyCodec: 'none',
  };
}

/** True when surround processing would not run (disabled). */
export function isSurroundUnity(s: SurroundOptions | undefined | null): boolean {
  return !s || !s.foldDownEnabled;
}

export function sanitizeSurround(s: SurroundOptions): SurroundOptions {
  const t: SurroundTrims = {
    centerDb: clamp(s.trims?.centerDb ?? 0, SURROUND_TRIM_RANGE.min, SURROUND_TRIM_RANGE.max, 0),
    surroundDb: clamp(s.trims?.surroundDb ?? 0, SURROUND_TRIM_RANGE.min, SURROUND_TRIM_RANGE.max, 0),
    lfeDb: clamp(s.trims?.lfeDb ?? -120, LFE_RANGE.min, LFE_RANGE.max, -120),
  };
  return {
    foldDownEnabled: !!s.foldDownEnabled,
    trims: t,
    mode: s.mode === 'multichannel' ? 'multichannel' : 'foldDown',
    masterGainDb: clamp(s.masterGainDb ?? 0, MASTER_GAIN_RANGE.min, MASTER_GAIN_RANGE.max, 0),
    ceilingDb: clamp(s.ceilingDb ?? -1, CEILING_RANGE.min, CEILING_RANGE.max, -1),
    perChannelChain: !!s.perChannelChain,
    beds: sanitizeBeds(s.beds),
    admBwf: !!s.admBwf,
    dolbyCodec: (['ac3', 'eac3', 'truehd'] as const).includes(s.dolbyCodec as 'ac3') ? (s.dolbyCodec ?? 'none') : 'none',
  };
}

function bedAdj(a: SurroundBedAdjust | undefined): SurroundBedAdjust {
  return {
    gainDb: clamp(a?.gainDb ?? 0, BED_GAIN_RANGE.min, BED_GAIN_RANGE.max, 0),
    lowShelfDb: clamp(a?.lowShelfDb ?? 0, BED_SHELF_RANGE.min, BED_SHELF_RANGE.max, 0),
    highShelfDb: clamp(a?.highShelfDb ?? 0, BED_SHELF_RANGE.min, BED_SHELF_RANGE.max, 0),
  };
}

export function sanitizeBeds(b: SurroundBeds | undefined): SurroundBeds {
  return {
    front: bedAdj(b?.front),
    center: bedAdj(b?.center),
    surround: bedAdj(b?.surround),
    lfeGainDb: clamp(b?.lfeGainDb ?? 0, BED_GAIN_RANGE.min, BED_GAIN_RANGE.max, 0),
  };
}
