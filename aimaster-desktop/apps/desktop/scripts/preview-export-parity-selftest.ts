// preview-export-parity-selftest — PROVE the native WebAudio preview tracks the
// Rust offline export.  Renders the SAME core-chain settings through both
// engines (node-web-audio-api OfflineAudioContext vs the node WASM Rust chain)
// and checks that each control moves the spectrum in the SAME DIRECTION.
//
// This is the objective grounds for flipping VITE_LOUI_RUST_OFFLINE_RENDER ON:
// what the user hears in the preview agrees in direction with the exported file.
// Magnitudes differ (the preview is an approximation) — direction parity is the
// safety property; magnitudes are reported.
//
//   pnpm --filter @aimaster/desktop test:parity

import { OfflineAudioContext, AudioBuffer } from 'node-web-audio-api';
import { createNativeDspChain } from '../src/renderer/audio/native-dsp-chain.js';
import type { RealtimeChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';
import { renderStereoBuffer } from '../src/main/offline/rust-offline-render-core.js';
import { loadWasmModule, type OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';

const SR = 48_000;
const N = SR; // 1 s

type Shared = RealtimeChainConfig & OfflineChainConfig;
function base(): Shared {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: false,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: false,
    limCeilingDbtp: -1, limLookaheadMs: 2.5, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false,
  } as Shared;
}

const sine = (f: number, a: number): Float32Array => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = a * Math.sin((2 * Math.PI * f * i) / SR); return o; };
const mix = (...a: Float32Array[]): Float32Array => { const o = new Float32Array(N); for (const x of a) for (let i = 0; i < N; i++) o[i]! += x[i]!; return o; };
const rms = (a: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!; return Math.sqrt(s / a.length); };
const peak = (a: Float32Array): number => { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]!); if (v > p) p = v; } return p; };
const crestDb = (a: Float32Array): number => 20 * Math.log10(Math.max(1e-9, peak(a)) / Math.max(1e-9, rms(a)));
const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));
function goertzel(a: Float32Array, f: number): number {
  const k = Math.round((a.length * f) / SR), w = (2 * Math.PI * k) / a.length, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0; for (let i = 0; i < a.length; i++) { const s0 = a[i]! + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}
const sideRms = (l: Float32Array, r: Float32Array): number => { const s = new Float32Array(l.length); for (let i = 0; i < l.length; i++) s[i] = (l[i]! - r[i]!) * 0.5; return rms(s); };

async function renderNative(cfg: Shared, l: Float32Array, r: Float32Array): Promise<{ l: Float32Array; r: Float32Array }> {
  const ctx = new OfflineAudioContext(2, N, SR);
  const buf = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: SR });
  buf.copyToChannel(l, 0); buf.copyToChannel(r, 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const chain = createNativeDspChain(ctx); chain.apply(cfg);
  src.connect(chain.input); chain.output.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  const ol = new Float32Array(N), or = new Float32Array(N);
  out.copyFromChannel(ol, 0); out.copyFromChannel(or, 1);
  return { l: ol, r: or };
}
function renderRust(cfg: Shared, l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array } {
  const out = renderStereoBuffer(l, r, cfg, SR);
  return { l: out.left, r: out.right };
}

interface Case { name: string; cfg: Partial<Shared>; metric: (o: { l: Float32Array; r: Float32Array }) => number; input?: [Float32Array, Float32Array] }

async function main(): Promise<void> {
  if (!loadWasmModule()) { console.error('FAIL — node WASM not built'); process.exit(1); }
  const mono = mix(sine(60, 0.1), sine(1000, 0.1), sine(3500, 0.1), sine(18000, 0.1));
  const stereo: [Float32Array, Float32Array] = [sine(1000, 0.1), sine(1500, 0.1)];
  const loud = mix(sine(200, 0.45)); // hot tone for dynamics

  const cases: Case[] = [
    { name: 'EQ Air +12 (18k)', cfg: { eqAirDb: 12 }, metric: (o) => db(goertzel(o.l, 18000)) },
    { name: 'EQ LowShelf -12 (60)', cfg: { eqLowShelfDb: -12 }, metric: (o) => db(goertzel(o.l, 60)) },
    { name: 'EQ Presence +12 (3.5k)', cfg: { eqPresenceDb: 12 }, metric: (o) => db(goertzel(o.l, 3500)) },
    { name: 'Output -12 (RMS)', cfg: { outputGainDb: -12 }, metric: (o) => db(rms(o.l)) },
    { name: 'Width 0% (side)', cfg: { imgWidthPct: 0 }, metric: (o) => db(sideRms(o.l, o.r)), input: stereo },
    { name: 'Width 200% (side)', cfg: { imgWidthPct: 200 }, metric: (o) => db(sideRms(o.l, o.r)), input: stereo },
    { name: 'Compress (crest)', cfg: { dynBypass: false, dynThresholdDb: -30, dynRatio: 6 }, metric: (o) => crestDb(o.l), input: [loud, loud] },
  ];

  console.log('[preview-export-parity] native WebAudio preview vs Rust export — direction parity\n');
  console.log('  case                       native Δ   rust Δ    dir');
  let agree = 0;
  for (const c of cases) {
    const [il, ir] = c.input ?? [mono, mono];
    const dryN = await renderNative(base(), il, ir); const wetN = await renderNative({ ...base(), ...c.cfg }, il, ir);
    const dryR = renderRust(base(), il, ir); const wetR = renderRust({ ...base(), ...c.cfg }, il, ir);
    const dN = c.metric(wetN) - c.metric(dryN);
    const dR = c.metric(wetR) - c.metric(dryR);
    const same = Math.sign(Math.round(dN * 10)) === Math.sign(Math.round(dR * 10)) || (Math.abs(dN) < 0.3 && Math.abs(dR) < 0.3);
    if (same) agree++;
    console.log(`  ${c.name.padEnd(26)} ${dN.toFixed(1).padStart(7)} ${dR.toFixed(1).padStart(8)}    ${same ? '✓ agree' : '✗ DISAGREE'}`);
  }
  console.log(`\n  parity: ${agree}/${cases.length} controls move the preview and export the SAME direction`);
  if (agree === cases.length) console.log('PASS — preview tracks export (safe to flip the export flag re: direction)');
  else { console.error('FAIL — a control moves preview and export opposite ways'); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
