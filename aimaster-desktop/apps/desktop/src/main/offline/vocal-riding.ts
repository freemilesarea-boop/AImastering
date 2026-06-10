// vocal-riding — automatic vocal level riding for the offline render (P2).
//
// The vocal in a stereo master sits mostly in the CENTRE (mid).  This rides the
// centre's vocal-band level toward a track-wide reference so the vocal stays
// consistent (quiet lines come up, loud lines come down) within a limited dB
// range, smoothly.  Applied via M/S so the sides (panned instruments / reverb)
// are untouched, BEFORE the mastering chain.
//
// Honest scope: this is a centre-band level rider driven by an envelope
// detector — not a separated-vocal processor (that is the gated ONNX tier).  It
// is deterministic and fully headless-testable (envelope, gain curve, M/S).
//
// Pure (no I/O).

import type { VocalRidingPlan } from '@aimaster/shared-types';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const db2lin = (db: number): number => Math.pow(10, db / 20);
const lin2db = (lin: number): number => 20 * Math.log10(Math.max(1e-9, lin));

export const VOCAL_RIDING_RANGES = {
  amount: { min: 0, max: 1 },
  boostCutDb: { min: 0, max: 12 },
  responseMs: { min: 50, max: 1000 },
} as const;

// Presence band the vocal detector focuses on.
const PRESENCE_LO_HZ = 200;
const PRESENCE_HI_HZ = 5000;
const ENV_SMOOTH_MS = 30;

export function isVocalRidingUnity(plan: VocalRidingPlan | undefined | null): boolean {
  return !plan || !plan.enabled || plan.amount <= 0;
}

export function sanitizeVocalRiding(plan: VocalRidingPlan): VocalRidingPlan {
  const n = (v: number, fb: number): number => (Number.isFinite(v) ? v : fb);
  return {
    enabled: !!plan.enabled,
    amount: clamp(n(plan.amount, 0), VOCAL_RIDING_RANGES.amount.min, VOCAL_RIDING_RANGES.amount.max),
    maxBoostDb: clamp(n(plan.maxBoostDb, 6), VOCAL_RIDING_RANGES.boostCutDb.min, VOCAL_RIDING_RANGES.boostCutDb.max),
    maxCutDb: clamp(n(plan.maxCutDb, 6), VOCAL_RIDING_RANGES.boostCutDb.min, VOCAL_RIDING_RANGES.boostCutDb.max),
    responseMs: clamp(n(plan.responseMs, 300), VOCAL_RIDING_RANGES.responseMs.min, VOCAL_RIDING_RANGES.responseMs.max),
  };
}

/** One-pole low-pass running over a signal (a = 1 − e^(−2π fc/sr)). */
function onePoleLowpass(x: Float32Array, fc: number, sampleRate: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i]! - y); out[i] = y; }
  return out;
}

/**
 * Smoothed level envelope of the centre's presence band (a crude band-pass:
 * LP(hi) − LP(lo), rectified, smoothed).  Higher for in-band (vocal) energy
 * than for sub-bass or air.  Linear amplitude.
 */
export function vocalBandEnvelope(mid: Float32Array, sampleRate: number): Float32Array {
  const lo = onePoleLowpass(mid, PRESENCE_LO_HZ, sampleRate);
  const hi = onePoleLowpass(mid, PRESENCE_HI_HZ, sampleRate);
  const rect = new Float32Array(mid.length);
  for (let i = 0; i < mid.length; i++) rect[i] = Math.abs(hi[i]! - lo[i]!);
  return onePoleLowpass(rect, 1000 / ENV_SMOOTH_MS, sampleRate);
}

/** Median of a sampled copy of an envelope (the riding reference level). */
function referenceLevel(env: Float32Array): number {
  // Subsample for speed; ignore near-silence so the reference reflects content.
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(env.length / 4096));
  for (let i = 0; i < env.length; i += step) if (env[i]! > 1e-4) vals.push(env[i]!);
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]!;
}

/**
 * Per-sample LINEAR riding gain for the centre: pushes the envelope toward the
 * track reference, scaled by `amount`, clamped to [−maxCut, +maxBoost] dB, then
 * smoothed (responseMs one-pole).  Near-silent regions ride toward unity so we
 * don't boost noise.
 */
export function computeRidingGain(env: Float32Array, sampleRate: number, plan: VocalRidingPlan): Float32Array {
  const p = sanitizeVocalRiding(plan);
  const refDb = lin2db(referenceLevel(env));
  const targetDbRaw = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    if (env[i]! <= 1e-4) { targetDbRaw[i] = 0; continue; } // silence → no ride
    const errDb = refDb - lin2db(env[i]!);            // +ve when too quiet
    targetDbRaw[i] = p.amount * clamp(errDb, -p.maxCutDb, p.maxBoostDb);
  }
  // Smooth the gain (in dB) with a one-pole at responseMs, then to linear.
  const smoothDb = onePoleLowpass(targetDbRaw, 1000 / p.responseMs, sampleRate);
  const gain = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) gain[i] = db2lin(smoothDb[i]!);
  return gain;
}

/**
 * Apply vocal riding to a stereo buffer (M/S, centre only).  No-op (applied
 * false) when disabled or amount 0.  The sides are preserved exactly:
 * L'−R' = 2S = L−R.  Pure.
 */
export function applyVocalRiding(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  plan: VocalRidingPlan,
): { left: Float32Array; right: Float32Array; applied: boolean } {
  const p = sanitizeVocalRiding(plan);
  if (isVocalRidingUnity(p)) return { left, right, applied: false };

  const n = Math.min(left.length, right.length);
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) { mid[i] = 0.5 * (left[i]! + right[i]!); side[i] = 0.5 * (left[i]! - right[i]!); }

  const gain = computeRidingGain(vocalBandEnvelope(mid, sampleRate), sampleRate, p);

  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = mid[i]! * gain[i]!;
    outL[i] = m + side[i]!;
    outR[i] = m - side[i]!;
  }
  return { left: outL, right: outR, applied: true };
}
