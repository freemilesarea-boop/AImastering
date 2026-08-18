// stem-render-selftest — the stem sum is checked as audio, not as bookkeeping.
//
// The claim this file has to defend is narrow and easy to get wrong:
// **stems whose chains have different latencies still line up in the sum.**
// Everything else here (gain, balance, mute, solo, length) is arithmetic
// that a reader can verify by eye. The alignment is not — it depends on the
// engine's own reported latency, on flushing the chain's tail, and on the
// head trim, and if any of the three is wrong the result is not an error
// but a mix that quietly sounds like a phaser.
//
// So the decisive tests put an IMPULSE through, and check where it lands.
// An impulse makes a timing error visible as a number: two impulses in the
// output instead of one, at a known distance apart.
//
// Run:  pnpm --filter @aimaster/desktop test:stem-render

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import {
  renderStemSession, audibleTracks, balanceGains, chainLatency,
  type StemTrack,
} from '../src/main/offline/stem-render.js';

process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SR = 48_000;

/**
 * How far an impulse's peak may move, in samples.
 *
 * Latency in this engine comes from STFT modules, and a 2048-point STFT
 * redistributes an impulse across its window — that is what the module is
 * for. Demanding the peak land on the exact original sample would be
 * demanding the de-noiser not process anything. What alignment actually
 * claims is that the stems are not 2048 samples apart, so the tolerance is
 * set well below that (~5 ms) and the decisive assertion is the number of
 * impulses in the sum, not their exact index.
 */
const SMEAR = 256;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-stemrender-'));

/**
 * 32-bit float WAV.
 *
 * Float, not 24-bit int: these tests compare sample values against exact
 * expectations, and a 24-bit round trip would introduce a quantisation
 * error large enough to have to write a tolerance around, which would hide
 * exactly the small timing errors the file is looking for.
 */
function writeWav(name: string, left: Float32Array, right: Float32Array): string {
  const n = left.length;
  const bytes = n * 2 * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);          // IEEE float
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 4, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(left[i]!, o); o += 4;
    buf.writeFloatLE(right[i]!, o); o += 4;
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** A chain that does nothing but is still a chain. */
function flatCfg(): OfflineChainConfig {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0, eqAdaptive: false, eqBypass: true,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120, dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: true,
    limCeilingDbtp: 0, limLookaheadMs: 1, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false,
  };
}

/**
 * A chain with an STFT module engaged, so it reports real latency.
 *
 * De-noise is the cheapest way to get the 2048-sample FFT into the chain.
 * Its reduction is set low so it does not materially reshape the impulse —
 * this test is about WHERE the energy lands, not what it sounds like.
 */
function latentCfg(): OfflineChainConfig {
  return {
    ...flatCfg(),
    suiteConfig: {
      denoise: { reductionDb: 3, thresholdDb: 0, sharpness: 1, smoothing: 0.5, autoProfile: true, bypass: false },
    },
  } as OfflineChainConfig;
}

function impulseAt(n: number, index: number, amp = 0.5): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(n);
  l[index] = amp;
  return { left: l, right: l.slice() };
}

function dc(n: number, value: number): { left: Float32Array; right: Float32Array } {
  const l = new Float32Array(n).fill(value);
  return { left: l, right: l.slice() };
}

/** Index of the largest |sample|. */
function peakIndex(buf: Float32Array): number {
  let best = 0, bestV = -1;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

/**
 * Fraction of the buffer's energy that lies OUTSIDE a window.
 *
 * This is the measurement that actually tests alignment. Counting peaks does
 * not: a 2048-point STFT spreads one impulse over a couple of milliseconds,
 * so a correctly aligned pair still shows two local maxima ~120 samples
 * apart and a naive cluster count calls that a failure. A misaligned pair,
 * by contrast, puts a whole second copy of the impulse 2048 samples away —
 * which shows up here as energy far outside the window and nowhere else.
 */
function energyOutside(buf: Float32Array, centre: number, halfWidth: number): number {
  let inside = 0, outside = 0;
  for (let i = 0; i < buf.length; i++) {
    const e = buf[i]! * buf[i]!;
    if (Math.abs(i - centre) <= halfWidth) inside += e;
    else outside += e;
  }
  const total = inside + outside;
  return total > 0 ? outside / total : 0;
}

function track(filePath: string, over: Partial<StemTrack> = {}): StemTrack {
  return { filePath, gainDb: 0, pan: 0, mute: false, solo: false, config: null, ...over };
}

async function main(): Promise<void> {
  // ── 0. Pure helpers ───────────────────────────────────────────────────────
  console.log('\n=== MIXER LOGIC ===\n');

  {
    const t = [
      { mute: false, solo: false }, { mute: false, solo: true }, { mute: false, solo: false },
    ];
    check(
      'one solo silences everything else',
      JSON.stringify(audibleTracks(t)) === JSON.stringify([false, true, false]),
      JSON.stringify(audibleTracks(t)),
    );
  }
  {
    const t = [{ mute: false, solo: false }, { mute: true, solo: false }];
    check(
      'without a solo, only mutes are silent',
      JSON.stringify(audibleTracks(t)) === JSON.stringify([true, false]),
      JSON.stringify(audibleTracks(t)),
    );
  }
  {
    const t = [{ mute: true, solo: true }, { mute: false, solo: false }];
    check(
      'a muted solo is still muted, and does not solo the session',
      JSON.stringify(audibleTracks(t)) === JSON.stringify([false, true]),
      `${JSON.stringify(audibleTracks(t))} — 명시적인 뮤트가 남아 있는 솔로보다 강한 의사표시`,
    );
  }
  {
    const c = balanceGains(0), l = balanceGains(-1), r = balanceGains(1), h = balanceGains(0.5);
    check(
      'balance attenuates the far side and leaves the centre alone',
      c.l === 1 && c.r === 1 && l.l === 1 && l.r === 0 && r.l === 0 && r.r === 1 && h.l === 0.5 && h.r === 1,
      `가운데 ${c.l}/${c.r}, 왼쪽 끝 ${l.l}/${l.r}, 0.5 → ${h.l}/${h.r}`,
    );
    check(
      'a nonsense pan value does not produce a nonsense gain',
      balanceGains(NaN).l === 1 && balanceGains(9).r === 1 && balanceGains(9).l === 0,
      'NaN → 가운데, 범위를 벗어난 값 → 끝으로 고정',
    );
  }

  // ── 1. Latency reporting ──────────────────────────────────────────────────
  console.log('\n=== THE ENGINE REPORTS ITS OWN DELAY ===\n');

  const flatLat = chainLatency(flatCfg(), SR);
  const latentLat = chainLatency(latentCfg(), SR);

  check(
    'a neutral chain adds no latency',
    flatLat === 0,
    `${String(flatLat)} samples`,
  );
  check(
    'a chain with an STFT module does add latency',
    latentLat !== null && latentLat > 0,
    `${String(latentLat)} samples (${latentLat ? (latentLat / SR * 1000).toFixed(1) : '?'} ms) — 이 차이가 보정되지 않으면 합산에서 콤 필터가 생긴다`,
  );
  check(
    'no chain at all is zero, not unknown',
    chainLatency(null, SR) === 0,
    '0',
  );

  // ── 2. THE decisive test: two stems, different latencies ──────────────────
  console.log('\n=== ALIGNMENT ===\n');

  const N = SR * 2;
  const IMPULSE_AT = SR;   // 1 second in

  const aPath = writeWav('a.wav', ...Object.values(impulseAt(N, IMPULSE_AT)) as [Float32Array, Float32Array]);
  const bPath = writeWav('b.wav', ...Object.values(impulseAt(N, IMPULSE_AT)) as [Float32Array, Float32Array]);

  {
    // Same impulse, same position, but one stem runs through a chain that
    // delays by ~43 ms and the other through nothing at all.
    const res = await renderStemSession(
      [track(aPath, { config: null }), track(bPath, { config: latentCfg() })],
      { sampleRate: SR, master: null },
    );

    const stray = energyOutside(res.left, IMPULSE_AT, SMEAR);
    check(
      'two stems with different chain latencies land on top of each other',
      stray < 0.05,
      `창(±${SMEAR} 샘플) 밖 에너지 ${(stray * 100).toFixed(2)}% — ` +
      `보정이 없었다면 ${latentLat} 샘플 떨어진 곳에 두 번째 임펄스가 통째로 있어 절반 가까이가 밖에 있었을 것`,
    );

    check(
      'and it lands where the source put it',
      Math.abs(peakIndex(res.left) - IMPULSE_AT) <= SMEAR,
      `${peakIndex(res.left)} vs 원본 ${IMPULSE_AT} (허용 ±${SMEAR})`,
    );

    check(
      'the session reports what it aligned to',
      res.report.alignmentSamples === latentLat && res.report.latencyAvailable,
      `${res.report.alignmentSamples} samples`,
    );
  }

  {
    // The control: the SAME two stems, both without a chain, must also give
    // one impulse. If this failed the test above would prove nothing.
    const res = await renderStemSession(
      [track(aPath), track(bPath)],
      { sampleRate: SR, master: null },
    );
    check(
      'control — two identical stems with no chains put everything in the window',
      energyOutside(res.left, IMPULSE_AT, SMEAR) < 1e-9 && peakIndex(res.left) === IMPULSE_AT,
      `창 밖 에너지 0, 피크 @ ${peakIndex(res.left)}`,
    );
    check(
      'and summing two identical stems doubles the amplitude',
      Math.abs(res.left[peakIndex(res.left)]! - 1.0) < 0.02,
      `${res.left[peakIndex(res.left)]!.toFixed(4)} — 0.5 + 0.5, 위상이 맞을 때만 나오는 값`,
    );
  }

  // ── 3. The tail is not thrown away ────────────────────────────────────────
  console.log('\n=== THE TAIL ===\n');

  {
    // An impulse in the last 10 ms. A chain that delays by 43 ms and is fed
    // exactly `n` samples would push this past the end and lose it.
    const lateAt = N - 480;
    const latePath = writeWav('late.wav', ...Object.values(impulseAt(N, lateAt)) as [Float32Array, Float32Array]);
    const res = await renderStemSession(
      [track(latePath, { config: latentCfg() })],
      { sampleRate: SR, master: null },
    );
    check(
      'a hit in the last 10 ms survives a latent chain',
      Math.abs(peakIndex(res.left) - lateAt) <= SMEAR && Math.abs(res.left[peakIndex(res.left)]!) > 0.2,
      `피크 @ ${peakIndex(res.left)} (원본 ${lateAt}), 진폭 ${Math.abs(res.left[peakIndex(res.left)]!).toFixed(3)} — 체인 내부에 남은 꼬리를 밀어내지 않으면 사라진다`,
    );
  }

  // ── 4. The mixer does what a mixer does ───────────────────────────────────
  console.log('\n=== FADERS ===\n');

  const dcPath = writeWav('dc.wav', ...Object.values(dc(SR, 0.25)) as [Float32Array, Float32Array]);

  {
    const unity = await renderStemSession([track(dcPath)], { sampleRate: SR, master: null });
    const down = await renderStemSession([track(dcPath, { gainDb: -6 })], { sampleRate: SR, master: null });
    const mid = Math.floor(SR / 2);
    const ratio = down.left[mid]! / unity.left[mid]!;
    check(
      'the fader is a real gain, in dB',
      Math.abs(20 * Math.log10(ratio) + 6) < 0.1,
      `${(20 * Math.log10(ratio)).toFixed(2)} dB (설정: -6 dB)`,
    );
  }

  {
    const res = await renderStemSession([track(dcPath, { pan: -1 })], { sampleRate: SR, master: null });
    const mid = Math.floor(SR / 2);
    check(
      'hard left silences the right channel',
      Math.abs(res.left[mid]!) > 0.2 && Math.abs(res.right[mid]!) < 1e-6,
      `L ${res.left[mid]!.toFixed(3)}  R ${res.right[mid]!.toFixed(6)}`,
    );
  }

  {
    const res = await renderStemSession(
      [track(dcPath), track(dcPath, { mute: true })],
      { sampleRate: SR, master: null },
    );
    const mid = Math.floor(SR / 2);
    check(
      'a muted stem contributes nothing',
      Math.abs(res.left[mid]! - 0.25) < 1e-5 && res.report.rendered === 1,
      `${res.left[mid]!.toFixed(4)} — 뮤트가 안 됐다면 0.5`,
    );
  }

  {
    const res = await renderStemSession(
      [track(dcPath), track(dcPath, { solo: true })],
      { sampleRate: SR, master: null },
    );
    const mid = Math.floor(SR / 2);
    check(
      'a solo silences the rest',
      Math.abs(res.left[mid]! - 0.25) < 1e-5 && res.report.rendered === 1,
      `${res.left[mid]!.toFixed(4)}`,
    );
  }

  // ── 5. Length, reporting, failure ─────────────────────────────────────────
  console.log('\n=== SESSION ===\n');

  {
    const shortPath = writeWav('short.wav', ...Object.values(dc(SR / 2, 0.2)) as [Float32Array, Float32Array]);
    const res = await renderStemSession(
      [track(shortPath), track(dcPath)],
      { sampleRate: SR, master: null },
    );
    check(
      'the session is as long as its longest stem',
      Math.abs(res.report.samples - SR) <= 64,
      `${res.report.samples} samples (긴 쪽 ${SR}) — 짧은 스템이 세션을 자르지 않는다`,
    );
    const early = Math.floor(SR * 0.25);
    const late = Math.floor(SR * 0.75);
    check(
      'both stems sum while both are playing',
      Math.abs(res.left[early]! - 0.45) < 1e-5,
      `${res.left[early]!.toFixed(4)} — 0.2 + 0.25`,
    );
    check(
      'and a stem that has ended simply stops contributing',
      Math.abs(res.left[late]! - 0.25) < 1e-5,
      `${res.left[late]!.toFixed(4)} — 짧은 쪽(0.2)이 끝나고 긴 쪽(0.25)만 남는다`,
    );
  }

  {
    const res = await renderStemSession(
      [track(dcPath), track(dcPath), track(dcPath), track(dcPath), track(dcPath)],
      { sampleRate: SR, master: null },
    );
    check(
      'the pre-master sum peak is reported honestly',
      res.report.sumPeakDb > 1.5 && Math.abs(res.report.sumPeakDb - 20 * Math.log10(1.25)) < 0.1,
      `${res.report.sumPeakDb.toFixed(2)} dBFS — 0.25 × 5 = 1.25, 페이더가 잘못됐다는 걸 말해주는 숫자`,
    );
  }

  {
    let threw = '';
    try {
      await renderStemSession([track(dcPath, { mute: true })], { sampleRate: SR, master: null });
    } catch (e) { threw = (e as Error).message; }
    check(
      'a session with nothing audible fails loudly instead of writing silence',
      threw.includes('들리는 스템이 없습니다'),
      threw || '예외 없음',
    );
  }

  {
    let threw = '';
    try {
      await renderStemSession([], { sampleRate: SR, master: null });
    } catch (e) { threw = (e as Error).message; }
    check(
      'an empty session fails too',
      threw.includes('스템이 없습니다'),
      threw || '예외 없음',
    );
  }

  {
    const res = await renderStemSession(
      [track(dcPath), track(path.join(dir, 'does-not-exist.wav'))],
      { sampleRate: SR, master: null },
    );
    check(
      'one unreadable stem does not lose the whole render',
      res.report.rendered === 1 && res.report.samples > 0,
      `${res.report.rendered}개 렌더 — 읽을 수 있는 것은 살린다`,
    );
  }

  // ── 6. The master bus runs on the sum ─────────────────────────────────────
  console.log('\n=== MASTER BUS ===\n');

  {
    const withMaster = await renderStemSession(
      [track(dcPath), track(dcPath), track(dcPath), track(dcPath), track(dcPath)],
      {
        sampleRate: SR,
        master: { ...flatCfg(), limBypass: false, limCeilingDbtp: -1.0 },
      },
    );
    check(
      'the master limiter catches a sum that clips',
      withMaster.report.sumPeakDb > 0 && withMaster.report.outputPeakDb <= 0,
      `합산 ${withMaster.report.sumPeakDb.toFixed(2)} dBFS → 출력 ${withMaster.report.outputPeakDb.toFixed(2)} dBFS`,
    );
  }

  {
    // The master's own latency must be removed too, or every export starts
    // 43 ms late.
    const res = await renderStemSession(
      [track(aPath)],
      { sampleRate: SR, master: latentCfg() },
    );
    check(
      'the master chain does not shift the finished file in time',
      Math.abs(peakIndex(res.left) - IMPULSE_AT) <= SMEAR,
      `피크 @ ${peakIndex(res.left)} (원본 ${IMPULSE_AT})`,
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
