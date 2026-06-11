import { describe, it, expect } from 'vitest';
import { createTransientChain } from './transient-chain.js';
import { defaultTransientConfig, type TransientConfig } from './transient-config.js';

class P { value = 0; }
class FakeComp { threshold = new P(); ratio = new P(); attack = new P(); release = new P(); knee = new P(); connect() {} disconnect() {} }
class FakeGain { gain = new P(); connect() {} disconnect() {} }

function ctx(rec?: { comp: FakeComp[]; gains: FakeGain[] }): BaseAudioContext {
  return {
    createGain: () => { const g = new FakeGain(); rec?.gains.push(g); return g; },
    createDynamicsCompressor: () => { const c = new FakeComp(); rec?.comp.push(c); return c; },
  } as unknown as BaseAudioContext;
}

const cfg = (over: Partial<TransientConfig> = {}): TransientConfig => ({ ...defaultTransientConfig(), ...over });

describe('transient-chain (compressor preview approximation)', () => {
  it('inactive for default config, active when driven', () => {
    const chain = createTransientChain(ctx());
    chain.apply(cfg());
    expect(chain.isActive()).toBe(false);
    chain.apply(cfg({ bypass: false, sustainPct: -60 }));
    expect(chain.isActive()).toBe(true);
  });

  it('sustain reduction increases compression ratio + makeup', () => {
    const rec = { comp: [] as FakeComp[], gains: [] as FakeGain[] };
    const chain = createTransientChain(ctx(rec));
    chain.apply(cfg({ bypass: false, sustainPct: -80 }));
    expect(rec.comp[0]!.ratio.value).toBeGreaterThan(1);
    expect(rec.comp[0]!.threshold.value).toBeLessThan(-18);
    const makeup = rec.gains.map((g) => g.gain.value);
    expect(makeup.some((v) => v > 1)).toBe(true);
  });

  it('more attack/punch slows the compressor attack', () => {
    const rec = { comp: [] as FakeComp[], gains: [] as FakeGain[] };
    const chain = createTransientChain(ctx(rec));
    chain.apply(cfg({ bypass: false, attackPct: 100 }));
    expect(rec.comp[0]!.attack.value).toBeGreaterThan(0.02);
  });

  it('dispose does not throw', () => {
    const chain = createTransientChain(ctx());
    expect(() => chain.dispose()).not.toThrow();
  });
});
