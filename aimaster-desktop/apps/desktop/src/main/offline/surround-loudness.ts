// surround-loudness — BS.1770 integrated loudness for multichannel programs.
//
// Gives the multichannel output path its own loudness auto-match (previously
// only the stereo fold-down had real loudnorm).  Implements the ITU-R BS.1770-4
// measurement: K-weighting (2 biquads, coefficients derived for the actual
// sample rate) → channel-weighted (front 0 dB, surround +1.5 dB, LFE excluded)
// 400 ms mean-square blocks → absolute (−70 LUFS) + relative (−10 LU) gating.
//
// Pure (no I/O); fully headless-testable.

import type { SurroundLayout } from '@aimaster/shared-types';
import { LAYOUT_CHANNELS, bs1770Weight } from './surround.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; }

/** K-weighting coefficients for an arbitrary sample rate (pyloudnorm method). */
function kWeighting(fs: number): { shelf: Biquad; hp: Biquad } {
  // Stage 1 — high-shelf.
  const f0 = 1681.9744509555319;
  const G = 3.99984385397;
  const Q1 = 0.7071752369554193;
  const K1 = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0s = 1 + K1 / Q1 + K1 * K1;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K1) / Q1 + K1 * K1) / a0s,
    b1: (2 * (K1 * K1 - Vh)) / a0s,
    b2: (Vh - (Vb * K1) / Q1 + K1 * K1) / a0s,
    a1: (2 * (K1 * K1 - 1)) / a0s,
    a2: (1 - K1 / Q1 + K1 * K1) / a0s,
  };
  // Stage 2 — high-pass.
  const f0h = 38.13547087602444;
  const Qh = 0.5003270373238773;
  const Kh = Math.tan((Math.PI * f0h) / fs);
  const a0h = 1 + Kh / Qh + Kh * Kh;
  const hp: Biquad = {
    b0: 1, b1: -2, b2: 1,
    a1: (2 * (Kh * Kh - 1)) / a0h,
    a2: (1 - Kh / Qh + Kh * Kh) / a0h,
  };
  return { shelf, hp };
}

function applyBiquad(x: Float32Array, c: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

const blockLoudness = (z: number): number => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);

/**
 * Integrated loudness (LUFS) of a multichannel program per BS.1770-4.  Returns
 * −Infinity for silence / fully-gated input.
 */
export function integratedLoudnessLufs(channels: Float32Array[], layout: SurroundLayout, sampleRate: number): number {
  const roles = LAYOUT_CHANNELS[layout];
  const { shelf, hp } = kWeighting(sampleRate);
  const filtered = channels.map((ch) => applyBiquad(applyBiquad(ch, shelf), hp));

  const blockLen = Math.max(1, Math.round(0.4 * sampleRate));
  const hopLen = Math.max(1, Math.round(0.1 * sampleRate)); // 75% overlap
  const n = filtered[0]?.length ?? 0;
  if (n < blockLen) return -Infinity;

  // z per 400 ms block = Σ_ch weight · mean-square.
  const zBlocks: number[] = [];
  for (let start = 0; start + blockLen <= n; start += hopLen) {
    let z = 0;
    for (let c = 0; c < roles.length; c++) {
      const w = bs1770Weight(roles[c]!);
      const f = filtered[c];
      if (!w || !f) continue;
      let ms = 0;
      for (let i = start; i < start + blockLen; i++) ms += f[i]! * f[i]!;
      z += w * (ms / blockLen);
    }
    zBlocks.push(z);
  }
  if (zBlocks.length === 0) return -Infinity;

  // Absolute gate at −70 LUFS.
  const absKept = zBlocks.filter((z) => blockLoudness(z) > -70);
  if (absKept.length === 0) return -Infinity;

  // Relative gate at (mean − 10 LU).
  const meanAbs = absKept.reduce((s, z) => s + z, 0) / absKept.length;
  const relThresh = blockLoudness(meanAbs) - 10;
  const relKept = absKept.filter((z) => blockLoudness(z) > relThresh);
  const kept = relKept.length > 0 ? relKept : absKept;
  const meanZ = kept.reduce((s, z) => s + z, 0) / kept.length;
  return blockLoudness(meanZ);
}

/** Gain (dB) to move `measuredLufs` to `targetLufs`, clamped.  0 if not finite. */
export function loudnessNormGainDb(
  measuredLufs: number,
  targetLufs: number,
  maxBoostDb = 12,
  maxCutDb = 24,
): number {
  if (!Number.isFinite(measuredLufs)) return 0;
  return clamp(targetLufs - measuredLufs, -maxCutDb, maxBoostDb);
}
