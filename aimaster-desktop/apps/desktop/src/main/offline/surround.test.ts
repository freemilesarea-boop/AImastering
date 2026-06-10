import { describe, it, expect } from 'vitest';
import {
  layoutForChannelCount, deinterleaveN, foldDownToStereo, bs1770Weight,
  channelWeightedLoudnessDb, sanitizeSurroundTrims, surroundProcessingUnits,
  LAYOUT_CHANNELS, DEFAULT_SURROUND_TRIMS,
} from './surround.js';

const M3DB = Math.SQRT1_2;

describe('layoutForChannelCount', () => {
  it('maps 2/6/8 → stereo/5.1/7.1, else null', () => {
    expect(layoutForChannelCount(2)).toBe('stereo');
    expect(layoutForChannelCount(6)).toBe('5.1');
    expect(layoutForChannelCount(8)).toBe('7.1');
    expect(layoutForChannelCount(4)).toBeNull();
  });
});

describe('deinterleaveN', () => {
  it('splits interleaved frames into N channels', () => {
    const inter = Float32Array.from([1, 2, 3, 4, 5, 6]); // 3 frames × 2ch
    const ch = deinterleaveN(inter, 2);
    expect(Array.from(ch[0]!)).toEqual([1, 3, 5]);
    expect(Array.from(ch[1]!)).toEqual([2, 4, 6]);
  });
});

describe('foldDownToStereo (BS.775)', () => {
  // 5.1 order: FL, FR, FC, LFE, BL, BR
  const ch = (vals: number[]): Float32Array[] => vals.map((v) => Float32Array.from([v]));

  it('passes FL/FR straight through', () => {
    const out = foldDownToStereo(ch([0.5, 0.3, 0, 0, 0, 0]), '5.1');
    expect(out.left[0]!).toBeCloseTo(0.5, 6);
    expect(out.right[0]!).toBeCloseTo(0.3, 6);
  });

  it('folds centre equally to L and R at −3 dB', () => {
    const out = foldDownToStereo(ch([0, 0, 1, 0, 0, 0]), '5.1');
    expect(out.left[0]!).toBeCloseTo(M3DB, 5);
    expect(out.right[0]!).toBeCloseTo(M3DB, 5);
  });

  it('excludes LFE by default (≈ −120 dB)', () => {
    const out = foldDownToStereo(ch([0, 0, 0, 1, 0, 0]), '5.1');
    expect(Math.abs(out.left[0]!)).toBeLessThan(1e-5);
    expect(Math.abs(out.right[0]!)).toBeLessThan(1e-5);
  });

  it('folds surrounds to their own side at −3 dB', () => {
    const out = foldDownToStereo(ch([0, 0, 0, 0, 1, 0.5]), '5.1'); // BL, BR
    expect(out.left[0]!).toBeCloseTo(M3DB, 5);
    expect(out.right[0]!).toBeCloseTo(M3DB * 0.5, 5);
  });

  it('centre trim scales the centre contribution', () => {
    const out = foldDownToStereo(ch([0, 0, 1, 0, 0, 0]), '5.1', { centerDb: 6.0206, surroundDb: 0, lfeDb: -120 });
    expect(out.left[0]!).toBeCloseTo(M3DB * 2, 4); // +6 dB ≈ ×2
  });

  it('7.1 folds back + side surrounds onto each side', () => {
    // 7.1 order: FL FR FC LFE BL BR SL SR
    const out = foldDownToStereo(ch([0, 0, 0, 0, 1, 0, 1, 0]), '7.1'); // BL + SL
    expect(out.left[0]!).toBeCloseTo(M3DB * 2, 5);
    expect(out.right[0]!).toBeCloseTo(0, 6);
  });
});

describe('surroundProcessingUnits', () => {
  it('groups 5.1 into FL/FR stereo, FC mono, LFE passthrough, BL/BR stereo', () => {
    const u = surroundProcessingUnits('5.1');
    expect(u).toEqual([
      { kind: 'stereo', indices: [0, 1] },
      { kind: 'mono', indices: [2] },
      { kind: 'lfe', indices: [3] },
      { kind: 'stereo', indices: [4, 5] },
    ]);
  });
  it('adds the side-surround stereo pair for 7.1', () => {
    const u = surroundProcessingUnits('7.1');
    expect(u.some((x) => x.kind === 'stereo' && x.indices[0] === 6 && x.indices[1] === 7)).toBe(true);
    // every channel index 0..7 is covered exactly once
    const covered = u.flatMap((x) => x.indices).sort((a, b) => a - b);
    expect(covered).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('stereo layout → a single stereo unit', () => {
    expect(surroundProcessingUnits('stereo')).toEqual([{ kind: 'stereo', indices: [0, 1] }]);
  });
});

describe('bs1770Weight / channelWeightedLoudnessDb', () => {
  it('weights front 0 dB, surround +1.5 dB, LFE excluded', () => {
    expect(bs1770Weight('FL')).toBeCloseTo(1, 6);
    expect(bs1770Weight('SL')).toBeCloseTo(Math.pow(10, 1.5 / 20), 5);
    expect(bs1770Weight('LFE')).toBe(0);
  });

  it('surround channels contribute more than the same energy in front', () => {
    const layout = '5.1' as const;
    const n = LAYOUT_CHANNELS[layout].length;
    const frontHot = Array.from({ length: n }, (_, i) => Float32Array.from([i === 0 ? 0.5 : 0])); // FL
    const surrHot = Array.from({ length: n }, (_, i) => Float32Array.from([i === 4 ? 0.5 : 0]));  // BL
    expect(channelWeightedLoudnessDb(surrHot, layout)).toBeGreaterThan(channelWeightedLoudnessDb(frontHot, layout));
  });
});

describe('sanitizeSurroundTrims', () => {
  it('clamps + defaults', () => {
    const t = sanitizeSurroundTrims({ centerDb: 99, surroundDb: -99, lfeDb: 999 });
    expect(t.centerDb).toBe(12);
    expect(t.surroundDb).toBe(-12);
    expect(t.lfeDb).toBe(12);
    expect(sanitizeSurroundTrims(undefined)).toEqual(DEFAULT_SURROUND_TRIMS);
  });
});
