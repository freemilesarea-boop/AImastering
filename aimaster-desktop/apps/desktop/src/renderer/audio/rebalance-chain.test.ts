import { describe, it, expect } from 'vitest';
import { createRebalanceChain } from './rebalance-chain.js';
import { defaultRebalanceConfig, type RebalanceConfig } from './rebalance-config.js';

class P { value = 0; }
class FakeBiquad { type = ''; frequency = new P(); Q = new P(); gain = new P(); connect() {} disconnect() {} }
class FakeGain { gain = new P(); connect() {} disconnect() {} }
class FakeSplit { connect() {} disconnect() {} }
class FakeMerge { connect() {} disconnect() {} }

function makeCtx(rec?: { gains: FakeGain[]; biquads: FakeBiquad[] }): BaseAudioContext {
  return {
    createGain: () => { const g = new FakeGain(); rec?.gains.push(g); return g; },
    createBiquadFilter: () => { const b = new FakeBiquad(); rec?.biquads.push(b); return b; },
    createChannelSplitter: () => new FakeSplit(),
    createChannelMerger: () => new FakeMerge(),
  } as unknown as BaseAudioContext;
}

describe('rebalance-chain (WebAudio M/S approximation)', () => {
  it('inactive at unity, active when an approximation control moves', () => {
    const chain = createRebalanceChain(makeCtx());
    chain.apply(defaultRebalanceConfig());
    expect(chain.isActive()).toBe(false);
    chain.apply({ ...defaultRebalanceConfig(), vocalDb: 3 } as RebalanceConfig);
    expect(chain.isActive()).toBe(true);
  });

  it('precise-only changes do NOT make the (approximation) chain active', () => {
    const chain = createRebalanceChain(makeCtx());
    chain.apply({ ...defaultRebalanceConfig(), preciseEnabled: true, stemGainsDb: { vocals: 6, drums: 0, bass: 0, other: 0 } } as RebalanceConfig);
    expect(chain.isActive()).toBe(false);
  });

  it('apply maps vocal/bass dB onto the EQ gains and width onto the side bus', () => {
    const rec = { gains: [] as FakeGain[], biquads: [] as FakeBiquad[] };
    const chain = createRebalanceChain(makeCtx(rec));
    chain.apply({ ...defaultRebalanceConfig(), vocalDb: 4, bassDb: -3, sidePct: 150 } as RebalanceConfig);
    const eqGains = rec.biquads.map((b) => b.gain.value);
    expect(eqGains).toContain(4);   // vocal peaking
    expect(eqGains).toContain(-3);  // bass lowshelf
    const sideMultipliers = rec.gains.map((g) => g.gain.value);
    expect(sideMultipliers).toContain(1.5); // sidePct/100
  });

  it('clamps out-of-range input via sanitize before applying', () => {
    const rec = { gains: [] as FakeGain[], biquads: [] as FakeBiquad[] };
    const chain = createRebalanceChain(makeCtx(rec));
    chain.apply({ ...defaultRebalanceConfig(), vocalDb: 999, sidePct: 999 } as RebalanceConfig);
    expect(rec.biquads.map((b) => b.gain.value)).toContain(12); // clamped vocalDb
    expect(rec.gains.map((g) => g.gain.value)).toContain(2);    // 200% → ×2
  });

  it('dispose does not throw', () => {
    const chain = createRebalanceChain(makeCtx());
    expect(() => chain.dispose()).not.toThrow();
  });
});
