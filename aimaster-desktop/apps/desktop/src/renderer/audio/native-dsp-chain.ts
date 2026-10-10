// native-dsp-chain — a WASM-free realtime mastering chain built from core
// WebAudio nodes.  It is the always-audible fallback: when the Rust/WASM
// mastering worklet fails to load (common under Electron file://), this
// chain still makes EQ / dynamics / stereo-width / output-gain edits change
// the sound in real time.
//
// Signal order mirrors the Rust chain:
//   input gain → EQ(HP, low-shelf, presence, air) → compressor →
//   M/S (stereoize → low-mono → width) → limiter(approx) → output gain
//
// It consumes the SAME RealtimeChainConfig the WASM chain + export use, so
// the preview matches the offline render's intent.

import type { RealtimeChainConfig } from './realtime-mastering-chain.js';
import { BUTTERWORTH_Q } from '../daw/engine/plugin-kit.js';

/**
 * The stereoizer, in the same numbers the Rust imager uses.
 *
 * Delays in samples at 48 kHz, a true-allpass coefficient, and how much
 * decorrelated Side a mono source gets.  They are duplicated rather than
 * imported because one side of this pair is Rust — so a test compares the two
 * engines' OUTPUT instead of trusting that nobody edited one of them.
 */
const SPREAD_DELAYS_48K = [211, 347, 593, 907] as const;
const SPREAD_G = 0.6;
const SPREAD_AMOUNT = 0.4;
/**
 * Seconds of impulse response kept for the cascade.
 *
 * Each stage's loop gain is 0.6 over its own delay, so the longest stage is
 * down by 0.6^53 ≈ 3e-12 after half a second.  A quarter is already
 * inaudible; this is the comfortable side of it.
 */
const SPREAD_IR_SEC = 0.5;

/**
 * The cascade's impulse response, which is the only honest way to run it
 * here.
 *
 * The Rust imager is four Schroeder allpasses: `v = x + g·v[n−D]`,
 * `y = −g·v + v[n−D]`.  Building that out of WebAudio nodes needs a feedback
 * loop, and a cycle in a WebAudio graph is given an extra render quantum of
 * latency by the implementation — so the feedforward path sees D while the
 * feedback path sees D + 128, which is no longer an allpass at all.  Measured
 * in Chromium, that version of the cascade came out with an energy gain of
 * about 2.1 and took a mono source to correlation 0.49 instead of 0.72,
 * while the same code in node-web-audio-api (no extra quantum) measured
 * correctly — a divergence that would have shipped as "the preview is wider
 * than the render".
 *
 * Convolving the response instead is loop-free and exact in any
 * implementation, and it is the SAME filter the Rust side runs, to the
 * truncation above.
 */
export function spreadImpulseResponse(sampleRate: number): Float32Array {
  const scale = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate / 48_000 : 1;
  const lengths = SPREAD_DELAYS_48K.map((d) => Math.max(1, Math.round(d * scale)));
  const buffers = lengths.map((len) => new Float64Array(len));
  const idx = lengths.map(() => 0);
  const n = Math.max(1, Math.round(SPREAD_IR_SEC * (Number.isFinite(sampleRate) ? sampleRate : 48_000)));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let x = i === 0 ? 1 : 0;
    for (let k = 0; k < buffers.length; k += 1) {
      const buf = buffers[k]!;
      const at = idx[k]!;
      const delayed = buf[at]!;
      const v = x + SPREAD_G * delayed;
      buf[at] = v;
      idx[k] = at + 1 >= buf.length ? 0 : at + 1;
      x = -SPREAD_G * v + delayed;
    }
    out[i] = x;
  }
  return out;
}

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

  const hp = ctx.createBiquadFilter();   hp.type = 'highpass';  hp.frequency.value = 20; hp.Q.value = BUTTERWORTH_Q;
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

  // Low-mono lives on the Side, exactly as it does in the Rust imager: a
  // high-pass here is what folds the bass to mono.  This chain used to carry
  // `imgLowMonoHz` in its config and ignore it, so the fallback preview was
  // wider in the bass than the render it was previewing.
  const sideHp = ctx.createBiquadFilter();
  sideHp.type = 'highpass'; sideHp.frequency.value = 20; sideHp.Q.value = 0.707;

  // The stereoizer: the cascade's impulse response, convolved.  Mid is
  // untouched, so a mono fold-down is still the input — see
  // `spreadImpulseResponse` for why this is a convolution and not the four
  // feedback loops the Rust side runs.
  const spread = ctx.createConvolver();
  // Chromium normalises an impulse response by default, which would throw
  // away the one property that makes this an allpass.
  spread.normalize = false;
  const ir = spreadImpulseResponse(ctx.sampleRate);
  const irBuffer = ctx.createBuffer(1, ir.length, ctx.sampleRate);
  irBuffer.copyToChannel(ir as Float32Array<ArrayBuffer>, 0);
  spread.buffer = irBuffer;
  const spreadOut = ctx.createGain(); spreadOut.gain.value = 0;
  spread.connect(spreadOut);

  splitter.connect(mLg, 0); splitter.connect(mRg, 1);
  splitter.connect(sLg, 0); splitter.connect(sRg, 1);
  mLg.connect(mid); mRg.connect(mid);
  sLg.connect(side); sRg.connect(side);
  // Mid feeds the spread; the spread joins the Side before the low-mono
  // high-pass, so synthetic width is kept out of the bass.
  mid.connect(spread);
  side.connect(sideHp); spreadOut.connect(sideHp);
  sideHp.connect(sidePos); sideHp.connect(sideNeg);
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
    // 20 Hz is "off": the Rust imager uses the same threshold, and a
    // high-pass at 20 Hz leaves the Side alone.
    sideHp.frequency.value = imgOff ? 20 : clampNum(c.imgLowMonoHz, 20, 400, 20);
    spreadOut.gain.value = !imgOff && c.imgStereoize ? SPREAD_AMOUNT : 0;

    const limOff = bypass || c.limBypass;
    lim.threshold.value = limOff ? 0 : clampNum(c.limCeilingDbtp, -24, 0, -1);
    lim.ratio.value = limOff ? 1 : 20;

    outputGain.gain.value = db2lin(bypass ? 0 : c.outputGainDb);
  };

  const dispose = (): void => {
    for (const n of [inputGain, hp, ls, pk, hs, comp, splitter, merger,
      mLg, mRg, sLg, sRg, mid, side, sideHp, sidePos, sideNeg, lim, outputGain,
      spread, spreadOut]) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  };

  return { input: inputGain, output: outputGain, apply, dispose };
}
