// master-render-fixes-selftest — three defects in the single-file master
// render, and the checks that keep them fixed.
//
// All three had shipped, and all three were invisible from inside the app:
// the render reported success, the numbers in the result looked right, and
// the file was wrong.
//
//   1. **The loudness correction never reached the engine.** A config carries
//      two input-gain fields and only one is read — when `suiteConfig` is
//      present the engine takes the JSON and never looks at the flat fields.
//      The correction was written to the flat one. The app's export path
//      always sends `suiteConfig`, so every loudness-normalised master went
//      out with the correction discarded, while the metrics reported it as
//      applied. The existing tests missed it because they pass flat configs.
//
//   2. **One correction pass is not enough.** A chain with a limiter is not
//      linear in its input gain: solving once assumes +6 dB in gives +6 dB
//      out, and once the limiter is working most of it comes straight back
//      off.
//
//   3. **No latency compensation.** The chain's STFT stages delay by ~2048
//      samples. The render ignored it, so the master arrived up to 43 ms late
//      and the last 43 ms — the end of the fade — was pushed past the end of
//      the buffer and lost.
//
// Run:  pnpm --filter @aimaster/desktop test:master-render-fixes

import { createRequire } from 'node:module';
import {
  renderStereoBuffer, renderStereoBufferNormalized,
} from '../src/main/offline/rust-offline-render-core.js';
import { withInputGain, type OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import { measureStereoLoudness } from '../src/main/offline/offline-loudness.js';

process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SR = 48_000;

function flatCfg(over: Partial<OfflineChainConfig> = {}): OfflineChainConfig {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: true,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: true,
    limCeilingDbtp: 0, limLookaheadMs: 1, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false,
    ...over,
  };
}

/** The shape the app actually exports with: everything inside `suiteConfig`. */
function suiteCfg(suite: Record<string, unknown>): OfflineChainConfig {
  return { ...flatCfg(), suiteConfig: suite };
}

/** A chain with an STFT stage engaged, so it reports real latency. */
const LATENT_SUITE = {
  denoise: { reductionDb: 3, thresholdDb: 0, sharpness: 1, smoothing: 0.5, autoProfile: true, bypass: false },
};

function noise(): () => number {
  let s = 0x9e3779b9n;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(s >> 33n) / 2 ** 30 - 1;
  };
}

function impulseAt(n: number, index: number, amp = 0.5): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(n);
  l[index] = amp;
  return { left: l, right: l.slice() };
}

/** Something loudness can be measured on: body, top and a beat. */
function bed(seconds: number, amp: number): { left: Float32Array; right: Float32Array } {
  const n = SR * seconds;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const nz = noise();
  const partials: Array<[number, number]> = [
    [55, 0.9], [110, 0.7], [220, 0.6], [440, 0.45], [880, 0.3], [1760, 0.2], [3500, 0.12],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const [hz, a] of partials) v += a * Math.sin(2 * Math.PI * hz * t);
    v += 1.6 * Math.exp(-((t % 0.5)) / 0.05) * Math.sin(2 * Math.PI * 60 * (t % 0.5));
    v += 0.05 * nz();
    const k = amp / 4.5;
    l[i] = k * v;
    r[i] = k * (v * 0.92 + 0.08 * nz());
  }
  return { left: l, right: r };
}

function peakIndex(buf: Float32Array): number {
  let best = 0, bestV = -1;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

// A 2048-point STFT spreads an impulse across its window, so an exact index
// is not the right claim; being within a few milliseconds of where it started
// is, and 2048 samples away is what a missing compensation looks like.
const SMEAR = 256;

// ── 1. Latency ───────────────────────────────────────────────────────────────

console.log('\n=== THE CHAIN NO LONGER RUNS LATE ===\n');

{
  const n = SR * 2;
  const src = impulseAt(n, SR);
  const flat = renderStereoBuffer(src.left, src.right, flatCfg(), SR);
  check(
    'a neutral chain reports no latency to compensate',
    flat.metrics.latencySamples === 0,
    `${String(flat.metrics.latencySamples)} samples`,
  );

  const latent = renderStereoBuffer(src.left, src.right, suiteCfg(LATENT_SUITE), SR);
  check(
    'a latent chain reports the delay it adds',
    (latent.metrics.latencySamples ?? 0) > 0,
    `${String(latent.metrics.latencySamples)} samples ` +
    `(${((latent.metrics.latencySamples ?? 0) / SR * 1000).toFixed(1)} ms)`,
  );
  check(
    'and the master comes out on the source’s timeline, not late',
    Math.abs(peakIndex(latent.left) - SR) <= SMEAR,
    `피크 @ ${peakIndex(latent.left)} (원본 ${SR}) — 보정이 없으면 ${latent.metrics.latencySamples} 샘플 뒤에 있었다`,
  );
}

{
  // The end of the fade. A chain that delays by L samples still holds L
  // samples when the input runs out; processing exactly `n` throws them away.
  const n = SR * 2;
  const lateAt = n - 480;   // 10 ms from the end
  const src = impulseAt(n, lateAt);
  const out = renderStereoBuffer(src.left, src.right, suiteCfg(LATENT_SUITE), SR);
  check(
    'the last 10 ms survives the render',
    Math.abs(peakIndex(out.left) - lateAt) <= SMEAR && Math.abs(out.left[peakIndex(out.left)]!) > 0.2,
    `피크 @ ${peakIndex(out.left)} (원본 ${lateAt}), 진폭 ${Math.abs(out.left[peakIndex(out.left)]!).toFixed(3)} — ` +
    '체인 안에 남은 꼬리를 밀어내지 않으면 페이드아웃 끝이 사라진다',
  );
  check(
    'and the output is still exactly as long as the input',
    out.left.length === n && out.metrics.samples === n,
    `${out.left.length} samples`,
  );
}

// ── 2. The correction reaches the engine ─────────────────────────────────────

console.log('\n=== THE LOUDNESS CORRECTION IS APPLIED ===\n');

{
  const flat = withInputGain(flatCfg(), 6);
  const suite = withInputGain(suiteCfg({ denoise: { reductionDb: 1 } }), 6);
  check(
    'gain is written where the engine will read it',
    flat.inputGainDb === 6 &&
    (suite.suiteConfig as { inputGainDb?: number }).inputGainDb === 6 &&
    suite.inputGainDb === 0,
    'suiteConfig 가 있으면 엔진은 flat 필드를 보지 않는다 — 거기에 쓰면 아무 일도 안 일어난다',
  );
}

{
  // The decisive one, in the shape the app actually exports with.
  const src = bed(12, 0.35);
  const cfg = suiteCfg({
    limiter: { ceilingDbtp: -1, lookaheadMs: 2, isp: false, bypass: false },
  });
  const r = renderStereoBufferNormalized(src.left, src.right, cfg, SR, {
    targetLufs: -14, targetTp: -1,
  });
  const err = r.metrics.finalLufs - (-14);
  check(
    'a suite-configured master reaches its loudness target',
    Math.abs(err) < 1.0 && r.metrics.loudnessNote === 'ok',
    `${r.metrics.finalLufs.toFixed(2)} LUFS vs 목표 -14 (오차 ${err.toFixed(2)} dB, ` +
    `보정 ${r.metrics.appliedLoudnessGainDb.toFixed(1)} dB, ${r.metrics.loudnessPasses}패스)`,
  );
  check(
    'the reported loudness is a measurement of the returned audio',
    Math.abs(measureStereoLoudness(r.left, r.right, SR).integratedLufs - r.metrics.finalLufs) < 0.01,
    `보고 ${r.metrics.finalLufs.toFixed(2)} vs 재측정 ` +
    `${measureStereoLoudness(r.left, r.right, SR).integratedLufs.toFixed(2)} LUFS`,
  );
  check(
    'and the ceiling holds',
    r.metrics.finalTruePeakDb <= -1 + 0.3,
    `${r.metrics.finalTruePeakDb.toFixed(2)} dBTP vs 실링 -1`,
  );
}

// ── 3. Convergence ───────────────────────────────────────────────────────────

console.log('\n=== THE CORRECTION CONVERGES ===\n');

{
  // A correction big enough that the limiter eats part of it. One pass
  // undershoots; this checks the result lands, and that it took more than
  // one pass to get there — the second half is what proves the iteration is
  // doing the work rather than the first solve happening to be right.
  const src = bed(12, 0.06);
  const cfg = suiteCfg({
    limiter: { ceilingDbtp: -1, lookaheadMs: 2, isp: false, bypass: false },
    dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, mixPct: 100, bypass: false },
  });
  // Room to reach it: the point of this case is the LIMITER fighting the
  // correction, not the policy clamping it. Capping the boost too low would
  // test the clamp again, which the case below already covers.
  const r = renderStereoBufferNormalized(src.left, src.right, cfg, SR, {
    targetLufs: -14, targetTp: -1, maxBoostDb: 40,
  });
  check(
    'a correction the limiter fights still lands on target',
    Math.abs(r.metrics.finalLufs + 14) < 1.0,
    `${r.metrics.finalLufs.toFixed(2)} LUFS, 보정 ${r.metrics.appliedLoudnessGainDb.toFixed(1)} dB, ` +
    `${r.metrics.loudnessPasses}패스`,
  );
  check(
    'and it took more than one pass to get there',
    r.metrics.loudnessPasses > 1,
    `${r.metrics.loudnessPasses}패스 — 한 번만 풀었다면 리미터가 되돌린 만큼 미달했을 것`,
  );
}

{
  const src = bed(12, 0.7);
  const cfg = suiteCfg({
    limiter: { ceilingDbtp: -1, lookaheadMs: 2, isp: false, bypass: false },
    dynamics: { thresholdDb: -18, ratio: 3.2, attackMs: 5, releaseMs: 90, mixPct: 100, bypass: false },
  });
  const r = renderStereoBufferNormalized(src.left, src.right, cfg, SR, {
    targetLufs: -6, targetTp: -1, maxBoostDb: 30,
  });
  check(
    'an unreachable target is reported rather than claimed',
    r.metrics.loudnessNote !== 'ok' && r.metrics.finalLufs < -6,
    `${r.metrics.finalLufs.toFixed(2)} LUFS (목표 -6), ${r.metrics.loudnessNote} — ` +
    '실링이 막고 있는데 목표를 맞췄다고 보고하면 안 된다',
  );
  check(
    'and the ceiling still holds while it fails',
    r.metrics.finalTruePeakDb <= -1 + 0.3,
    `${r.metrics.finalTruePeakDb.toFixed(2)} dBTP`,
  );
  check(
    'the pass count never exceeds its own cap',
    r.metrics.loudnessPasses <= 4,
    `${r.metrics.loudnessPasses}패스`,
  );
}

{
  const n = SR * 4;
  const r = renderStereoBufferNormalized(
    new Float32Array(n), new Float32Array(n), flatCfg(), SR,
    { targetLufs: -14, targetTp: -1 },
  );
  check(
    'silence is left alone rather than boosted 12 dB into its own noise',
    r.metrics.appliedLoudnessGainDb === 0 && r.metrics.loudnessNote === 'silence',
    `${r.metrics.appliedLoudnessGainDb} dB, ${r.metrics.loudnessNote}`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
