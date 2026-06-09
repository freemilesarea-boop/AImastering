// Selftest — export-backend routing + chain-config mapping (engine unify C-2b).
//
// Verifies the renderer's export backend switch with a MOCK invoke (no
// Electron, no Python): flag OFF → Python only; flag ON + usable Rust result
// → Rust used; flag ON + Rust throws or returns ok:false → Python fallback.
// Also checks optionsToChainConfig maps store options → DSP config.
// Run via `pnpm test:export-backend`.

import {
  masterWithPreferredBackend,
  optionsToChainConfig,
  isUsableRustResult,
  type InvokeFn,
} from '../src/renderer/audio/export-backend.js';
import type { MasteringOptions } from '../src/renderer/stores/audioStore.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const options: MasteringOptions = {
  style: 'balanced', targetLufs: -12, targetTp: -1, sampleRate: 48000,
  bitDepth: 24, applyAiCorrections: true, limiterStrength: 'medium',
  stereoWidth: 1.1, outputGainDb: -1.5,
  rt: { eqAirDb: 3, dynRatio: 2.5, limCeilingDbtp: -1.2 },
};

const pythonOptions = { style: 'balanced', targetLufs: -12 };

function mockInvoke(scripts: Record<string, (args: unknown[]) => unknown>): {
  invoke: InvokeFn; calls: string[];
} {
  const calls: string[] = [];
  const invoke: InvokeFn = async (channel: string, ...args: unknown[]) => {
    calls.push(channel);
    const fn = scripts[channel];
    if (!fn) throw new Error(`unexpected channel ${channel}`);
    return fn(args);
  };
  return { invoke, calls };
}

const rustOk = { ok: true, backend: 'rust', outputPath: '/out.wav', previewPath: '/p.mp3' };
const pyOk = { outputPath: '/py.wav', previewPath: '/py.mp3' };

async function main(): Promise<void> {
  console.log('export-backend-selftest');

  console.log('chain-config mapping');
  {
    const cfg = optionsToChainConfig(options);
    check('rt override wins (eqAirDb=3)', cfg.eqAirDb === 3);
    check('rt override wins (dynRatio=2.5)', cfg.dynRatio === 2.5);
    check('eqAdaptive = applyAiCorrections', cfg.eqAdaptive === true);
    check('stereoWidth 1.1 → imgWidthPct 110', Math.abs(cfg.imgWidthPct - 110) < 1e-9);
    check('outputGainDb carried', cfg.outputGainDb === -1.5);
    check('limCeiling from rt override', cfg.limCeilingDbtp === -1.2);
    check('no NaN in any numeric field', Object.values(cfg).every((v) => typeof v !== 'number' || Number.isFinite(v)));
  }

  console.log('routing: flag OFF → python only');
  {
    const m = mockInvoke({ 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: false });
    check('python channel used', m.calls.includes('audio:master'));
    check('rust channel NOT called', !m.calls.includes('audio:master-rust-experimental'));
    check('returns python result', res.outputPath === '/py.wav');
  }

  console.log('routing: flag ON + usable rust → rust used');
  {
    const m = mockInvoke({ 'audio:master-rust-experimental': () => rustOk, 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true });
    check('rust channel used', m.calls.includes('audio:master-rust-experimental'));
    check('python NOT called (rust succeeded)', !m.calls.includes('audio:master'));
    check('returns rust result', res.outputPath === '/out.wav' && res.backend === 'rust');
  }

  console.log('routing: flag ON + rust throws → python fallback');
  {
    const m = mockInvoke({ 'audio:master-rust-experimental': () => { throw new Error('boom'); }, 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true });
    check('rust attempted then python fallback', m.calls[0] === 'audio:master-rust-experimental' && m.calls.includes('audio:master'));
    check('returns python result on fallback', res.outputPath === '/py.wav');
  }

  console.log('routing: flag ON + rust ok:false → python fallback');
  {
    const m = mockInvoke({ 'audio:master-rust-experimental': () => ({ ok: false, error: 'x' }), 'audio:master': () => pyOk });
    const res = await masterWithPreferredBackend({ invoke: m.invoke, sourcePath: '/in.wav', options, pythonOptions, rustEnabled: true });
    check('python fallback on unusable rust', m.calls.includes('audio:master'));
    check('returns python result', res.outputPath === '/py.wav');
  }

  console.log('isUsableRustResult predicate');
  {
    check('ok+outputPath → usable', isUsableRustResult(rustOk));
    check('ok:false → not usable', !isUsableRustResult({ ok: false, outputPath: '/x' }));
    check('missing outputPath → not usable', !isUsableRustResult({ ok: true }));
    check('null → not usable', !isUsableRustResult(null));
  }

  if (failures > 0) { console.error(`\nFAILED: ${failures} check(s)`); process.exit(1); }
  console.log('\nALL PASS');
}

void main();
