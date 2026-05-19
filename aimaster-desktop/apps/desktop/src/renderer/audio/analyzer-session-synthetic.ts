// Synthetic AnalyzerSession factory.
//
// Purpose: prove the full lifecycle (factory → session → React hook →
// subscription / unsubscription) works end-to-end **without** needing
// an AudioWorklet or N-API binary.  Drives the existing TS realtime
// analyzers (`loudnessCore`, etc.) against a synthesised internal
// signal so M3 entry can be verified before the WASM bridge lands.
//
// The synthetic factory exists ONLY for development and tests — production
// uses `analyzer-session-wasm.ts` (M3 wiring, not in this commit).

import type {
  AnalyzerSession,
  AnalyzerSessionFactory,
  AnalyzerSessionOptions,
  AnalyzerUnsubscribe,
  FftFrame,
  MeterSnapshot,
  MeterTickSnapshot,
  StereoScopeFrame,
  SubscriptionRate,
} from '@aimaster/shared-types/streaming';
import {
  METER_SNAPSHOT_SCHEMA,
  FFT_FRAME_SCHEMA,
  STEREO_SCOPE_FRAME_SCHEMA,
} from '@aimaster/shared-types/streaming';

import { LoudnessAnalyzer } from '../audio/loudnessCore.js';

// ── Tick rate → milliseconds ─────────────────────────────────────────────────

function rateToMs(rate: SubscriptionRate): number {
  switch (rate) {
    case 'audio': return 16;   // emit as fast as practical (≈ 60 Hz)
    case '60Hz':  return 16;
    case '30Hz':  return 33;
    case '10Hz':  return 100;
    default:      return 100;
  }
}

// ── Synthetic signal source ──────────────────────────────────────────────────

interface OscillatorState {
  freq: number;
  amp: number;
  phase: number;
}

function nextBlock(sr: number, blockLen: number, oscs: OscillatorState[], targetDbfs: number): { left: Float32Array; right: Float32Array } {
  const left  = new Float32Array(blockLen);
  const right = new Float32Array(blockLen);
  // Target RMS ≈ 10^(targetDbfs/20).  Use sum-of-sines / √N to land near it.
  const scale = Math.pow(10, targetDbfs / 20) * Math.SQRT2;
  for (let i = 0; i < blockLen; i++) {
    let s = 0;
    for (const o of oscs) {
      s += o.amp * Math.sin(o.phase);
      o.phase += (2 * Math.PI * o.freq) / sr;
      if (o.phase > 2 * Math.PI * 1000) o.phase -= 2 * Math.PI * 1000;
    }
    s = s / oscs.length * scale;
    left[i]  = s;
    // Slight phase offset on R for non-trivial correlation.
    right[i] = s * 0.95;
  }
  return { left, right };
}

// ── Synthetic session ────────────────────────────────────────────────────────

interface Subscription<T> {
  rate?: SubscriptionRate;
  cb: (t: T) => void;
  lastEmit: number;
}

class SyntheticAnalyzerSession implements AnalyzerSession {
  readonly options: AnalyzerSessionOptions;
  isRunning = false;

  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private lufs: LoudnessAnalyzer;
  private samplesProcessed = 0;
  private prevTpDb = -Infinity;

  // Subscribers
  private tickSubs: Subscription<MeterTickSnapshot>[] = [];
  private fullSubs: Subscription<MeterSnapshot>[] = [];
  private fftSubs:  Subscription<FftFrame>[] = [];
  private stereoSubs: Subscription<StereoScopeFrame>[] = [];

  // Oscillator bank — 3 sines at audible freqs.
  private oscs: OscillatorState[] = [
    { freq: 220,  amp: 1, phase: 0 },
    { freq: 880,  amp: 0.5, phase: 0 },
    { freq: 2400, amp: 0.3, phase: 0 },
  ];

  constructor(options: AnalyzerSessionOptions) {
    this.options = { ...options };
    this.lufs = new LoudnessAnalyzer(options.sampleRate, options.channels);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = Date.now();
    // Step 50 ms per tick — half-block of LUFS hop, enough to produce
    // snapshots at ≤ 60 Hz cadence.
    this.timer = setInterval(() => this.advance(), 50);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  onTickSnapshot(rate: SubscriptionRate, cb: (snap: MeterTickSnapshot) => void): AnalyzerUnsubscribe {
    const sub: Subscription<MeterTickSnapshot> = { rate, cb, lastEmit: 0 };
    this.tickSubs.push(sub);
    return () => { this.tickSubs = this.tickSubs.filter((s) => s !== sub); };
  }

  onFullSnapshot(cb: (snap: MeterSnapshot) => void): AnalyzerUnsubscribe {
    const sub: Subscription<MeterSnapshot> = { cb, lastEmit: 0 };
    this.fullSubs.push(sub);
    return () => { this.fullSubs = this.fullSubs.filter((s) => s !== sub); };
  }

  onFftFrame(cb: (frame: FftFrame) => void): AnalyzerUnsubscribe {
    const sub: Subscription<FftFrame> = { cb, lastEmit: 0 };
    this.fftSubs.push(sub);
    return () => { this.fftSubs = this.fftSubs.filter((s) => s !== sub); };
  }

  onStereoFrame(cb: (frame: StereoScopeFrame) => void): AnalyzerUnsubscribe {
    const sub: Subscription<StereoScopeFrame> = { cb, lastEmit: 0 };
    this.stereoSubs.push(sub);
    return () => { this.stereoSubs = this.stereoSubs.filter((s) => s !== sub); };
  }

  async requestSnapshot(): Promise<MeterSnapshot> {
    const tick = this.tickSnapshot();
    const full: MeterSnapshot = {
      ...tick,
      schema: METER_SNAPSHOT_SCHEMA,
      integratedLufs: this.lufs.getIntegratedLufs(),
      loudnessRange:  0,
      gatedBlocks:    0,                  // not exposed by current TS LoudnessAnalyzer
    };
    return full;
  }

  async reset(): Promise<void> {
    this.lufs = new LoudnessAnalyzer(this.options.sampleRate, this.options.channels);
    this.samplesProcessed = 0;
    this.prevTpDb = -Infinity;
  }

  // ── Internal: drive the analyzer + dispatch to subscribers. ────────────────

  private advance(): void {
    const sr = this.options.sampleRate;
    // Generate one block worth of audio per tick (50 ms = sr/20 samples).
    const blockLen = Math.floor(sr / 20);
    const { left, right } = nextBlock(sr, blockLen, this.oscs, -14);

    // Push to LUFS (planar [L, R] of Float32Array).
    this.lufs.processBlock([left, right]);
    this.samplesProcessed += blockLen;

    // Compute basic per-channel TP / peak/RMS / correlation via simple math.
    let peakL = 0, peakR = 0, sumL2 = 0, sumR2 = 0, sumLR = 0;
    for (let i = 0; i < blockLen; i++) {
      const a = Math.abs(left[i]!);
      if (a > peakL) peakL = a;
      const b = Math.abs(right[i]!);
      if (b > peakR) peakR = b;
      sumL2 += left[i]! * left[i]!;
      sumR2 += right[i]! * right[i]!;
      sumLR += left[i]! * right[i]!;
    }
    const peakLin = Math.max(peakL, peakR);
    const peakDb = peakLin > 0 ? 20 * Math.log10(peakLin) : -Infinity;
    const rmsLin = Math.sqrt((sumL2 + sumR2) / (2 * blockLen));
    const rmsDb = rmsLin > 0 ? 20 * Math.log10(rmsLin) : -Infinity;
    const corr = (sumLR + 1e-18) / Math.sqrt((sumL2 + 1e-18) * (sumR2 + 1e-18));
    const msRatioDb = ((sumL2 + sumR2) > 0 && (sumL2 + sumR2 - 2 * sumLR) > 0)
      ? 10 * Math.log10((sumL2 + sumR2 + 2 * sumLR) / Math.max(1e-12, sumL2 + sumR2 - 2 * sumLR))
      : Infinity;

    const tickSnap: MeterTickSnapshot = {
      schema: METER_SNAPSHOT_SCHEMA,
      sampleRate: sr,
      channels: this.options.channels,
      samplesProcessed: this.samplesProcessed,
      integratedLufs: Number.NaN,
      loudnessRange:  Number.NaN,
      gatedBlocks:    0,
      momentaryLufs:  this.lufs.getMomentaryLufs(),
      shortTermLufs:  this.lufs.getShortTermLufs(),
      truePeakDbtp:   peakDb,                  // synthetic: approximation
      samplePeakDb:   peakDb,
      rmsDb,
      correlation:    corr,
      msRatioDb,
    };

    const now = Date.now();
    for (const sub of this.tickSubs) {
      const period = rateToMs(sub.rate ?? '10Hz');
      if (now - sub.lastEmit >= period) {
        sub.cb(tickSnap);
        sub.lastEmit = now;
      }
    }

    // Throttle full snapshots to 1 Hz.
    for (const sub of this.fullSubs) {
      if (now - sub.lastEmit >= 1000) {
        sub.cb({
          ...tickSnap,
          integratedLufs: this.lufs.getIntegratedLufs(),
          loudnessRange:  0,
        });
        sub.lastEmit = now;
      }
    }

    // FFT — synthetic: produce a sketched spectrum with peaks at the
    // oscillator frequencies.  Real impl uses dsp-core SpectrumAnalyzer
    // via the WASM bridge.
    for (const sub of this.fftSubs) {
      if (now - sub.lastEmit >= 33) {
        sub.cb(this.makeSyntheticFftFrame());
        sub.lastEmit = now;
      }
    }

    for (const sub of this.stereoSubs) {
      if (now - sub.lastEmit >= 33) {
        sub.cb({
          schema: STEREO_SCOPE_FRAME_SCHEMA,
          correlation: corr,
          msRatioDb,
          widthIndex: 1 - corr * 0.5,
          windowFrames: blockLen,
        });
        sub.lastEmit = now;
      }
    }
  }

  private tickSnapshot(): MeterTickSnapshot {
    // Used by requestSnapshot — pulls the latest LUFS analyzer state.
    return {
      schema: METER_SNAPSHOT_SCHEMA,
      sampleRate: this.options.sampleRate,
      channels:   this.options.channels,
      samplesProcessed: this.samplesProcessed,
      integratedLufs: Number.NaN,
      loudnessRange:  Number.NaN,
      gatedBlocks:    0,
      momentaryLufs:  this.lufs.getMomentaryLufs(),
      shortTermLufs:  this.lufs.getShortTermLufs(),
      truePeakDbtp:   this.prevTpDb,
      samplePeakDb:   this.prevTpDb,
      rmsDb:          this.prevTpDb,
      correlation:    1,
      msRatioDb:      Infinity,
    };
  }

  private makeSyntheticFftFrame(): FftFrame {
    // 64-bin log-spaced spectrum with peaks at oscillator frequencies.
    const bins = 64;
    const minHz = 20;
    const maxHz = 20_000;
    const logMin = Math.log10(minHz);
    const logMax = Math.log10(maxHz);
    const centres: number[] = [];
    const mag: number[] = [];
    const peak: number[] = [];
    for (let i = 0; i < bins; i++) {
      const cf = Math.pow(10, logMin + ((logMax - logMin) * i) / (bins - 1));
      centres.push(cf);
      // Gaussian peaks at oscillator centres.
      let v = -60;
      for (const osc of this.oscs) {
        const d = Math.log2(cf / osc.freq);
        const g = -((d * d) / (2 * 0.4 * 0.4));
        v = Math.max(v, -20 + Math.exp(g) * 10);
      }
      mag.push(v);
      peak.push(v + 3);
    }
    return {
      schema: FFT_FRAME_SCHEMA,
      sampleRate: this.options.sampleRate,
      samplesProcessed: this.samplesProcessed,
      fftSize: 2048,
      binCentresHz: centres,
      magnitudeDb: mag,
      peakHoldDb:  peak,
    };
  }
}

/**
 * Factory for synthetic analyzer sessions.  Drives the existing TS
 * `LoudnessAnalyzer` against a synthesised internal signal.
 *
 * Used by:
 *   - The React hook (`useAnalyzerStream`) for development / smoke tests
 *     before the WASM bridge lands.
 *   - Storybook-style component previews.
 *   - End-to-end tests that need a deterministic analyzer source.
 *
 * Production code (M3-wiring) uses `WasmAnalyzerSessionFactory` instead.
 */
export class SyntheticAnalyzerSessionFactory implements AnalyzerSessionFactory {
  create(options: AnalyzerSessionOptions): AnalyzerSession {
    return new SyntheticAnalyzerSession(options);
  }
}
