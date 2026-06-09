// imager-multiband-chain — WebAudio 4-band M/S width (preview APPROX).
//
// Approximates the Rust dsp-core 4-band imager so the default (WASM-free)
// preview reflects per-band stereo width.  M/S network mirrors the proven
// one in native-dsp-chain; the Side bus is split into 4 bands (cascaded
// biquad LP/HP) and each band's level scaled by its width before recombining.
//
// APPROXIMATION: WebAudio crossovers don't reconstruct as cleanly as the Rust
// subtractive split — the exported file (Rust render) is the source of truth.
// Spliced in by shared-audio-graph only when active; idle = routed around
// (no coloration).
//
//   L,R → split → M = .5(L+R)
//               → S = .5(L−R) → [4 band: filters → ×width] → S'
//         out L = M + S',  out R = M − S'

import type { ImagerMultibandConfig } from './imager-config.js';
import { sanitizeImagerMultiband, isImagerMultibandUnity } from './imager-config.js';

const Q = Math.SQRT1_2;

export interface ImagerMultibandChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  apply(cfg: ImagerMultibandConfig): void;
  isActive(): boolean;
  dispose(): void;
}

function lp(ctx: BaseAudioContext, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; f.Q.value = Q; return f;
}
function hp(ctx: BaseAudioContext, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; f.Q.value = Q; return f;
}

export function createImagerMultibandChain(ctx: BaseAudioContext): ImagerMultibandChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  // M = 0.5(L+R); S = 0.5(L−R).
  const mL = ctx.createGain(); mL.gain.value = 0.5;
  const mR = ctx.createGain(); mR.gain.value = 0.5;
  const sL = ctx.createGain(); sL.gain.value = 0.5;
  const sR = ctx.createGain(); sR.gain.value = -0.5;
  const mid = ctx.createGain();
  const side = ctx.createGain();
  const sideSum = ctx.createGain();
  const sidePos = ctx.createGain(); sidePos.gain.value = 1;
  const sideNeg = ctx.createGain(); sideNeg.gain.value = -1;

  input.connect(splitter);
  splitter.connect(mL, 0); splitter.connect(mR, 1);
  splitter.connect(sL, 0); splitter.connect(sR, 1);
  mL.connect(mid); mR.connect(mid);
  sL.connect(side); sR.connect(side);

  // Side split into 4 bands → per-band width gain → sideSum.
  const bandFilters: BiquadFilterNode[][] = [
    [lp(ctx, 120), lp(ctx, 120)],
    [hp(ctx, 120), hp(ctx, 120), lp(ctx, 1000), lp(ctx, 1000)],
    [hp(ctx, 1000), hp(ctx, 1000), lp(ctx, 6000), lp(ctx, 6000)],
    [hp(ctx, 6000), hp(ctx, 6000)],
  ];
  const bandGains: GainNode[] = [];
  for (const filters of bandFilters) {
    let head: AudioNode = side;
    for (const f of filters) { head.connect(f); head = f; }
    const g = ctx.createGain(); g.gain.value = 1;
    head.connect(g);
    g.connect(sideSum);
    bandGains.push(g);
  }

  // Recombine: L = mid + sideSum, R = mid − sideSum.
  sideSum.connect(sidePos); sideSum.connect(sideNeg);
  mid.connect(merger, 0, 0); sidePos.connect(merger, 0, 0);
  mid.connect(merger, 0, 1); sideNeg.connect(merger, 0, 1);
  merger.connect(output);

  let active = false;

  const apply = (raw: ImagerMultibandConfig): void => {
    const cfg = sanitizeImagerMultiband(raw);
    const freqs: number[][] = [
      [cfg.xoverLoHz, cfg.xoverLoHz],
      [cfg.xoverLoHz, cfg.xoverLoHz, cfg.xoverMidHz, cfg.xoverMidHz],
      [cfg.xoverMidHz, cfg.xoverMidHz, cfg.xoverHiHz, cfg.xoverHiHz],
      [cfg.xoverHiHz, cfg.xoverHiHz],
    ];
    for (let b = 0; b < 4; b++) {
      const fs = freqs[b]!;
      const flt = bandFilters[b]!;
      for (let i = 0; i < flt.length; i++) { const hz = fs[i]; if (typeof hz === 'number') flt[i]!.frequency.value = hz; }
      bandGains[b]!.gain.value = (cfg.widthsPct[b] ?? 100) / 100;
    }
    active = !isImagerMultibandUnity(cfg);
  };

  const dispose = (): void => {
    const all: AudioNode[] = [input, output, splitter, merger, mL, mR, sL, sR, mid, side, sideSum, sidePos, sideNeg, ...bandGains];
    for (const fs of bandFilters) all.push(...fs);
    for (const n of all) { try { n.disconnect(); } catch { /* ignore */ } }
  };

  return { input, output, apply, isActive: () => active, dispose };
}
