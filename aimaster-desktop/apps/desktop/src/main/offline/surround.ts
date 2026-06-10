// surround — channel-based surround (5.1 / 7.1) fold-down + loudness (Phase 4).
//
// The mastering chain is stereo.  To master a surround source we fold it down to
// stereo with the standard ITU-R BS.775 coefficients (with user trims), master
// the fold-down, and report BS.1770 channel-weighted surround loudness.  This is
// channel-based surround — object-based Atmos authoring (ADM BWF / Dolby
// encoders / binaural) is a further step and explicitly out of scope here.
//
// Pure (no I/O); fold-down + loudness math are fully headless-testable.

import type { SurroundLayout, SurroundTrims } from '@aimaster/shared-types';

const db2lin = (db: number): number => Math.pow(10, db / 20);
const M3DB = Math.SQRT1_2; // −3 dB ≈ 0.7071

/** Channel roles in FFmpeg's default channel order for each layout. */
export type ChannelRole = 'FL' | 'FR' | 'FC' | 'LFE' | 'BL' | 'BR' | 'SL' | 'SR';

export const LAYOUT_CHANNELS: Record<SurroundLayout, ChannelRole[]> = {
  stereo: ['FL', 'FR'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
};

/**
 * Group a layout's channels into processing units for the per-bed full chain:
 * L/R surround pairs run as stereo, the centre as mono, LFE passes through
 * untouched (band-limited — no tone/dynamics shaping).
 */
export interface ProcessingUnit { kind: 'stereo' | 'mono' | 'lfe'; indices: number[] }

export function surroundProcessingUnits(layout: SurroundLayout): ProcessingUnit[] {
  const roles = LAYOUT_CHANNELS[layout];
  const idx = (r: ChannelRole): number => roles.indexOf(r);
  const units: ProcessingUnit[] = [];
  const pair = (l: ChannelRole, r: ChannelRole): void => {
    const li = idx(l), ri = idx(r);
    if (li >= 0 && ri >= 0) units.push({ kind: 'stereo', indices: [li, ri] });
  };
  pair('FL', 'FR');
  if (idx('FC') >= 0) units.push({ kind: 'mono', indices: [idx('FC')] });
  if (idx('LFE') >= 0) units.push({ kind: 'lfe', indices: [idx('LFE')] });
  pair('BL', 'BR');
  pair('SL', 'SR');
  return units;
}

/**
 * FFmpeg canonical channel-layout name for a layout.  These match FFmpeg's
 * `-layouts` exactly (5.1 = FL+FR+FC+LFE+BL+BR, 7.1 = …+SL+SR), so passing this
 * on encode writes the correct WAVE_FORMAT_EXTENSIBLE channel mask.
 */
export function ffmpegLayoutName(layout: SurroundLayout): string {
  switch (layout) {
    case '5.1': return '5.1';
    case '7.1': return '7.1';
    default: return 'stereo';
  }
}

/** Detect a known layout from a raw channel count (else null). */
export function layoutForChannelCount(n: number): SurroundLayout | null {
  if (n === 2) return 'stereo';
  if (n === 6) return '5.1';
  if (n === 8) return '7.1';
  return null;
}

export const DEFAULT_SURROUND_TRIMS: SurroundTrims = { centerDb: 0, surroundDb: 0, lfeDb: -120 };

export function sanitizeSurroundTrims(t: SurroundTrims | undefined | null): SurroundTrims {
  const clamp = (v: number, lo: number, hi: number, fb: number) => {
    const x = Number.isFinite(v) ? v : fb;
    return Math.min(hi, Math.max(lo, x));
  };
  return {
    centerDb: clamp(t?.centerDb ?? 0, -12, 12, 0),
    surroundDb: clamp(t?.surroundDb ?? 0, -12, 12, 0),
    // −120 dB ≈ LFE excluded (the conventional default for a stereo fold-down).
    lfeDb: clamp(t?.lfeDb ?? -120, -120, 12, -120),
  };
}

/** Split an interleaved N-channel buffer into N de-interleaved channels. */
export function deinterleaveN(interleaved: Float32Array, channels: number): Float32Array[] {
  if (channels <= 0) return [];
  const frames = Math.floor(interleaved.length / channels);
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const base = f * channels;
    for (let c = 0; c < channels; c++) out[c]![f] = interleaved[base + c]!;
  }
  return out;
}

/** Per-role contribution to the L and R fold-down buses (before trims). */
function foldCoefficients(role: ChannelRole, t: SurroundTrims): { l: number; r: number } {
  const c = db2lin(t.centerDb);
  const s = db2lin(t.surroundDb);
  const lfe = db2lin(t.lfeDb);
  switch (role) {
    case 'FL': return { l: 1, r: 0 };
    case 'FR': return { l: 0, r: 1 };
    case 'FC': return { l: M3DB * c, r: M3DB * c };
    case 'LFE': return { l: M3DB * lfe, r: M3DB * lfe };
    case 'BL': case 'SL': return { l: M3DB * s, r: 0 };
    case 'BR': case 'SR': return { l: 0, r: M3DB * s };
    default: return { l: 0, r: 0 };
  }
}

/**
 * Fold N de-interleaved channels down to stereo using BS.775 coefficients +
 * trims.  `channels` must match `LAYOUT_CHANNELS[layout]` length; extra/missing
 * channels are ignored/zero.  Pure.
 */
export function foldDownToStereo(
  channels: Float32Array[],
  layout: SurroundLayout,
  trims: SurroundTrims = DEFAULT_SURROUND_TRIMS,
): { left: Float32Array; right: Float32Array } {
  const t = sanitizeSurroundTrims(trims);
  const roles = LAYOUT_CHANNELS[layout];
  const n = channels[0]?.length ?? 0;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let ci = 0; ci < roles.length; ci++) {
    const ch = channels[ci];
    if (!ch) continue;
    const { l, r } = foldCoefficients(roles[ci]!, t);
    if (l === 0 && r === 0) continue;
    for (let i = 0; i < n; i++) { left[i]! += ch[i]! * l; right[i]! += ch[i]! * r; }
  }
  return { left, right };
}

/** BS.1770 channel weights: front = 1.0 (0 dB), surround = +1.5 dB, LFE excluded. */
export function bs1770Weight(role: ChannelRole): number {
  switch (role) {
    case 'FL': case 'FR': case 'FC': return 1.0;
    case 'BL': case 'BR': case 'SL': case 'SR': return db2lin(1.5);
    case 'LFE': return 0; // excluded from loudness
    default: return 0;
  }
}

/**
 * Channel-weighted mean-square loudness (relative, in dB) for a surround
 * program — the BS.1770 channel-summation layer (front 0 dB, surround +1.5 dB,
 * LFE excluded).  Full K-weighting/gating is the stereo loudness path's job;
 * this exposes the surround-specific weighted-sum so the UI can report it.
 */
export function channelWeightedLoudnessDb(channels: Float32Array[], layout: SurroundLayout): number {
  const roles = LAYOUT_CHANNELS[layout];
  let acc = 0;
  for (let ci = 0; ci < roles.length; ci++) {
    const ch = channels[ci];
    const w = bs1770Weight(roles[ci]!);
    if (!ch || w === 0) continue;
    let ms = 0;
    for (let i = 0; i < ch.length; i++) ms += ch[i]! * ch[i]!;
    acc += w * (ms / Math.max(1, ch.length));
  }
  // −0.691 is the BS.1770 absolute-scale offset; relative figure is fine for UI.
  return acc > 0 ? -0.691 + 10 * Math.log10(acc) : -Infinity;
}
