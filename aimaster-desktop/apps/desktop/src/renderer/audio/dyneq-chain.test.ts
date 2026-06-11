import { describe, it, expect } from 'vitest';
import { createDynEqChain } from './dyneq-chain.js';
import { defaultDynamicEqConfig, defaultDynEqBand, type DynamicEqConfig } from './dyneq-config.js';

class P { value = 0; }
class FakeBiquad { type = ''; frequency = new P(); Q = new P(); gain = new P(); connect() {} disconnect() {} }
class FakeGain { gain = new P(); connect() {} disconnect() {} }

function ctx(rec?: FakeBiquad[]): BaseAudioContext {
  return {
    createGain: () => new FakeGain(),
    createBiquadFilter: () => { const b = new FakeBiquad(); rec?.push(b); return b; },
  } as unknown as BaseAudioContext;
}

const cfg = (over: Partial<DynamicEqConfig> = {}): DynamicEqConfig => ({ ...defaultDynamicEqConfig(), ...over });

describe('dyneq-chain (static preview approximation)', () => {
  it('inactive for default/empty config', () => {
    const chain = createDynEqChain(ctx());
    chain.apply(cfg());
    expect(chain.isActive()).toBe(false);
  });

  it('active + applies a directional static gain per enabled band', () => {
    const rec: FakeBiquad[] = [];
    const chain = createDynEqChain(ctx(rec));
    chain.apply(cfg({ bypass: false, bands: [
      { ...defaultDynEqBand(2000), enabled: true, filterType: 'bell', rangeDb: 8, mode: 'downcut' },
      { ...defaultDynEqBand(300), enabled: true, filterType: 'lowshelf', rangeDb: 6, mode: 'upboost' },
    ] }));
    expect(chain.isActive()).toBe(true);
    const gains = rec.map((b) => b.gain.value);
    expect(gains).toContain(-4);  // downcut 8 * 0.5
    expect(gains).toContain(3);   // upboost 6 * 0.5
    const types = rec.map((b) => b.type);
    expect(types).toContain('peaking');
    expect(types).toContain('lowshelf');
  });

  it('disabled / zero-range bands sit at 0 dB', () => {
    const rec: FakeBiquad[] = [];
    const chain = createDynEqChain(ctx(rec));
    chain.apply(cfg({ bypass: false, bands: [
      { ...defaultDynEqBand(2000), enabled: false, rangeDb: 8 },
      { ...defaultDynEqBand(500), enabled: true, rangeDb: 0 },
    ] }));
    expect(chain.isActive()).toBe(false);
    expect(rec.every((b) => b.gain.value === 0)).toBe(true);
  });

  it('dispose does not throw', () => {
    const chain = createDynEqChain(ctx());
    expect(() => chain.dispose()).not.toThrow();
  });
});
