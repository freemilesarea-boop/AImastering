// saturation-chain — WebAudio saturation/exciter (preview APPROX).
//
// Approximates the Rust dsp-core saturation so the default (WASM-free) preview
// reflects the chosen character + drive.  Uses WaveShaperNode curves generated
// by the SAME shaper math as the Rust module (saturation-config.shapeSample),
// so the preview colour tracks the export.
//
// Internally always 4-band (cascaded LP/HP crossovers → per-band WaveShaper →
// sum), with a low DC-block high-pass on the wet path (matters for Tube).  In
// single-band mode every band uses the same global drive — a close
// approximation of broadband shaping.  Idle (unity/bypass) = routed around by
// shared-audio-graph, so no coloration.

import type { SaturationConfig } from './saturation-config.js';
import { sanitizeSaturation, isSaturationUnity, makeSaturationCurve } from './saturation-config.js';

const Q = Math.SQRT1_2;

export interface SaturationChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  apply(cfg: SaturationConfig): void;
  isActive(): boolean;
  dispose(): void;
}

function lp(ctx: BaseAudioContext, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; f.Q.value = Q; return f;
}
function hp(ctx: BaseAudioContext, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; f.Q.value = Q; return f;
}

export function createSaturationChain(ctx: BaseAudioContext): SaturationChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const dryGain = ctx.createGain(); dryGain.gain.value = 0;
  const wetGain = ctx.createGain(); wetGain.gain.value = 1;
  const bandSum = ctx.createGain();
  // DC block on the wet path (≈ 10 Hz high-pass) — removes the DC the Tube
  // shaper adds; negligible on the other characters.
  const dcHp = ctx.createBiquadFilter(); dcHp.type = 'highpass'; dcHp.frequency.value = 10; dcHp.Q.value = Q;

  // input → dry → output
  input.connect(dryGain); dryGain.connect(output);
  // input → 4 bands (filters → shaper) → bandSum → dcHp → wet → output
  const bandFilters: BiquadFilterNode[][] = [
    [lp(ctx, 120), lp(ctx, 120)],
    [hp(ctx, 120), hp(ctx, 120), lp(ctx, 1000), lp(ctx, 1000)],
    [hp(ctx, 1000), hp(ctx, 1000), lp(ctx, 6000), lp(ctx, 6000)],
    [hp(ctx, 6000), hp(ctx, 6000)],
  ];
  const shapers: WaveShaperNode[] = [];
  for (const filters of bandFilters) {
    let head: AudioNode = input;
    for (const f of filters) { head.connect(f); head = f; }
    const ws = ctx.createWaveShaper();
    try { ws.oversample = '4x'; } catch { /* ignore */ }
    head.connect(ws);
    ws.connect(bandSum);
    shapers.push(ws);
  }
  bandSum.connect(dcHp);
  dcHp.connect(wetGain);
  wetGain.connect(output);

  let active = false;

  const apply = (raw: SaturationConfig): void => {
    const cfg = sanitizeSaturation(raw);
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
      const bandDrive = cfg.multibandEnabled
        ? cfg.drive * ((cfg.bandDrivesPct[b] ?? 100) / 100)
        : cfg.drive;
      shapers[b]!.curve = makeSaturationCurve(cfg.character, bandDrive);
    }
    const mix = cfg.mixPct / 100;
    dryGain.gain.value = 1 - mix;
    wetGain.gain.value = mix;
    active = !isSaturationUnity(cfg);
  };

  const dispose = (): void => {
    const all: AudioNode[] = [input, output, dryGain, wetGain, bandSum, dcHp, ...shapers];
    for (const fs of bandFilters) all.push(...fs);
    for (const n of all) { try { n.disconnect(); } catch { /* ignore */ } }
  };

  return { input, output, apply, isActive: () => active, dispose };
}
