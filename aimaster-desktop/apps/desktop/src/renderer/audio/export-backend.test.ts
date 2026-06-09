import { describe, it, expect, vi } from 'vitest';
import {
  masterWithPreferredBackend,
  optionsToChainConfig,
  isUsableRustResult,
  type InvokeFn,
} from './export-backend.js';
import type { MasteringOptions } from '../stores/audioStore.js';

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

describe('isUsableRustResult', () => {
  it('requires ok===true and a non-empty outputPath', () => {
    expect(isUsableRustResult(rustOk)).toBe(true);
    expect(isUsableRustResult({ ok: false, outputPath: '/x' })).toBe(false);
    expect(isUsableRustResult({ ok: true })).toBe(false);
    expect(isUsableRustResult(null)).toBe(false);
  });
});
