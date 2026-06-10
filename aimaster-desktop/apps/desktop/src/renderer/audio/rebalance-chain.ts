// rebalance-chain — WebAudio rebalance approximation (no ML).
//
// Raises the CENTRE (vocal) vs panned instruments and adjusts bass + side
// width via M/S — an honest "rebalance-lite" heard live in the preview.  True
// per-stem separation is the Demucs/ONNX export path; this is the always-on,
// instant approximation.
//
//   M = .5(L+R), S = .5(L−R)
//   M' = lowShelf(bassDb) ∘ peaking(vocalDb @ ~1.6 kHz) (M)   ← centre/bass
//   S' = S · (sidePct/100)                                    ← width
//   out L = M' + S',  out R = M' − S'
//
// Idle (vocalDb=bassDb=0, sidePct=100) ⇒ exact passthrough → spliced out by
// shared-audio-graph (no coloration).

import type { RebalanceConfig } from './rebalance-config.js';
import { sanitizeRebalance, isApproxRebalanceUnity } from './rebalance-config.js';

const Q = Math.SQRT1_2;

export interface RebalanceChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  apply(cfg: RebalanceConfig): void;
  isActive(): boolean;
  dispose(): void;
}

export function createRebalanceChain(ctx: BaseAudioContext): RebalanceChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  const mL = ctx.createGain(); mL.gain.value = 0.5;
  const mR = ctx.createGain(); mR.gain.value = 0.5;
  const sL = ctx.createGain(); sL.gain.value = 0.5;
  const sR = ctx.createGain(); sR.gain.value = -0.5;
  const mid = ctx.createGain();
  const side = ctx.createGain();

  // Centre (vocal) + bass tone shaping on the mid bus.
  const vocalEq = ctx.createBiquadFilter(); vocalEq.type = 'peaking'; vocalEq.frequency.value = 1600; vocalEq.Q.value = 0.9;
  const bassEq = ctx.createBiquadFilter(); bassEq.type = 'lowshelf'; bassEq.frequency.value = 120;

  const sidePos = ctx.createGain(); sidePos.gain.value = 1;
  const sideNeg = ctx.createGain(); sideNeg.gain.value = -1;

  // Wire.
  input.connect(splitter);
  splitter.connect(mL, 0); splitter.connect(mR, 1);
  splitter.connect(sL, 0); splitter.connect(sR, 1);
  mL.connect(mid); mR.connect(mid);
  sL.connect(side); sR.connect(side);
  mid.connect(vocalEq); vocalEq.connect(bassEq);   // M' = bassEq(vocalEq(M))
  side.connect(sidePos); side.connect(sideNeg);     // ±S' (width applied on `side`)
  bassEq.connect(merger, 0, 0); sidePos.connect(merger, 0, 0); // L = M' + S'
  bassEq.connect(merger, 0, 1); sideNeg.connect(merger, 0, 1); // R = M' − S'
  merger.connect(output);

  let active = false;

  const apply = (raw: RebalanceConfig): void => {
    const c = sanitizeRebalance(raw);
    vocalEq.gain.value = c.vocalDb;
    bassEq.gain.value = c.bassDb;
    side.gain.value = c.sidePct / 100; // width multiplier on the side bus
    active = !isApproxRebalanceUnity(c);
  };

  const dispose = (): void => {
    for (const n of [input, output, splitter, merger, mL, mR, sL, sR, mid, side, vocalEq, bassEq, sidePos, sideNeg]) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  };

  return { input, output, apply, isActive: () => active, dispose };
}
