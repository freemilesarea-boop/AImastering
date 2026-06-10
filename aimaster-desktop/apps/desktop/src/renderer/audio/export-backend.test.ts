import { describe, it, expect, vi } from 'vitest';
import {
  masterWithPreferredBackend,
  optionsToChainConfig,
  isUsableRustResult,
  type InvokeFn,
} from './export-backend.js';
import type { MasteringOptions } from '../stores/audioStore.js';
import { defaultMultibandConfig, type MultibandConfig } from './multiband-config.js';
import { defaultImagerMultiband, type ImagerMultibandConfig } from './imager-config.js';
import { defaultSaturationConfig, CHARACTER_CODE, type SaturationConfig } from './saturation-config.js';
import { defaultTransientConfig, type TransientConfig } from './transient-config.js';
import { defaultDynamicEqConfig, defaultDynEqBand, FILTER_CODE, type DynamicEqConfig } from './dyneq-config.js';

const options: MasteringOptions = {
  style: 'balanced', targetLufs: -12, targetTp: -1, sampleRate: 48000,
  bitDepth: 24, applyAiCorrections: true, limiterStrength: 'medium',
  stereoWidth: 1.1, outputGainDb: -1.5,
  rt: { eqAirDb: 3, dynRatio: 2.5, limCeilingDbtp: -1.2 },
};
const pythonOptions = { style: 'balanced', targetLufs: -12 };
const rustOk = { ok: true, backend: 'rust', outputPath: '/out.wav', previewPath: '/p.mp3' };
const pyOk = { outputPath: '/py.wav', previewPath: '/py.mp3' };

function mockInvoke(scripts: Record<string, (args: unknown[]) => unknown>): {
  invoke: InvokeFn; calls: string[];
} {
  const calls: string[] = [];
  const invoke: InvokeFn = vi.fn(async (channel: string, ...args: unknown[]) => {
    calls.push(channel);
    const fn = scripts[channel];
    if (!fn) throw new Error(`unexpected channel ${channel}`);
    return fn(args);
  });
  return { invoke, calls };
}

describe('optionsToChainConfig', () => {
  it('prefers rt overrides and maps base options', () => {
    const cfg = optionsToChainConfig(options);
    expect(cfg.eqAirDb).toBe(3);
    expect(cfg.dynRatio).toBe(2.5);
    expect(cfg.eqAdaptive).toBe(true);
    expect(cfg.imgWidthPct).toBeCloseTo(110, 6);
    expect(cfg.outputGainDb).toBe(-1.5);
    expect(cfg.limCeilingDbtp).toBe(-1.2);
  });
  it('produces only finite numbers', () => {
    const cfg = optionsToChainConfig({ ...options, rt: {} });
    for (const v of Object.values(cfg)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('masterWithPreferredBackend routing', () => {
  it('flag OFF → only python is called', async () => {
    const m = mockInvoke({ 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: false });
    expect(m.calls).toContain('audio:master');
    expect(m.calls).not.toContain('audio:master-rust-experimental');
    expect(res.outputPath).toBe('/py.wav');
  });

  it('flag ON + usable rust result → rust used, python skipped', async () => {
    const m = mockInvoke({ 'audio:master-rust-experimental': () => rustOk, 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true });
    expect(m.calls).toContain('audio:master-rust-experimental');
    expect(m.calls).not.toContain('audio:master');
    expect(res.backend).toBe('rust');
  });

  it('flag ON + rust throws → python fallback', async () => {
    const m = mockInvoke({ 'audio:master-rust-experimental': () => { throw new Error('boom'); }, 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true });
    expect(m.calls[0]).toBe('audio:master-rust-experimental');
    expect(m.calls).toContain('audio:master');
    expect(res.outputPath).toBe('/py.wav');
  });

  it('flag ON + rust ok:false → python fallback', async () => {
    const m = mockInvoke({ 'audio:master-rust-experimental': () => ({ ok: false }), 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true });
    expect(m.calls).toContain('audio:master');
    expect(res.outputPath).toBe('/py.wav');
  });
});

describe('multiband attach on the rust export request', () => {
  function capturedChainConfig(scriptRust: () => unknown): { invoke: InvokeFn; getReq: () => Record<string, unknown> | null } {
    let req: Record<string, unknown> | null = null;
    const invoke: InvokeFn = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'audio:master-rust-experimental') { req = payload as Record<string, unknown>; return scriptRust(); }
      return pyOk;
    });
    return { invoke, getReq: () => req };
  }

  it('attaches multiband when active (non-unity)', async () => {
    const active: MultibandConfig = {
      ...defaultMultibandConfig(), bypass: false,
      bands: defaultMultibandConfig().bands.map((b) => ({ ...b, ratio: 3 })) as MultibandConfig['bands'],
    };
    const c = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, multiband: active });
    const chainConfig = c.getReq()?.['chainConfig'] as Record<string, unknown>;
    expect(chainConfig['multiband']).toBeDefined();
  });

  it('omits multiband when bypassed / unity', async () => {
    const c = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, multiband: defaultMultibandConfig() });
    const chainConfig = c.getReq()?.['chainConfig'] as Record<string, unknown>;
    expect(chainConfig['multiband']).toBeUndefined();
  });

  it('attaches imagerMultiband when active, omits when unity', async () => {
    const active: ImagerMultibandConfig = { ...defaultImagerMultiband(), enabled: true, widthsPct: [0, 100, 100, 200] };
    const c1 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c1.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, imagerMultiband: active });
    expect((c1.getReq()?.['chainConfig'] as Record<string, unknown>)['imagerMultiband']).toBeDefined();

    const c2 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c2.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, imagerMultiband: defaultImagerMultiband() });
    expect((c2.getReq()?.['chainConfig'] as Record<string, unknown>)['imagerMultiband']).toBeUndefined();
  });

  it('attaches saturation with a numeric character code when active, omits when unity', async () => {
    const sat: SaturationConfig = { ...defaultSaturationConfig(), bypass: false, character: 'tube', drive: 60 };
    const c1 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c1.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, saturation: sat });
    const wire = (c1.getReq()?.['chainConfig'] as Record<string, unknown>)['saturation'] as Record<string, unknown> | undefined;
    expect(wire).toBeDefined();
    expect(wire!['characterCode']).toBe(CHARACTER_CODE.tube);
    expect(wire!['character']).toBeUndefined(); // wire uses code, not string

    const c2 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c2.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, saturation: defaultSaturationConfig() });
    expect((c2.getReq()?.['chainConfig'] as Record<string, unknown>)['saturation']).toBeUndefined();
  });

  it('attaches transient (parallel band arrays) when active, omits when unity', async () => {
    const tr: TransientConfig = { ...defaultTransientConfig(), bypass: false, attackPct: 40, sustainPct: -20 };
    const c1 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c1.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, transient: tr });
    const wire = (c1.getReq()?.['chainConfig'] as Record<string, unknown>)['transient'] as Record<string, unknown> | undefined;
    expect(wire).toBeDefined();
    expect(wire!['attackPct']).toBe(40);
    expect(Array.isArray(wire!['bandAttacksPct'])).toBe(true);
    expect((wire!['bandAttacksPct'] as number[]).length).toBe(4);

    const c2 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c2.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, transient: defaultTransientConfig() });
    expect((c2.getReq()?.['chainConfig'] as Record<string, unknown>)['transient']).toBeUndefined();
  });

  it('attaches dynamicEq (band list with codes) when active, omits when unity', async () => {
    const de: DynamicEqConfig = { bypass: false, bands: [{ ...defaultDynEqBand(3000), filterType: 'highshelf' }] };
    const c1 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c1.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, dynamicEq: de });
    const wire = (c1.getReq()?.['chainConfig'] as Record<string, unknown>)['dynamicEq'] as { bands: Array<Record<string, unknown>> } | undefined;
    expect(wire).toBeDefined();
    expect(wire!.bands[0]!['typeCode']).toBe(FILTER_CODE.highshelf);
    expect(wire!.bands[0]!['filterType']).toBeUndefined(); // wire uses codes

    const c2 = capturedChainConfig(() => rustOk);
    await masterWithPreferredBackend({ invoke: c2.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true, dynamicEq: defaultDynamicEqConfig() });
    expect((c2.getReq()?.['chainConfig'] as Record<string, unknown>)['dynamicEq']).toBeUndefined();
  });
});

describe('isUsableRustResult', () => {
  it('requires ok===true and a non-empty outputPath', () => {
    expect(isUsableRustResult(rustOk)).toBe(true);
    expect(isUsableRustResult({ ok: false, outputPath: '/x' })).toBe(false);
    expect(isUsableRustResult({ ok: true })).toBe(false);
    expect(isUsableRustResult(null)).toBe(false);
  });
});
