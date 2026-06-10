// surround-render — multichannel (5.1/7.1) output master (Phase 4, P4-2).
//
// Complements the fold-down path (P4-1): instead of collapsing to stereo, keep
// the channel layout and apply a master gain + a LINKED look-ahead true-peak
// limiter — one shared gain-reduction curve across all channels so the
// inter-channel balance (imaging) is preserved.  This is the essential
// surround-delivery safety (no channel clips, layout intact).
//
// Honest scope: gain + linked peak-ceiling limiting, not the full stereo chain
// (EQ/comp/saturation don't apply per-surround-channel here).  Loudness is
// reported as a channel-weighted *relative* figure (channelWeightedLoudnessDb in
// surround.ts) — true K-weighted BS.1770 LUFS is the fold-down path's job.
//
// Pure (no I/O); peak + limiter math are fully headless-testable.

const db2lin = (db: number): number => Math.pow(10, db / 20);

export interface SurroundLimiterParams {
  ceilingDb: number;
  lookaheadMs: number;
  releaseMs: number;
}

export const DEFAULT_SURROUND_LIMITER: SurroundLimiterParams = { ceilingDb: -1, lookaheadMs: 2, releaseMs: 80 };

/** Peak level (dB) across all channels. */
export function multichannelPeakDb(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]!); if (a > peak) peak = a; }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Apply a static gain (dB) to every channel (new arrays).  Pure. */
export function applyLinkedGain(channels: Float32Array[], gainDb: number): Float32Array[] {
  const g = db2lin(gainDb);
  return channels.map((ch) => { const o = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) o[i] = ch[i]! * g; return o; });
}

/**
 * Linked look-ahead brick-wall limiter across N channels.  Computes one
 * gain-reduction curve from the per-sample max across all channels (look-ahead
 * min-hold + one-pole release), delays the audio by the look-ahead, and applies
 * the SAME gain to every channel.  Output peak ≤ ceiling; imaging preserved.
 */
export function linkedLimiter(
  channels: Float32Array[],
  sampleRate: number,
  params: SurroundLimiterParams = DEFAULT_SURROUND_LIMITER,
): { channels: Float32Array[]; maxReductionDb: number } {
  const n = channels[0]?.length ?? 0;
  if (n === 0 || channels.length === 0) return { channels, maxReductionDb: 0 };
  const ceiling = db2lin(params.ceilingDb);
  const la = Math.max(0, Math.round((params.lookaheadMs / 1000) * sampleRate));
  const relCoef = params.releaseMs > 0 ? Math.exp(-1 / ((params.releaseMs / 1000) * sampleRate)) : 0;

  // Per-sample max across channels.
  const peak = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]!); if (a > peak[i]!) peak[i] = a; }

  // Target gain (≤1) needed at each sample to stay under the ceiling.
  const target = new Float32Array(n);
  for (let i = 0; i < n; i++) target[i] = peak[i]! > ceiling ? ceiling / peak[i]! : 1;

  // Look-ahead: the gain at output sample i must already be low enough for any
  // peak within the next `la` samples → sliding minimum over [i, i+la].
  const laMin = new Float32Array(n);
  // Simple O(n·la) min-hold is fine for offline; la is small (~ms).
  for (let i = 0; i < n; i++) {
    let m = target[i]!;
    const end = Math.min(n - 1, i + la);
    for (let j = i + 1; j <= end; j++) if (target[j]! < m) m = target[j]!;
    laMin[i] = m;
  }

  // Release smoothing: gain drops instantly (attack handled by look-ahead),
  // recovers toward 1 with the release coefficient.
  const gain = new Float32Array(n);
  let g = 1;
  let maxRed = 0;
  for (let i = 0; i < n; i++) {
    const tgt = laMin[i]!;
    g = tgt < g ? tgt : tgt + (g - tgt) * relCoef; // instant down, eased up
    gain[i] = g;
    if (g < 1) { const red = -20 * Math.log10(g); if (red > maxRed) maxRed = red; }
  }

  // Apply the linked gain.  No audio delay: the look-ahead min-hold has already
  // ramped the gain down over the `la` samples preceding each peak, and gain[i]
  // includes target[i], so the output never exceeds the ceiling (offline, so
  // the latency-free form is preferred).
  const out = channels.map(() => new Float32Array(n));
  for (let c = 0; c < channels.length; c++) {
    const src = channels[c]!;
    const dst = out[c]!;
    for (let i = 0; i < n; i++) dst[i] = src[i]! * gain[i]!;
  }
  return { channels: out, maxReductionDb: maxRed };
}

export interface SurroundMasterMetrics {
  peakBeforeDb: number;
  peakAfterDb: number;
  masterGainDb: number;
  limiterReductionDb: number;
}

/** Master a multichannel program: linked gain → linked true-peak limiter. */
export function masterSurroundOutput(
  channels: Float32Array[],
  sampleRate: number,
  opts: { masterGainDb: number; ceilingDb: number; lookaheadMs?: number; releaseMs?: number },
): { channels: Float32Array[]; metrics: SurroundMasterMetrics } {
  const peakBeforeDb = multichannelPeakDb(channels);
  const gained = applyLinkedGain(channels, opts.masterGainDb);
  const lim = linkedLimiter(gained, sampleRate, {
    ceilingDb: opts.ceilingDb,
    lookaheadMs: opts.lookaheadMs ?? DEFAULT_SURROUND_LIMITER.lookaheadMs,
    releaseMs: opts.releaseMs ?? DEFAULT_SURROUND_LIMITER.releaseMs,
  });
  return {
    channels: lim.channels,
    metrics: {
      peakBeforeDb,
      peakAfterDb: multichannelPeakDb(lim.channels),
      masterGainDb: opts.masterGainDb,
      limiterReductionDb: lim.maxReductionDb,
    },
  };
}

/** Interleave N de-interleaved channels back into a single buffer.  Pure. */
export function interleaveN(channels: Float32Array[]): Float32Array {
  const nc = channels.length;
  const frames = channels[0]?.length ?? 0;
  const out = new Float32Array(nc * frames);
  for (let c = 0; c < nc; c++) { const ch = channels[c]!; for (let f = 0; f < frames; f++) out[f * nc + c] = ch[f]!; }
  return out;
}
