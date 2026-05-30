// native-dsp-chain — a WASM-free realtime mastering chain built from core
// WebAudio nodes.  It is the always-audible fallback: when the Rust/WASM
// mastering worklet fails to load (common under Electron file://), this
// chain still makes EQ / dynamics / stereo-width / output-gain edits change
// the sound in real time.
//
// Signal order mirrors the Rust chain:
//   input gain → EQ(HP, low-shelf, presence, air) → compressor →
//   M/S width → limiter(approx) → output gain
//
// It consumes the SAME RealtimeChainConfig the WASM chain + export use, so
// the preview matches the offline render's intent.

import type { RealtimeChainConfig } from './realtime-mastering-chain.js';

function db2lin(db: number): number {
  return Math.pow(10, (Number.isFinite(db) ? db : 0) / 20);
}
function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  const x = Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, x));
}

export interface NativeDspChain {
  /** Connect the upstream source here. */
  readonly input: AudioNode;
  /** Connect this downstream (→ masterGain). */
  readonly output: AudioNode;
  /** Apply a full config (immediate; safe to call every rAF). */
  apply(cfg: RealtimeChainConfig): void;
  /** Disconnect every internal node (teardown). */
  dispose(): void;
}

export function createNativeDspChain(ctx: BaseAudioContext): NativeDspChain {
  const inputGain = ctx.createGain();

  const hp = ctx.createBiquadFilter();   hp.type = 'highpass';  hp.frequency.value = 20; hp.Q.value = 0.707;
  const ls = ctx.createBiquadFilter();   ls.type = 'lowshelf';  ls.frequency.value = 120;
  const pk = ctx.createBiquadFilter();   pk.type = 'peaking';   pk.frequency.value = 3000; pk.Q.value = 1;
  const hs = ctx.createBiquadFilter();   hs.type = 'highshelf'; hs.frequency.value = 12000;

  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 6;

  // ── M/S width network ──────────────────────────────────────────────
  // mid = 0.5(L+R), side = 0.5(L−R); out L = mid + w·side, R = mid − w·side.
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const mLg = ctx.createGain(); mLg.gain.value = 0.5;
  const mRg = ctx.createGain(); mRg.gain.value = 0.5;
  const sLg = ctx.createGain(); sLg.gain.value = 0.5;
  const sRg = ctx.createGain(); sRg.gain.value = -0.5;
  const mid = ctx.createGain(); mid.gain.value = 1;
  const side = ctx.createGain(); side.gain.value = 1;
  const sidePos = ctx.createGain(); sidePos.gain.value = 1;
  const sideNeg = ctx.createGain(); sideNeg.gain.value = -1;

  splitter.connect(mLg, 0); splitter.connect(mRg, 1);
  splitter.connect(sLg, 0); splitter.connect(sRg, 1);
  mLg.connect(mid); mRg.connect(mid);
  sLg.connect(side); sRg.connect(side);
  side.connect(sidePos); side.connect(sideNeg);
  mid.connect(merger, 0, 0); sidePos.connect(merger, 0, 0);
  mid.connect(merger, 0, 1); sideNeg.connect(merger, 0, 1);

  // ── Limiter approximation (fast, high-ratio compressor) ─────────────
  const lim = ctx.createDynamicsCompressor();
  lim.knee.value = 0; lim.attack.value = 0.003; lim.release.value = 0.1; lim.ratio.value = 20;

  const outputGain = ctx.createGain();

  // Wire the fixed topology once.
  inputGain.connect(hp); hp.connect(ls); ls.connect(pk); pk.connect(hs);
  hs.connect(comp);
  comp.connect(splitter);
  merger.connect(lim);
  lim.connect(outputGain);

  const apply = (c: RealtimeChainConfig): void => {
    const bypass = !!c.masterBypass;
    inputGain.gain.value = db2lin(bypass ? 0 : c.inputGainDb);

    const eqOff = bypass || c.eqBypass;
    hp.frequency.value = eqOff ? 20 : clampNum(c.eqLowCutHz, 10, 1000, 20);
    ls.gain.value = eqOff ? 0 : clampNum(c.eqLowShelfDb, -24, 24, 0);
    pk.gain.value = eqOff ? 0 : clampNum(c.eqPresenceDb, -24, 24, 0);
    hs.gain.value = eqOff ? 0 : clampNum(c.eqAirDb, -24, 24, 0);

    const dynOff = bypass || c.dynBypass;
    comp.threshold.value = dynOff ? 0 : clampNum(c.dynThresholdDb, -60, 0, 0);
    comp.ratio.value = dynOff ? 1 : clampNum(c.dynRatio, 1, 20, 1);
    comp.attack.value = (dynOff ? 10 : clampNum(c.dynAttackMs, 0.1, 200, 10)) / 1000;
    comp.release.value = (dynOff ? 120 : clampNum(c.dynReleaseMs, 5, 2000, 120)) / 1000;

    const imgOff = bypass || c.imgBypass;
    const w = imgOff ? 1 : clampNum(c.imgWidthPct, 0, 200, 100) / 100;
    sidePos.gain.value = w;
    sideNeg.gain.value = -w;

    const limOff = bypass || c.limBypass;
    lim.threshold.value = limOff ? 0 : clampNum(c.limCeilingDbtp, -24, 0, -1);
    lim.ratio.value = limOff ? 1 : 20;

    outputGain.gain.value = db2lin(bypass ? 0 : c.outputGainDb);
  };

  const dispose = (): void => {
    for (const n of [inputGain, hp, ls, pk, hs, comp, splitter, merger,
      mLg, mRg, sLg, sRg, mid, side, sidePos, sideNeg, lim, outputGain]) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  };

  return { input: inputGain, output: outputGain, apply, dispose };
}
