import { describe, it, expect } from 'vitest';
import {
  bedForRole, defaultSurroundBeds, sanitizeSurroundBeds, isSurroundBedsNeutral,
  bedAdjustedConfig, BED_GAIN_RANGE, BED_SHELF_RANGE,
} from './surround-beds.js';
import type { OfflineChainConfig } from './load-mastering-chain-node.js';

const baseConfig = (): OfflineChainConfig => ({
  inputGainDb: 0, eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0,
  eqAdaptive: false, eqBypass: true,
  dynThresholdDb: -18, dynRatio: 2, dynAttackMs: 10, dynReleaseMs: 100, dynMixPct: 100, dynBypass: false,
  imgWidthPct: 100, imgLowMonoHz: 120, imgBypass: false,
  limCeilingDbtp: -1, limLookaheadMs: 2, limIsp: false, limBypass: false,
  outputGainDb: 0, masterBypass: false,
});

describe('bedForRole', () => {
  it('maps roles to bed groups', () => {
    expect(bedForRole('FL')).toBe('front');
    expect(bedForRole('FR')).toBe('front');
    expect(bedForRole('FC')).toBe('center');
    expect(bedForRole('BL')).toBe('surround');
    expect(bedForRole('SR')).toBe('surround');
    expect(bedForRole('LFE')).toBe('lfe');
  });
});

describe('defaults / sanitize / neutral', () => {
  it('default beds are neutral', () => {
    expect(isSurroundBedsNeutral(defaultSurroundBeds())).toBe(true);
    expect(isSurroundBedsNeutral(undefined)).toBe(true);
  });
  it('a non-zero offset is not neutral', () => {
    const b = defaultSurroundBeds();
    b.surround.gainDb = -2;
    expect(isSurroundBedsNeutral(b)).toBe(false);
  });
  it('sanitize clamps gains + shelves', () => {
    const b = sanitizeSurroundBeds({
      front: { gainDb: 99, lowShelfDb: -99, highShelfDb: 0 },
      center: { gainDb: 0, lowShelfDb: 0, highShelfDb: 99 },
      surround: { gainDb: 0, lowShelfDb: 0, highShelfDb: 0 },
      lfeGainDb: -99,
    });
    expect(b.front.gainDb).toBe(BED_GAIN_RANGE.max);
    expect(b.front.lowShelfDb).toBe(BED_SHELF_RANGE.min);
    expect(b.center.highShelfDb).toBe(BED_SHELF_RANGE.max);
    expect(b.lfeGainDb).toBe(BED_GAIN_RANGE.min);
  });
});

describe('bedAdjustedConfig', () => {
  it('neutral adjust returns the base config unchanged', () => {
    const base = baseConfig();
    expect(bedAdjustedConfig(base, { gainDb: 0, lowShelfDb: 0, highShelfDb: 0 })).toBe(base);
  });
  it('folds gain into inputGain and shelves into low-shelf/air, un-bypassing EQ', () => {
    const out = bedAdjustedConfig(baseConfig(), { gainDb: 3, lowShelfDb: -2, highShelfDb: 1.5 });
    expect(out.inputGainDb).toBe(3);
    expect(out.eqLowShelfDb).toBe(-2);
    expect(out.eqAirDb).toBe(1.5);
    expect(out.eqBypass).toBe(false);
  });
  it('gain-only adjust does not un-bypass the EQ', () => {
    const out = bedAdjustedConfig(baseConfig(), { gainDb: 3, lowShelfDb: 0, highShelfDb: 0 });
    expect(out.eqBypass).toBe(true);
    expect(out.inputGainDb).toBe(3);
  });
});
