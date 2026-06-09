import { describe, it, expect } from 'vitest';
import { createMultibandChain } from './multiband-chain.js';
import { defaultMultibandConfig, type MultibandConfig } from './multiband-config.js';

// Self-contained WebAudio mock (jsdom has no AudioContext nodes).
class P { value = 0; }
class FakeBiquad { type = ''; frequency = new P(); Q = new P(); connect() {} disconnect() {} }
class FakeComp { threshold = new P(); ratio = new P(); attack = new P(); release = new P(); knee = new P(); connect() {} disconnect() {} }
class FakeGain { gain = new P(); connect() {} disconnect() {} }

let biquads = 0; let comps = 0;
const ctx = {
  createGain: () => new FakeGain(),
  createBiquadFilter: () => { biquads++; return new FakeBiquad(); },
  createDynamicsCompressor: () => { comps++; return new FakeComp(); },
} as unknown as BaseAudioContext;

function activeCfg(): MultibandConfig {
  return {
    ...defaultMultibandConfig(), bypass: false,
    bands: defaultMultibandConfig().bands.map((b) => ({ ...b, ratio: 3, makeupDb: 1 })) as MultibandConfig['bands'],
  };
}

describe('multiband-chain (WebAudio preview approximation)', () => {
  it('builds 4 compressors + a full filter bank', () => {
    biquads = 0; comps = 0;
    createMultibandChain(ctx);
    expect(comps).toBe(4);
    // low(2) + low-mid(4) + high-mid(4) + high(2) = 12 crossover biquads.
    expect(biquads).toBe(12);
  });

  it('is inactive for a bypassed/unity config, active when compressing', () => {
    const chain = createMultibandChain(ctx);
    chain.apply(defaultMultibandConfig()); // bypassed default
    expect(chain.isActive()).toBe(false);
    chain.apply(activeCfg());
    expect(chain.isActive()).toBe(true);
  });

  it('apply maps band config onto compressor params (clamped to WebAudio ranges)', () => {
    biquads = 0; comps = 0;
    const created: FakeComp[] = [];
    const recCtx = {
      createGain: () => new FakeGain(),
      createBiquadFilter: () => new FakeBiquad(),
      createDynamicsCompressor: () => { const c = new FakeComp(); created.push(c); return c; },
    } as unknown as BaseAudioContext;
    const chain = createMultibandChain(recCtx);
    chain.apply(activeCfg());
    // Band 0 compressor reflects ratio 3.
    expect(created[0]!.ratio.value).toBe(3);
    // attack in seconds (ms/1000), within [0,1].
    expect(created[0]!.attack.value).toBeGreaterThanOrEqual(0);
    expect(created[0]!.attack.value).toBeLessThanOrEqual(1);
    // makeup gain applied (1 dB → ~1.122 linear) on the makeup node is not on
    // the compressor; just assert threshold is in range.
    expect(created[0]!.threshold.value).toBeLessThanOrEqual(0);
    expect(created[0]!.threshold.value).toBeGreaterThanOrEqual(-100);
  });

  it('dispose does not throw', () => {
    const chain = createMultibandChain(ctx);
    expect(() => chain.dispose()).not.toThrow();
  });
});
