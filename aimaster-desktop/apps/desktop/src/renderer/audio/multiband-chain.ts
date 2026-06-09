// multiband-chain — WebAudio 4-band multiband compressor (preview APPROX).
//
// The always-on preview is WASM-free WebAudio.  This chain approximates the
// Rust dsp-core multiband compressor so the default preview reflects the
// user's multiband settings.  It is an APPROXIMATION: WebAudio crossovers
// (cascaded biquad LP/HP) don't reconstruct as cleanly as the Rust
// subtractive split, and DynamicsCompressorNode differs from the Rust
// detector — the exported file (Rust render) is the source of truth.
//
// Spliced in by shared-audio-graph only when active (any band compressing or
// makeup ≠ 0); when inactive the bus routes around it, so an idle multiband
// adds NO coloration.
//
// Topology:  input ─┬─ LP(lo)              → comp0 → mk0 ─┐
//                   ├─ HP(lo)→LP(mid)      → comp1 → mk1 ─┤
//                   ├─ HP(mid)→LP(hi)      → comp2 → mk2 ─┤→ output
//                   └─ HP(hi)              → comp3 → mk3 ─┘

import type { MultibandConfig } from './multiband-config.js';
import { sanitizeMultiband, isMultibandUnity } from './multiband-config.js';

const Q = Math.SQRT1_2; // Butterworth; two cascaded ⇒ ~LR4 slope.

function db2lin(db: number): number {
  return Math.pow(10, (Number.isFinite(db) ? db : 0) / 20);
}

interface BandNodes {
  filters: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  makeup: GainNode;
}

export interface MultibandChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  apply(cfg: MultibandConfig): void;
  /** True when at least one band would alter the signal. */
  isActive(): boolean;
  dispose(): void;
}

function lp(ctx: BaseAudioContext, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; f.Q.value = Q; return f;
}
function hp(ctx: BaseAudioContext, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; f.Q.value = Q; return f;
}

export function createMultibandChain(ctx: BaseAudioContext): MultibandChain {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.gain.value = 1;
  output.gain.value = 1;

  // Build 4 band paths.  Filter cutoffs are set in apply(); start at defaults.
  const bands: BandNodes[] = [];
  const makeBand = (filters: BiquadFilterNode[]): BandNodes => {
    const comp = ctx.createDynamicsCompressor();
    comp.knee.value = 6;
    const makeup = ctx.createGain();
    makeup.gain.value = 1;
    // input → filters (series) → comp → makeup → output
    let head: AudioNode = input;
    for (const f of filters) { head.connect(f); head = f; }
    head.connect(comp);
    comp.connect(makeup);
    makeup.connect(output);
    return { filters, comp, makeup };
  };

  bands.push(makeBand([lp(ctx, 120), lp(ctx, 120)]));                 // low
  bands.push(makeBand([hp(ctx, 120), hp(ctx, 120), lp(ctx, 1000), lp(ctx, 1000)])); // low-mid
  bands.push(makeBand([hp(ctx, 1000), hp(ctx, 1000), lp(ctx, 6000), lp(ctx, 6000)])); // high-mid
  bands.push(makeBand([hp(ctx, 6000), hp(ctx, 6000)]));               // high

  let active = false;

  const setBandFilters = (b: BandNodes, freqs: number[]): void => {
    for (let i = 0; i < b.filters.length; i++) {
      const hz = freqs[i];
      if (typeof hz === 'number') b.filters[i]!.frequency.value = hz;
    }
  };

  const apply = (raw: MultibandConfig): void => {
    const cfg = sanitizeMultiband(raw);
    const { xoverLoHz: lo, xoverMidHz: mid, xoverHiHz: hi } = cfg;
    // Re-tune crossover filters.
    setBandFilters(bands[0]!, [lo, lo]);
    setBandFilters(bands[1]!, [lo, lo, mid, mid]);
    setBandFilters(bands[2]!, [mid, mid, hi, hi]);
    setBandFilters(bands[3]!, [hi, hi]);
    // Per-band compressor + makeup.
    for (let i = 0; i < 4; i++) {
      const bc = cfg.bands[i]!;
      const c = bands[i]!.comp;
      c.threshold.value = Math.min(0, Math.max(-100, bc.thresholdDb));
      c.ratio.value = Math.min(20, Math.max(1, bc.ratio));
      c.attack.value = Math.min(1, Math.max(0, bc.attackMs / 1000));
      c.release.value = Math.min(1, Math.max(0, bc.releaseMs / 1000));
      bands[i]!.makeup.gain.value = db2lin(bc.makeupDb);
    }
    active = !isMultibandUnity(cfg);
  };

  const dispose = (): void => {
    const all: AudioNode[] = [input, output];
    for (const b of bands) { all.push(b.comp, b.makeup, ...b.filters); }
    for (const n of all) { try { n.disconnect(); } catch { /* ignore */ } }
  };

  return { input, output, apply, isActive: () => active, dispose };
}
