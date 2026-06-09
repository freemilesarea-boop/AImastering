import { describe, it, expect } from 'vitest';
import { createImagerMultibandChain } from './imager-multiband-chain.js';
import { defaultImagerMultiband, type ImagerMultibandConfig } from './imager-config.js';

class P { value = 0; }
class FakeBiquad { type = ''; frequency = new P(); Q = new P(); connect() {} disconnect() {} }
class FakeGain { gain = new P(); connect() {} disconnect() {} }
class FakeSplit { connect() {} disconnect() {} }
class FakeMerge { connect() {} disconnect() {} }

const ctx = {
  createGain: () => new FakeGain(),
  createBiquadFilter: () => new FakeBiquad(),
  createChannelSplitter: () => new FakeSplit(),
  createChannelMerger: () => new FakeMerge(),
} as unknown as BaseAudioContext;

describe('imager-multiband-chain (WebAudio M/S preview approximation)', () => {
  it('is inactive for disabled/unity, active when a band width ≠ 100', () => {
    const chain = createImagerMultibandChain(ctx);
    chain.apply(defaultImagerMultiband());
    expect(chain.isActive()).toBe(false);
    const widened: ImagerMultibandConfig = { ...defaultImagerMultiband(), enabled: true, widthsPct: [0, 100, 100, 200] };
    chain.apply(widened);
    expect(chain.isActive()).toBe(true);
  });

  it('apply records per-band width on the band gains', () => {
    const gains: FakeGain[] = [];
    const recCtx = {
      createGain: () => { const g = new FakeGain(); gains.push(g); return g; },
      createBiquadFilter: () => new FakeBiquad(),
      createChannelSplitter: () => new FakeSplit(),
      createChannelMerger: () => new FakeMerge(),
    } as unknown as BaseAudioContext;
    const chain = createImagerMultibandChain(recCtx);
    chain.apply({ ...defaultImagerMultiband(), enabled: true, widthsPct: [0, 50, 150, 200] });
    // Band gains are the last 4 created GainNodes that end up at 0/0.5/1.5/2.0.
    const vals = gains.map((g) => g.gain.value);
    expect(vals).toContain(0);
    expect(vals).toContain(0.5);
    expect(vals).toContain(1.5);
    expect(vals).toContain(2);
  });

  it('dispose does not throw', () => {
    const chain = createImagerMultibandChain(ctx);
    expect(() => chain.dispose()).not.toThrow();
  });
});
