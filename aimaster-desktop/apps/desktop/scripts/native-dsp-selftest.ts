// native-dsp-selftest — PROVES the native WebAudio DSP fallback actually
// changes the rendered audio (not just the AudioParam values).  Uses
// node-web-audio-api's OfflineAudioContext to render real audio through
// `createNativeDspChain` and measures output RMS / high-frequency energy /
// stereo side energy for each extreme config.
//
// Run: pnpm tsx scripts/native-dsp-selftest.ts

import { OfflineAudioContext, AudioBuffer } from 'node-web-audio-api';
import { createNativeDspChain } from '../src/renderer/audio/native-dsp-chain.js';
import type { RealtimeChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';

const SR = 48_000;
const N = SR; // 1 s

function baseConfig(): RealtimeChainConfig {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: false,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: false,
    limCeilingDbtp: -1, limLookaheadMs: 2.5, limIsp: true, limBypass: true,
    outputGainDb: 0, masterBypass: false,
  };
}

function sine(freq: number, amp: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}
function mix(...arrs: Float32Array[]): Float32Array {
  const out = new Float32Array(arrs[0]!.length);
  for (const a of arrs) for (let i = 0; i < out.length; i++) out[i]! += a[i]!;
  return out;
}
function rms(a: Float32Array): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}
function goertzel(a: Float32Array, f: number): number {
  const k = Math.round((a.length * f) / SR);
  const w = (2 * Math.PI * k) / a.length, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < a.length; i++) { s0 = a[i]! + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}
function sideRms(l: Float32Array, r: Float32Array): number {
  const s = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) s[i] = (l[i]! - r[i]!) * 0.5;
  return rms(s);
}
function db(x: number): number { return 20 * Math.log10(Math.max(1e-12, x)); }

async function render(cfg: RealtimeChainConfig, left: Float32Array, right: Float32Array): Promise<{ l: Float32Array; r: Float32Array }> {
  const ctx = new OfflineAudioContext(2, N, SR);
  const buf = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: SR });
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const chain = createNativeDspChain(ctx);
  chain.apply(cfg);
  src.connect(chain.input);
  chain.output.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  const l = new Float32Array(N), r = new Float32Array(N);
  rendered.copyFromChannel(l, 0);
  rendered.copyFromChannel(r, 1);
  return { l, r };
}

async function main() {
  let fail = 0;
  const check = (name: string, pass: boolean, detail: string) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
    if (!pass) fail++;
  };

  // Mono broadband for EQ / output-gain tests.
  const mono = mix(sine(60, 0.1, N), sine(1000, 0.1, N), sine(12000, 0.1, N), sine(18000, 0.1, N));

  console.log('\n=== NATIVE DSP CHAIN — OfflineAudioContext render proof ===\n');

  // 1) Output gain -24 dB → RMS drops ~24 dB.
  {
    const flat = await render(baseConfig(), mono, mono);
    const cfg = { ...baseConfig(), outputGainDb: -24 };
    const cut = await render(cfg, mono, mono);
    const d = db(rms(cut.l)) - db(rms(flat.l));
    check('Output -24dB', Math.abs(d + 24) < 1.5, `ΔRMS = ${d.toFixed(1)} dB (expect ≈ -24)`);
  }

  // 2) EQ air +24 dB → 18 kHz energy rises strongly.
  {
    const flat = await render(baseConfig(), mono, mono);
    const cfg = { ...baseConfig(), eqAirDb: 24 };
    const air = await render(cfg, mono, mono);
    const d = db(goertzel(air.l, 18000)) - db(goertzel(flat.l, 18000));
    check('EQ Air +24dB (18kHz)', d > 6, `Δ18kHz = ${d.toFixed(1)} dB (expect ≫0)`);
  }

  // 3) EQ low-shelf -24 dB → 60 Hz energy drops.
  {
    const flat = await render(baseConfig(), mono, mono);
    const cfg = { ...baseConfig(), eqLowShelfDb: -24 };
    const cut = await render(cfg, mono, mono);
    const d = db(goertzel(cut.l, 60)) - db(goertzel(flat.l, 60));
    check('EQ LowShelf -24dB (60Hz)', d < -6, `Δ60Hz = ${d.toFixed(1)} dB (expect ≪0)`);
  }

  // 4) Width 0% → side energy collapses (decorrelated L/R input).
  {
    const l = sine(1000, 0.1, N), r = sine(1500, 0.1, N);
    const wide = await render(baseConfig(), l, r);
    const cfg = { ...baseConfig(), imgWidthPct: 0 };
    const monoed = await render(cfg, l, r);
    const d = db(sideRms(monoed.l, monoed.r)) - db(sideRms(wide.l, wide.r));
    check('Width 0% (side energy)', d < -20, `ΔSide = ${d.toFixed(1)} dB (expect ≪0)`);
  }

  // 5) Width 200% → side energy increases.
  {
    const l = sine(1000, 0.1, N), r = sine(1500, 0.1, N);
    const norm = await render(baseConfig(), l, r);
    const cfg = { ...baseConfig(), imgWidthPct: 200 };
    const wider = await render(cfg, l, r);
    const d = db(sideRms(wider.l, wider.r)) - db(sideRms(norm.l, norm.r));
    check('Width 200% (side energy)', d > 3, `ΔSide = ${d.toFixed(1)} dB (expect >0)`);
  }

  // 6) Master bypass → output ≈ input (within a small tolerance).
  {
    const cfg = { ...baseConfig(), eqAirDb: 24, outputGainDb: -12, masterBypass: true };
    const out = await render(cfg, mono, mono);
    const d = db(goertzel(out.l, 18000)) - db(goertzel(mono, 18000));
    check('Master bypass = passthrough', Math.abs(d) < 1.5, `Δ18kHz = ${d.toFixed(1)} dB (expect ≈0)`);
  }

  console.log(`\n=== ${fail === 0 ? 'ALL NATIVE DSP RENDER TESTS PASS' : `${fail} FAILED`} ===\n`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
