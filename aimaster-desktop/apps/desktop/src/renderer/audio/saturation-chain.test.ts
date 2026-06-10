import { describe, it, expect } from 'vitest';
import { createSaturationChain } from './saturation-chain.js';
import { defaultSaturationConfig, type SaturationConfig } from './saturation-config.js';

class P { value = 0; }
class FakeBiquad { type = ''; frequency = new P(); Q = new P(); connect() {} disconnect() {} }
class FakeGain { gain = new P(); connect() {} disconnect() {} }
class FakeWaveShaper { curve: Float32Array | null = null; oversample = 'none'; connect() {} disconnect() {} }

const ctx = {
  createGain: () => new FakeGain(),
  createBiquadFilter: () => new FakeBiquad(),
  createWaveShaper: () => new FakeWaveShaper(),
} as unknown as BaseAudioContext;

describe('saturation-chain (WebAudio preview approximation)', () => {
  it('inactive for bypass/unity, active when driven', () => {
    const chain = createSaturationChain(ctx);
    chain.apply(defaultSaturationConfig());
    expect(chain.isActive()).toBe(false);
    chain.apply({ ...defaultSaturationConfig(), bypass: false, drive: 70 } as SaturationConfig);
    expect(chain.isActive()).toBe(true);
  });

  it('apply installs a curve on all 4 band shapers when driven', () => {
    const shapers: FakeWaveShaper[] = [];
    const recCtx = {
      createGain: () => new FakeGain(),
      createBiquadFilter: () => new FakeBiquad(),
      createWaveShaper: () => { const w = new FakeWaveShaper(); shapers.push(w); return w; },
    } as unknown as BaseAudioContext;
    const chain = createSaturationChain(recCtx);
    chain.apply({ ...defaultSaturationConfig(), bypass: false, drive: 80 } as SaturationConfig);
    expect(shapers).toHaveLength(4);
    expect(shapers.every((s) => s.curve instanceof Float32Array && s.curve.length > 0)).toBe(true);
  });

  it('mix sets dry/wet gains (dry = 1 − mix)', () => {
    const gains: FakeGain[] = [];
    const recCtx = {
      createGain: () => { const g = new FakeGain(); gains.push(g); return g; },
      createBiquadFilter: () => new FakeBiquad(),
      createWaveShaper: () => new FakeWaveShaper(),
    } as unknown as BaseAudioContext;
    const chain = createSaturationChain(recCtx);
    chain.apply({ ...defaultSaturationConfig(), bypass: false, drive: 50, mixPct: 40 } as SaturationConfig);
    const vals = gains.map((g) => g.gain.value);
    expect(vals).toContain(0.6); // dry = 1 − 0.4
    expect(vals).toContain(0.4); // wet
  });

  it('dispose does not throw', () => {
    const chain = createSaturationChain(ctx);
    expect(() => chain.dispose()).not.toThrow();
  });
});
