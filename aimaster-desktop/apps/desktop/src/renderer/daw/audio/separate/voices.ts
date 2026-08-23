// Lead against the rest of the voices.
//
// This one comes almost free, because the cue is already computed.  The vocal
// mask exists because a bin was centred, harmonic and did not repeat; WITHIN
// that, how centred it was still varies, and it varies for a reason a record
// producer would recognise:
//
//   the lead sits at exactly 0 — it is one voice, one take, panned dead centre,
//   and it has been mixed that way since before stereo was standard;
//   stacked backing vocals are DELIBERATELY not there.  They are doubled,
//   tripled, spread left and right, and often slightly detuned against each
//   other, all of which is the mix engineer making room for the lead.  Every
//   one of those choices lowers the coherence between the channels.
//
// So the split is a soft threshold on centre-ness, and the two masks are
// written as `x` and `1 − x` so they sum to the vocal mask exactly.
//
// ── The honest part ──────────────────────────────────────────────────────────
//
// This finds "the voice in the middle" and "the voices that are not".  On a
// record where the backings were stacked in the centre too, or on any mono
// file, there is no cue at all and the split is not real: everything lands in
// 리드 and `available` says false, rather than the panel showing a 코러스 stem
// that is silence with a bit of leakage in it.

import type { Centreness } from './stereo.js';

export interface VoiceSplitOptions {
  /** At or below this centre-ness, a vocal bin is entirely 코러스. */
  spread: number;
  /** At or above this, it is entirely 리드. */
  centred: number;
}

/**
 * The gap between them is what a doubled vocal actually measures.  Too narrow
 * and every breath flips between the two stems; too wide and the lead takes
 * the backings with it.
 */
export const DEFAULT_VOICE_SPLIT: VoiceSplitOptions = { spread: 0.45, centred: 0.9 };

export interface VoiceSplit {
  /** Share of each vocal bin that belongs to the lead.  코러스 is `1 − lead`. */
  lead: Float32Array;
  /**
   * False when the centre cue could not be measured — mono, or two identical
   * channels.  The lead then takes everything, because a 코러스 stem invented
   * out of no evidence is worse than no 코러스 stem.
   */
  available: boolean;
}

export function voiceSplit(
  centre: Centreness, frames: number, bins: number,
  options: Partial<VoiceSplitOptions> = {},
): VoiceSplit {
  const { spread, centred } = { ...DEFAULT_VOICE_SPLIT, ...options };
  const n = frames * bins;
  const lead = new Float32Array(n);

  if (!centre.informative || centred <= spread) {
    lead.fill(1);
    return { lead, available: false };
  }

  const scale = 1 / (centred - spread);
  for (let i = 0; i < n; i++) {
    const t = ((centre.value[i] ?? 0) - spread) * scale;
    // Raised cosine rather than a straight ramp: a linear crossfade between
    // two masks of the same signal dips by 3 dB in the middle, and the middle
    // is exactly where a doubled vocal lives.
    lead[i] = t <= 0 ? 0 : t >= 1 ? 1 : 0.5 * (1 - Math.cos(Math.PI * t));
  }
  return { lead, available: true };
}
