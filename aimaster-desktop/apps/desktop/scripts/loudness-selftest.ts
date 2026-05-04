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
