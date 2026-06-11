// dyneq-chain — WebAudio dynamic-EQ preview (APPROX).
//
// The real module is threshold-driven per-band gain (Rust export / worklet).
// WebAudio can't cheaply do per-band envelope-driven gain, so this preview is a
// STATIC approximation: each enabled band becomes a fixed biquad whose gain is a
// fraction of `rangeDb` in the band's direction (DownCut → −, UpBoost → +).  It
// gives directional tonal feedback (incl. the de-esser band, which is merged
// into the dynamic-EQ config by the caller) — not the real dynamic behaviour.
// Idle/unity is routed around by shared-audio-graph (no coloration).

import type { DynamicEqConfig } from './dyneq-config.js';
import { sanitizeDynamicEq, isDynamicEqUnity, MAX_DYNEQ_BANDS } from './dyneq-config.js';

/** Static fraction of the band range applied as a fixed move (preview only). */
const APPROX_FRACTION = 0.5;

export interface DynEqChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  apply(cfg: DynamicEqConfig): void;
  isActive(): boolean;
  dispose(): void;
}

export function createDynEqChain(ctx: BaseAudioContext): DynEqChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // A fixed pool of biquads (up to MAX bands) chained in series; unused ones sit
  // at 0 dB (transparent).
  const biquads: BiquadFilterNode[] = [];
  let head: AudioNode = input;
  for (let i = 0; i < MAX_DYNEQ_BANDS; i++) {
    const b = ctx.createBiquadFilter();
    b.type = 'peaking'; b.frequency.value = 1000; b.Q.value = 1; b.gain.value = 0;
    head.connect(b); head = b;
    biquads.push(b);
  }
  head.connect(output);

  let active = false;
  const apply = (raw: DynamicEqConfig): void => {
    const c = sanitizeDynamicEq(raw);
    active = !isDynamicEqUnity(c);
    const bands = c.bands.slice(0, MAX_DYNEQ_BANDS);
    biquads.forEach((bq, i) => {
      const b = bands[i];
      if (c.bypass || !b || !b.enabled || b.rangeDb <= 0) { bq.gain.value = 0; return; }
      bq.type = b.filterType === 'lowshelf' ? 'lowshelf' : b.filterType === 'highshelf' ? 'highshelf' : 'peaking';
      bq.frequency.value = b.freqHz;
      bq.Q.value = Math.max(0.1, b.q);
      const dir = b.mode === 'downcut' ? -1 : 1;
      bq.gain.value = dir * b.rangeDb * APPROX_FRACTION;
    });
  };

  const dispose = (): void => {
    for (const n of [input, output, ...biquads]) { try { n.disconnect(); } catch { /* ignore */ } }
  };

  return { input, output, apply, isActive: () => active, dispose };
}
