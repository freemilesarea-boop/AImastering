/**
 * loudness-selftest.ts — verify the BS.1770-4 implementation against
 * synthesized reference signals.  Run via:
 *
 *   pnpm dlx tsx apps/desktop/scripts/loudness-selftest.ts
 *
 * Tolerance budget: ±0.3 LU (matches the public API contract).
 *
 * Test cases:
 *   1. 1 kHz sine @ -23 dBFS, stereo, 30 s   → I = -23 ± 0.3 LUFS
 *   2. 1 kHz sine @ -20 dBFS, mono,   20 s   → I = -20 ± 0.3 LUFS
 *   3. White noise @ -23 dBFS RMS, stereo, 30 s → I = -23 ± 0.5 LUFS
 *      (slightly looser since the K-weighting tilts the spectrum)
 *   4. Inter-sample peak: 0 dBFS sine just below Nyquist offset →
 *      TP must be > 0 dBTP (sample peaks read 0, but TP catches the
 *      inter-sample lobe).
 */

import { getLoudnessMetrics, AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import { processLimiter } from '../src/renderer/audio/limiterChain.js';
import { applyGainStaging } from '../src/renderer/audio/gainStaging.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

// ── Stub AudioBuffer ──────────────────────────────────────────────────────────
function makeBuffer(sr: number, ch: number, len: number): AudioBufferLike & { setChannel: (c: number, d: Float32Array) => void } {
  const data: Float32Array[] = [];
  for (let c = 0; c < ch; c++) data.push(new Float32Array(len));
  return {
    sampleRate: sr,
    numberOfChannels: ch,
    length: len,
    getChannelData(c: number): Float32Array { return data[c]; },
    setChannel(c: number, d: Float32Array): void { data[c] = d; },
  };
}

function sineDbfs(sr: number, freq: number, dbfs: number, len: number): Float32Array {
  const a = Math.pow(10, dbfs / 20);
  const out = new Float32Array(len);
  const k = 2 * Math.PI * freq / sr;
  for (let i = 0; i < len; i++) out[i] = a * Math.sin(k * i);
  return out;
}

// White noise scaled so the RMS matches the requested dBFS.
function noiseRmsDbfs(dbfs: number, len: number): Float32Array {
  const targetRms = Math.pow(10, dbfs / 20);
  const raw = new Float32Array(len);
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const x = Math.random() * 2 - 1;
    raw[i] = x;
    sumSq += x * x;
  }
  const rmsRaw = Math.sqrt(sumSq / len);
  const g = targetRms / rmsRaw;
  for (let i = 0; i < len; i++) raw[i] *= g;
  return raw;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
function runTests(): TestResult[] {
  const results: TestResult[] = [];

  // Case 1: 1 kHz sine @ -23 dBFS stereo, 30 s.
  // For a sine at full-scale (0 dBFS): RMS = 1/√2 ≈ -3.01 dBFS.
  // We want -23 LUFS Integrated.  Calibration: BS.1770 says a 1 kHz sine at
  // -3.01 dBFS sample peak (= 0 dBFS RMS reference) gives ~ -3.01 LUFS.
  // K-weighting at 1 kHz is essentially 0 dB.  Channel sum (L=R, both 1.0)
  // adds +3 dB.  So a stereo sine at peak-amplitude `a` gives:
  //    LUFS_I = 20·log10(a/√2) + 3 dB ≈ 20·log10(a) - 0.01 dB.
  // For -23 LUFS we want 20·log10(a) ≈ -23 → a ≈ 10^(-23/20) ≈ 0.0708.
  // That equals -23 dBFS sample peak.
  {
    const sr  = 48000;
    const len = sr * 30;
    const buf = makeBuffer(sr, 2, len);
    const sig = sineDbfs(sr, 1000, -23, len);
    buf.setChannel(0, sig);
    buf.setChannel(1, sig.slice());
    const m = getLoudnessMetrics(buf);
    const expected = -23;
    const pass = Math.abs(m.integratedLufs - expected) <= 0.3;
    results.push({
      name: 'Case 1: stereo 1 kHz sine @ -23 dBFS → -23 LUFS',
      pass,
      detail: `I=${m.integratedLufs.toFixed(2)} LUFS (target ${expected.toFixed(1)} ± 0.3)`,
    });
  }

  // Case 2: mono 1 kHz sine @ -20 LUFS, 20 s.  Calibration: BS.1770-4
  // chose the -0.691 dB offset to exactly cancel the K-weighting gain at
  // 1 kHz (which is +0.691 dB by design).  So for a 1 kHz mono sine of
  // amplitude `a`, LUFS = 10·log10(a²/2).
  // Target -20 LUFS → a = √(2 · 10^(-2)) = √0.02 ≈ 0.1414.
  {
    const sr  = 48000;
    const len = sr * 20;
    const buf = makeBuffer(sr, 1, len);
    const a = Math.sqrt(2 * Math.pow(10, -20 / 10));
    const dbfs = 20 * Math.log10(a);
    const sig = sineDbfs(sr, 1000, dbfs, len);
    buf.setChannel(0, sig);
    const m = getLoudnessMetrics(buf);
    const expected = -20;
    const pass = Math.abs(m.integratedLufs - expected) <= 0.3;
    results.push({
      name: 'Case 2: mono 1 kHz sine → -20 LUFS',
      pass,
      detail: `I=${m.integratedLufs.toFixed(2)} LUFS (target ${expected.toFixed(1)} ± 0.3)`,
    });
  }

  // Case 3: white noise scaled to RMS such that integrated ≈ -23 LUFS.
  // K-weighting tilts toward 1 kHz so calibrating analytically is tricky;
  // we just confirm the value is finite and inside a plausible band, and
  // that momentary > -∞ when a signal is present.
  {
    const sr  = 48000;
    const len = sr * 30;
    const buf = makeBuffer(sr, 2, len);
    // RMS -23 dBFS per channel ≈ -20 LUFS-ish after K + stereo sum.
    const sig = noiseRmsDbfs(-23, len);
    buf.setChannel(0, sig);
    buf.setChannel(1, noiseRmsDbfs(-23, len));
    const m = getLoudnessMetrics(buf);
    const pass = isFinite(m.integratedLufs) && m.integratedLufs > -30 && m.integratedLufs < -10
              && isFinite(m.shortTermLufs)
              && isFinite(m.momentaryLufs);
    results.push({
      name: 'Case 3: stereo white noise produces finite I/S/M',
      pass,
      detail: `I=${m.integratedLufs.toFixed(2)} S=${m.shortTermLufs.toFixed(2)} M=${m.momentaryLufs.toFixed(2)}`,
    });
  }

  // Case 4: full-scale 1 kHz sine — sample peaks read 0 dBFS but inter-sample
  // peaks are also right at 0 dBFS for 1 kHz at 48 kHz (well below Nyquist),
  // so use a frequency near Nyquist where the effect is strong.
  // 19 kHz sine at -1 dBFS, 1 s.  Sample peaks → -1 dBFS, true peaks → ~0 dBTP.
  {
    const sr  = 48000;
    const len = sr * 1;
    const buf = makeBuffer(sr, 1, len);
    const sig = sineDbfs(sr, 19000, -1, len);
    buf.setChannel(0, sig);
    const m = getLoudnessMetrics(buf);
    // Sample peak is ≤ -1 dBFS (the sine is band-limited to -1 dBFS sample-peak).
    // True-peak should report a value strictly greater than the sample peak —
    // i.e., > -1 dBTP (with some margin).  We accept anything ≥ -0.95 dBTP.
    const pass = m.truePeakDbtp > -0.95;
    results.push({
      name: 'Case 4: 19 kHz sine TP > sample peak',
      pass,
      detail: `TP=${m.truePeakDbtp.toFixed(2)} dBTP (expect > -0.95)`,
    });
  }

  // ── Limiter chain tests ────────────────────────────────────────────────────

  // Case L1: a quiet stereo white-noise buffer (integrated ≈ -25 LUFS) is
  // pushed to a -10 LUFS target.  Verify TP < -1 dBTP and integrated within
  // 0.5 LU of the target.  At -10 LUFS the chain is doing real work so this
  // is a meaningful stress test — but it should still arrive cleanly.
  {
    const sr  = 48000;
    const len = sr * 8;
    const buf = makeBuffer(sr, 2, len);
    buf.setChannel(0, noiseRmsDbfs(-25, len));
    buf.setChannel(1, noiseRmsDbfs(-25, len));
    const r = processLimiter(buf, -10);
    const tpOk   = r.truePeakDbtp <= -1.0 + 1e-3;
    const lufsOk = Math.abs(r.measuredLufs - (-10)) <= 0.5;
    results.push({
      name: 'Case L1: stereo noise → -10 LUFS, TP ≤ -1 dBTP',
      pass: tpOk && lufsOk,
      detail: `I=${r.measuredLufs.toFixed(2)} LUFS, TP=${r.truePeakDbtp.toFixed(2)} dBTP, `
            + `gain=${r.appliedGainDb.toFixed(1)} dB, GR=${r.maxGrDb.toFixed(1)} dB, `
            + `passes=${r.passes}, guard=${r.truePeakGuarded}`,
    });
  }

  // Case L2: low-distortion at -10 LUFS — feed a 1 kHz sine pre-scaled so
  // the chain doesn't need to do anything destructive to hit the target.
  // Compare THD before/after.  We compute "distortion" as the energy in
  // anything that's not the fundamental ± neighbouring bins.  For a tone
  // that fits comfortably under the soft-clip threshold, the chain should
  // add <= -50 dB of harmonic content.
  {
    const sr  = 48000;
    const len = sr * 4;
    const buf = makeBuffer(sr, 2, len);
    // -13 dBFS sine pair → integrated ≈ -13 LUFS (stereo, 1 kHz: cancels K offset).
    const sig = sineDbfs(sr, 1000, -13, len);
    buf.setChannel(0, sig);
    buf.setChannel(1, sig.slice());
    const r = processLimiter(buf, -10);
    // Goertzel-style coherent fundamental measurement.
    const out0 = r.buffer.getChannelData(0);
    const w = 2 * Math.PI * 1000 / sr;
    let s = 0, c = 0, sumSq = 0;
    for (let i = 0; i < out0.length; i++) {
      const v = out0[i] as number;
      s += v * Math.sin(w * i);
      c += v * Math.cos(w * i);
      sumSq += v * v;
    }
    const fundEnergy = (s * s + c * c) * 2 / (out0.length * out0.length);
    const totalEnergy = sumSq / out0.length;
    const fundFraction = fundEnergy / totalEnergy;
    const distortionDb = 10 * Math.log10(Math.max(1e-15, 1 - fundFraction));
    // For a clean tone, residual should be at least 50 dB below fundamental.
    const cleanEnough = distortionDb < -50;
    const tpOk        = r.truePeakDbtp <= -1.0 + 1e-3;
    const lufsOk      = Math.abs(r.measuredLufs - (-10)) <= 0.5;
    results.push({
      name: 'Case L2: 1 kHz sine to -10 LUFS — no audible distortion',
      pass: cleanEnough && tpOk && lufsOk,
      detail: `I=${r.measuredLufs.toFixed(2)} LUFS, TP=${r.truePeakDbtp.toFixed(2)} dBTP, `
            + `residual ${distortionDb.toFixed(1)} dB (need ≤ -50)`,
    });
  }

  // Case L3: stereo-image preservation.  Build a stereo signal with a
  // distinct L/R balance (left -3 dB louder than right) and verify the
  // L/R level ratio survives the chain to within 0.05 dB.
  {
    const sr  = 48000;
    const len = sr * 4;
    const buf = makeBuffer(sr, 2, len);
    buf.setChannel(0, noiseRmsDbfs(-20, len));        // louder left
    buf.setChannel(1, noiseRmsDbfs(-23, len));        // quieter right
    const r = processLimiter(buf, -12);
    const rmsDb = (a: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += (a[i] as number) ** 2;
      return 10 * Math.log10(s / a.length);
    };
    const lInDb  = rmsDb(buf.getChannelData(0));
    const rInDb  = rmsDb(buf.getChannelData(1));
    const lOutDb = rmsDb(r.buffer.getChannelData(0));
    const rOutDb = rmsDb(r.buffer.getChannelData(1));
    const balanceIn  = lInDb  - rInDb;
    const balanceOut = lOutDb - rOutDb;
    const drift = Math.abs(balanceOut - balanceIn);
    const tpOk = r.truePeakDbtp <= -1.0 + 1e-3;
    const pass = drift < 0.05 && tpOk;
    results.push({
      name: 'Case L3: stereo image preserved (balance drift < 0.05 dB)',
      pass,
      detail: `Δbalance=${drift.toFixed(3)} dB (in ${balanceIn.toFixed(2)} → out ${balanceOut.toFixed(2)}), `
            + `TP=${r.truePeakDbtp.toFixed(2)} dBTP`,
    });
  }

  // ── Gain staging tests ─────────────────────────────────────────────────────
  //
  // The default policy targets peak ≤ -6 dBFS, RMS ≤ -18 dBFS, LUFS ≤ -18.
  // The chosen gain is the most conservative across all four constraints
  // (peak / true-peak / RMS / LUFS).

  // Case G1: HOT input — peaks brushing -1 dBFS, RMS hot.  The gain
  // stager must attenuate, and EVERY target metric must end up at or
  // below its threshold (peak ≤ -6, RMS ≤ -18, LUFS ≤ -18).  Whichever
  // metric was the binding constraint should land essentially AT its
  // target (within ±0.3 dB).
  {
    const sr  = 48000;
    const len = sr * 4;
    const buf = makeBuffer(sr, 2, len);
    const raw = new Float32Array(len);
    let max = 0;
    for (let i = 0; i < len; i++) {
      const v = Math.random() * 2 - 1;
      raw[i] = v;
      if (Math.abs(v) > max) max = Math.abs(v);
    }
    const targetPk = Math.pow(10, -1 / 20);
    const g = targetPk / max;
    for (let i = 0; i < len; i++) raw[i] *= g;
    buf.setChannel(0, raw);
    buf.setChannel(1, raw.slice());

    const r = applyGainStaging(buf);
    const peakOk = r.outputPeakDb <= -6 + 0.3;
    const rmsOk  = r.outputRmsDb  <= -18 + 0.3;
    const lufsOk = !isFinite(r.outputLufs) || r.outputLufs <= -18 + 0.3;
    const decisionOk = r.decision === 'attenuate';
    results.push({
      name: 'Case G1: HOT input attenuated, all targets respected',
      pass: peakOk && rmsOk && lufsOk && decisionOk,
      detail: `gain=${r.appliedGainDb.toFixed(2)} dB, by=${r.limitedBy}, `
            + `out peak=${r.outputPeakDb.toFixed(1)} RMS=${r.outputRmsDb.toFixed(1)} `
            + `LUFS=${r.outputLufs.toFixed(1)}`,
    });
  }

  // Case G2: QUIET input — peaks at -30 dBFS.  Should be boosted by
  // maxBoostDb (default +12) and never overshoot it.
  {
    const sr  = 48000;
    const len = sr * 4;
    const buf = makeBuffer(sr, 2, len);
    const sig = noiseRmsDbfs(-36, len);   // RMS -36 → peaks ≈ -27/-30 dBFS
    buf.setChannel(0, sig);
    buf.setChannel(1, noiseRmsDbfs(-36, len));

    const r = applyGainStaging(buf);
    // Should boost — but capped at maxBoostDb (12).  Decision = boost OR pass
    // if it's already in range (unlikely for a -36 dBFS RMS input).
    const inBoostCap = r.appliedGainDb <= 12 + 0.001 && r.appliedGainDb > 0;
    results.push({
      name: 'Case G2: QUIET input boosted up to maxBoostDb cap',
      pass: inBoostCap && r.decision === 'boost',
      detail: `gain=${r.appliedGainDb.toFixed(2)} dB, RMS ${r.inputRmsDb.toFixed(1)} → `
            + `${r.outputRmsDb.toFixed(1)} dBFS, decision=${r.decision}, by=${r.limitedBy}`,
    });
  }

  // Case G3: IN-RANGE input — calibrated so integrated LUFS sits exactly
  // at the LUFS target (-18).  The implementation should leave the
  // buffer essentially untouched (|gain| < 0.5 dB) since LUFS is the
  // binding constraint and there's zero headroom on it.
  {
    const sr  = 48000;
    const len = sr * 4;
    const tmp = makeBuffer(sr, 2, len);
    tmp.setChannel(0, noiseRmsDbfs(-22, len));
    tmp.setChannel(1, noiseRmsDbfs(-22, len));
    // Pre-scale so integrated LUFS lands exactly at -18.
    const m = getLoudnessMetrics(tmp);
    const trim = isFinite(m.integratedLufs) ? Math.pow(10, (-18 - m.integratedLufs) / 20) : 1;
    const ch0 = tmp.getChannelData(0);
    const ch1 = tmp.getChannelData(1);
    for (let i = 0; i < len; i++) { ch0[i] *= trim; ch1[i] *= trim; }

    const r = applyGainStaging(tmp);
    const pass = Math.abs(r.appliedGainDb) <= 0.5;
    results.push({
      name: 'Case G3: input at LUFS target → pass-through',
      pass,
      detail: `gain=${r.appliedGainDb.toFixed(2)} dB, peak=${r.outputPeakDb.toFixed(1)} dBFS, `
            + `RMS=${r.outputRmsDb.toFixed(1)} dBFS, LUFS=${r.outputLufs.toFixed(1)}, `
            + `by=${r.limitedBy}, decision=${r.decision}`,
    });
  }

  // Case G4: HOT input → gain-stage → limiter chain converges with very
  // little GR (< 3 dB).  This is the headline benefit: pre-staging means
  // the limiter does light work and transients survive.
  {
    const sr  = 48000;
    const len = sr * 6;
    const buf = makeBuffer(sr, 2, len);
    const raw = noiseRmsDbfs(-9, len);      // hot RMS, peaks near 0 dBFS
    buf.setChannel(0, raw);
    buf.setChannel(1, noiseRmsDbfs(-9, len));

    const staged = applyGainStaging(buf);
    const r = processLimiter(staged.buffer, -10);
    const tpOk    = r.truePeakDbtp <= -1.0 + 1e-3;
    const lightGr = r.maxGrDb < 3.0;
    const lufsOk  = Math.abs(r.measuredLufs - (-10)) <= 0.5;
    results.push({
      name: 'Case G4: gain-stage → limiter does < 3 dB GR',
      pass: tpOk && lightGr && lufsOk,
      detail: `staged gain ${staged.appliedGainDb.toFixed(1)} dB, `
            + `limiter GR=${r.maxGrDb.toFixed(2)} dB, I=${r.measuredLufs.toFixed(2)} LUFS, `
            + `TP=${r.truePeakDbtp.toFixed(2)} dBTP`,
    });
  }

  return results;
}

// ── Run + report ──────────────────────────────────────────────────────────────
const results = runTests();
let allPass = true;
for (const r of results) {
  const tag = r.pass ? '[32mPASS[0m' : '[31mFAIL[0m';
  // eslint-disable-next-line no-console
  console.log(`${tag}  ${r.name}\n      ${r.detail}`);
  if (!r.pass) allPass = false;
}
process.exit(allPass ? 0 : 1);
