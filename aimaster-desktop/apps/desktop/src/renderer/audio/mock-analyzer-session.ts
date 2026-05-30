// Mock AnalyzerSession for Storybook + visual regression testing.
//
// Drives all four streams (tick / full / fft / stereo) with deterministic
// synthetic data — no AudioContext, no WASM, no audio device.  Use this
// in stories and in jsdom test environments.
//
// Differences vs `SyntheticAnalyzerSessionFactory` (which uses the real
// TS LoudnessAnalyzer):
//   • Fully deterministic — no actual signal processing.
//   • Presets compose a timeline of states (idle → playing → loud → clipping).
//   • Configurable tick rate / FFT rate / stereo rate per session.
//   • Loop-on-end for continuous demo playback.
//
// Reference: docs/redesign/loui-mastering-v2/m3-product-next-1/02-MOCK-ANALYZER.md

import type {
  AnalyzerSession,
  AnalyzerSessionFactory,
  AnalyzerSessionOptions,
  AnalyzerUnsubscribe,
  FftFrame,
  MeterSnapshot,
  MeterTickSnapshot,
  StereoAggregateFrame,
  StereoScopeFrame,
  SubscriptionRate,
} from '@aimaster/shared-types/streaming';
import {
  FFT_FRAME_SCHEMA,
  METER_SNAPSHOT_SCHEMA,
  STEREO_SCOPE_FRAME_SCHEMA,
} from '@aimaster/shared-types/streaming';

// ── Timeline state — one "frame" of the playback simulation ──────────────

/**
 * A single keyframe of synthetic analyzer output.  The mock session
 * interpolates between adjacent keyframes to produce smooth animation.
 */
export interface MockKeyframe {
  /** Wall-clock time (seconds) when this keyframe is reached. */
  t: number;
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number;
  loudnessRange: number;
  truePeakDbtp: number;
  samplePeakDb: number;
  rmsDb: number;
  correlation: number;
  msRatioDb: number;
  /** Optional 1/3-oct spectrum shape (30 bins, dB).  Default: pink-like roll-off. */
  spectrumDb?: number[];
  /** Optional categorical hint for the story description block. */
  label?: string;
}

/** Bin centre frequencies used by the mock FFT frame (1/3-oct 25–20k). */
const SPEC_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/** Pink-noise-shaped default spectrum (dB, descending), used when a keyframe omits it. */
const DEFAULT_PINK_SPECTRUM: number[] = SPEC_CENTRES.map((c) => -20 - 3 * Math.log2(c / 1000));

// ── Built-in timelines ──────────────────────────────────────────────────

/** Identifier for the demo presets. */
export type MockPresetId =
  | 'idle'
  | 'spotify-loud'
  | 'ai-harsh'
  | 'warm-acoustic'
  | 'broken-phase'
  | 'clipping-risk'
  | 'mono-safe'
  | 'loading';

export interface MockPreset {
  id: MockPresetId;
  label: string;
  description: string;
  /** Total loop length (seconds).  After t >= loopSec the timeline restarts. */
  loopSec: number;
  /** Keyframes — must be sorted by `t` ascending and end at `loopSec`. */
  keyframes: MockKeyframe[];
}

const STREAMING_TARGET_SPECTRUM = SPEC_CENTRES.map((c) => {
  // Modern pop-mastered curve: sub up, slight mid-scoop, air shelf.
  const log = Math.log2(c / 1000);
  return -16 - 2.5 * log + (c < 100 ? 5 : 0) + (c > 8000 ? 3 : 0);
});

const HARSH_SPECTRUM = SPEC_CENTRES.map((c) => {
  // 3-5 kHz peak, sub rumble, narrow LRA — AI generation defect pattern.
  const log = Math.log2(c / 1000);
  const harsh = c >= 2000 && c <= 5000 ? 8 : 0;
  const rumble = c <= 60 ? 6 : 0;
  return -22 - 2 * log + harsh + rumble;
});

const ACOUSTIC_SPECTRUM = SPEC_CENTRES.map((c) => {
  // Warm-tilted, gentle highs.
  const log = Math.log2(c / 1000);
  return -18 - 4.5 * log + (c < 100 ? 3 : 0) - (c > 10000 ? 4 : 0);
});

/**
 * Canonical demo presets the stories switch between.  All presets loop
 * indefinitely; the mock session keeps the timeline in sync with the
 * wall clock via `performance.now()`.
 */
export const MOCK_PRESETS: Record<MockPresetId, MockPreset> = {
  idle: {
    id: 'idle',
    label: 'Idle',
    description: 'No playback — meters at silence floor.',
    loopSec: 4,
    keyframes: [
      kf(0, { momentaryLufs: -Infinity, shortTermLufs: -Infinity, integratedLufs: -Infinity, loudnessRange: 0, truePeakDbtp: -Infinity, samplePeakDb: -Infinity, rmsDb: -Infinity, correlation: 1, msRatioDb: Infinity, label: 'idle' }),
      kf(4, { momentaryLufs: -Infinity, shortTermLufs: -Infinity, integratedLufs: -Infinity, loudnessRange: 0, truePeakDbtp: -Infinity, samplePeakDb: -Infinity, rmsDb: -Infinity, correlation: 1, msRatioDb: Infinity, label: 'idle' }),
    ],
  },

  'spotify-loud': {
    id: 'spotify-loud',
    label: 'Spotify Loud',
    description: '-14 LUFS streaming-target master, clean stereo, gentle pumping.',
    loopSec: 8,
    keyframes: [
      kf(0, { momentaryLufs: -14.2, shortTermLufs: -14.0, integratedLufs: -14.0, loudnessRange: 6.1, truePeakDbtp: -1.0, samplePeakDb: -1.1, rmsDb: -16.2, correlation: 0.78, msRatioDb: 8.5, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'verse' }),
      kf(2, { momentaryLufs: -13.5, shortTermLufs: -13.7, integratedLufs: -13.9, loudnessRange: 5.8, truePeakDbtp: -1.0, samplePeakDb: -1.1, rmsDb: -15.8, correlation: 0.74, msRatioDb: 7.9, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'pre-chorus' }),
      kf(4, { momentaryLufs: -11.8, shortTermLufs: -12.7, integratedLufs: -13.5, loudnessRange: 5.4, truePeakDbtp: -1.0, samplePeakDb: -1.0, rmsDb: -14.6, correlation: 0.71, msRatioDb: 7.2, spectrumDb: STREAMING_TARGET_SPECTRUM.map((d) => d + 1.5), label: 'chorus' }),
      kf(6, { momentaryLufs: -13.0, shortTermLufs: -13.3, integratedLufs: -13.7, loudnessRange: 5.6, truePeakDbtp: -1.0, samplePeakDb: -1.1, rmsDb: -15.2, correlation: 0.75, msRatioDb: 7.8, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'verse' }),
      kf(8, { momentaryLufs: -14.2, shortTermLufs: -14.0, integratedLufs: -14.0, loudnessRange: 6.1, truePeakDbtp: -1.0, samplePeakDb: -1.1, rmsDb: -16.2, correlation: 0.78, msRatioDb: 8.5, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'verse (loop)' }),
    ],
  },

  'ai-harsh': {
    id: 'ai-harsh',
    label: 'AI Harsh',
    description: 'AI-generated mix with 3-5 kHz peak, sub rumble, brickwall dynamics.',
    loopSec: 6,
    keyframes: [
      kf(0, { momentaryLufs: -8.4, shortTermLufs: -8.7, integratedLufs: -9.0, loudnessRange: 1.5, truePeakDbtp: -0.4, samplePeakDb: -0.2, rmsDb: -10.8, correlation: 0.55, msRatioDb: 5.2, spectrumDb: HARSH_SPECTRUM, label: 'harsh peak' }),
      kf(3, { momentaryLufs: -8.0, shortTermLufs: -8.4, integratedLufs: -8.8, loudnessRange: 1.4, truePeakDbtp: -0.2, samplePeakDb: -0.1, rmsDb: -10.4, correlation: 0.52, msRatioDb: 4.8, spectrumDb: HARSH_SPECTRUM.map((d) => d + 1), label: 'clipping risk' }),
      kf(6, { momentaryLufs: -8.4, shortTermLufs: -8.7, integratedLufs: -9.0, loudnessRange: 1.5, truePeakDbtp: -0.4, samplePeakDb: -0.2, rmsDb: -10.8, correlation: 0.55, msRatioDb: 5.2, spectrumDb: HARSH_SPECTRUM, label: 'harsh peak (loop)' }),
    ],
  },

  'warm-acoustic': {
    id: 'warm-acoustic',
    label: 'Warm Acoustic',
    description: 'Sparse acoustic guitar — high dynamic range, gentle highs, mono-safe.',
    loopSec: 10,
    keyframes: [
      kf(0, { momentaryLufs: -22.0, shortTermLufs: -21.5, integratedLufs: -18.6, loudnessRange: 12.4, truePeakDbtp: -6.4, samplePeakDb: -6.5, rmsDb: -24.2, correlation: 0.94, msRatioDb: 13.2, spectrumDb: ACOUSTIC_SPECTRUM, label: 'sparse intro' }),
      kf(4, { momentaryLufs: -16.3, shortTermLufs: -17.4, integratedLufs: -17.8, loudnessRange: 11.6, truePeakDbtp: -3.1, samplePeakDb: -3.2, rmsDb: -19.5, correlation: 0.92, msRatioDb: 12.4, spectrumDb: ACOUSTIC_SPECTRUM.map((d) => d + 4), label: 'verse strum' }),
      kf(7, { momentaryLufs: -15.1, shortTermLufs: -16.2, integratedLufs: -17.2, loudnessRange: 11.2, truePeakDbtp: -2.5, samplePeakDb: -2.7, rmsDb: -18.4, correlation: 0.91, msRatioDb: 12.0, spectrumDb: ACOUSTIC_SPECTRUM.map((d) => d + 5.5), label: 'chorus' }),
      kf(10, { momentaryLufs: -22.0, shortTermLufs: -21.5, integratedLufs: -18.6, loudnessRange: 12.4, truePeakDbtp: -6.4, samplePeakDb: -6.5, rmsDb: -24.2, correlation: 0.94, msRatioDb: 13.2, spectrumDb: ACOUSTIC_SPECTRUM, label: 'sparse return' }),
    ],
  },

  'broken-phase': {
    id: 'broken-phase',
    label: 'Broken Phase',
    description: 'Phase-flipped channel — correlation negative, mono fold-down would cancel.',
    loopSec: 4,
    keyframes: [
      kf(0, { momentaryLufs: -12.0, shortTermLufs: -12.2, integratedLufs: -12.5, loudnessRange: 5.0, truePeakDbtp: -1.0, samplePeakDb: -1.2, rmsDb: -14.3, correlation: -0.35, msRatioDb: -4.2, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'phase risk' }),
      kf(2, { momentaryLufs: -11.4, shortTermLufs: -11.9, integratedLufs: -12.3, loudnessRange: 4.8, truePeakDbtp: -1.0, samplePeakDb: -1.2, rmsDb: -13.7, correlation: -0.42, msRatioDb: -5.8, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'phase risk +' }),
      kf(4, { momentaryLufs: -12.0, shortTermLufs: -12.2, integratedLufs: -12.5, loudnessRange: 5.0, truePeakDbtp: -1.0, samplePeakDb: -1.2, rmsDb: -14.3, correlation: -0.35, msRatioDb: -4.2, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'phase risk' }),
    ],
  },

  'clipping-risk': {
    id: 'clipping-risk',
    label: 'Clipping Risk',
    description: 'True peak right at the ceiling — limiter on the edge.',
    loopSec: 5,
    keyframes: [
      kf(0, { momentaryLufs: -9.8, shortTermLufs: -9.9, integratedLufs: -10.0, loudnessRange: 3.2, truePeakDbtp: -0.2, samplePeakDb: -0.3, rmsDb: -12.1, correlation: 0.65, msRatioDb: 6.8, spectrumDb: STREAMING_TARGET_SPECTRUM.map((d) => d + 2), label: 'edge of ceiling' }),
      kf(2, { momentaryLufs: -9.2, shortTermLufs: -9.6, integratedLufs: -9.8, loudnessRange: 3.0, truePeakDbtp: -0.05, samplePeakDb: -0.1, rmsDb: -11.4, correlation: 0.62, msRatioDb: 6.2, spectrumDb: STREAMING_TARGET_SPECTRUM.map((d) => d + 3), label: 'just under 0' }),
      kf(5, { momentaryLufs: -9.8, shortTermLufs: -9.9, integratedLufs: -10.0, loudnessRange: 3.2, truePeakDbtp: -0.2, samplePeakDb: -0.3, rmsDb: -12.1, correlation: 0.65, msRatioDb: 6.8, spectrumDb: STREAMING_TARGET_SPECTRUM.map((d) => d + 2), label: 'edge of ceiling' }),
    ],
  },

  'mono-safe': {
    id: 'mono-safe',
    label: 'Mono Safe',
    description: 'L ≈ R; perfect mono fold-down behaviour.',
    loopSec: 4,
    keyframes: [
      kf(0, { momentaryLufs: -14.0, shortTermLufs: -14.2, integratedLufs: -14.0, loudnessRange: 5.5, truePeakDbtp: -1.2, samplePeakDb: -1.3, rmsDb: -16.0, correlation: 0.98, msRatioDb: 24.0, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'mono content' }),
      kf(4, { momentaryLufs: -14.0, shortTermLufs: -14.2, integratedLufs: -14.0, loudnessRange: 5.5, truePeakDbtp: -1.2, samplePeakDb: -1.3, rmsDb: -16.0, correlation: 0.98, msRatioDb: 24.0, spectrumDb: STREAMING_TARGET_SPECTRUM, label: 'mono content' }),
    ],
  },

  loading: {
    id: 'loading',
    label: 'Loading',
    description: 'Session created but not yet emitting frames.',
    loopSec: 60,
    keyframes: [
      // 60 seconds of NaN snapshots so the loading state stays visible.
      kf(0, { momentaryLufs: NaN, shortTermLufs: NaN, integratedLufs: NaN, loudnessRange: NaN, truePeakDbtp: NaN, samplePeakDb: NaN, rmsDb: NaN, correlation: NaN, msRatioDb: NaN, label: 'loading' }),
      kf(60, { momentaryLufs: NaN, shortTermLufs: NaN, integratedLufs: NaN, loudnessRange: NaN, truePeakDbtp: NaN, samplePeakDb: NaN, rmsDb: NaN, correlation: NaN, msRatioDb: NaN, label: 'loading' }),
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function kf(t: number, body: Omit<MockKeyframe, 't'>): MockKeyframe {
  return { t, ...body };
}

function lerp(a: number, b: number, t: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(b) ? b : a;
  return a + (b - a) * t;
}

function lerpArr(a: number[] | undefined, b: number[] | undefined, t: number): number[] | undefined {
  const aArr = a ?? DEFAULT_PINK_SPECTRUM;
  const bArr = b ?? DEFAULT_PINK_SPECTRUM;
  const n = Math.min(aArr.length, bArr.length);
  return Array.from({ length: n }, (_, i) => lerp(aArr[i]!, bArr[i]!, t));
}

function interpolate(preset: MockPreset, elapsedSec: number): MockKeyframe {
  const t = ((elapsedSec % preset.loopSec) + preset.loopSec) % preset.loopSec;
  const kfs = preset.keyframes;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const u = span > 0 ? (t - a.t) / span : 0;
      const lerpedSpectrum = lerpArr(a.spectrumDb, b.spectrumDb, u);
      const out: MockKeyframe = {
        t,
        momentaryLufs:  lerp(a.momentaryLufs, b.momentaryLufs, u),
        shortTermLufs:  lerp(a.shortTermLufs, b.shortTermLufs, u),
        integratedLufs: lerp(a.integratedLufs, b.integratedLufs, u),
        loudnessRange:  lerp(a.loudnessRange, b.loudnessRange, u),
        truePeakDbtp:   lerp(a.truePeakDbtp, b.truePeakDbtp, u),
        samplePeakDb:   lerp(a.samplePeakDb, b.samplePeakDb, u),
        rmsDb:          lerp(a.rmsDb, b.rmsDb, u),
        correlation:    lerp(a.correlation, b.correlation, u),
        msRatioDb:      lerp(a.msRatioDb, b.msRatioDb, u),
      };
      if (lerpedSpectrum) out.spectrumDb = lerpedSpectrum;
      if (a.label !== undefined) out.label = a.label;
      return out;
    }
  }
  return kfs[kfs.length - 1]!;
}

// ── Mock session implementation ──────────────────────────────────────────

interface Subscription<T> {
  rate?: SubscriptionRate;
  cb: (t: T) => void;
  lastEmit: number;
}

function rateToMs(rate: SubscriptionRate): number {
  switch (rate) {
    case 'audio': return 16;
    case '60Hz':  return 16;
    case '30Hz':  return 33;
    case '10Hz':  return 100;
    default:      return 100;
  }
}

export interface MockSessionOptions extends AnalyzerSessionOptions {
  /** Which preset timeline drives this session. */
  preset: MockPresetId | MockPreset;
  /** Tick advance step (ms).  Default 50.  Smaller = smoother animation. */
  stepMs?: number;
  /** Wall clock offset (s) — start mid-loop.  Default 0. */
  startAtSec?: number;
}

class MockAnalyzerSession implements AnalyzerSession {
  readonly options: AnalyzerSessionOptions;
  isRunning = false;

  private preset: MockPreset;
  private stepMs: number;
  private startedAt = 0;
  private startOffsetSec: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private tickSubs:   Subscription<MeterTickSnapshot>[] = [];
  private fullSubs:   Subscription<MeterSnapshot>[]     = [];
  private fftSubs:    Subscription<FftFrame>[]          = [];
  private stereoSubs: Subscription<StereoScopeFrame>[]  = [];
  private samplesProcessed = 0;
  private lastFullAt = 0;
  private lastFftAt = 0;
  private lastStereoAt = 0;

  constructor(options: MockSessionOptions) {
    this.options = {
      sampleRate: options.sampleRate,
      channels:   options.channels,
      ...(options.peakRmsWindowSec !== undefined && { peakRmsWindowSec: options.peakRmsWindowSec }),
      ...(options.stereoWindowSec  !== undefined && { stereoWindowSec:  options.stereoWindowSec  }),
    };
    this.preset = typeof options.preset === 'string'
      ? MOCK_PRESETS[options.preset]
      : options.preset;
    this.stepMs = options.stepMs ?? 50;
    this.startOffsetSec = options.startAtSec ?? 0;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = performance.now();
    this.timer = setInterval(() => this.advance(), this.stepMs);
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
    const elapsed = (performance.now() - this.startedAt) / 1000 + this.startOffsetSec;
    const k = interpolate(this.preset, elapsed);
    return this.buildFullSnapshot(k);
  }

  async reset(): Promise<void> {
    this.startedAt = performance.now();
    this.samplesProcessed = 0;
  }

  /** Swap the preset live.  Subsequent ticks reflect the new timeline. */
  setPreset(preset: MockPresetId | MockPreset): void {
    this.preset = typeof preset === 'string' ? MOCK_PRESETS[preset] : preset;
    this.startedAt = performance.now();
  }

  /** Active preset (for story header). */
  activePreset(): MockPreset {
    return this.preset;
  }

  // ── Internal: drive the simulation. ──────────────────────────────────

  private advance(): void {
    const now = performance.now();
    const elapsed = (now - this.startedAt) / 1000 + this.startOffsetSec;
    const k = interpolate(this.preset, elapsed);

    // Simulated samples processed — assumes nominal SR.
    this.samplesProcessed += Math.round(this.options.sampleRate * this.stepMs / 1000);

    const tick: MeterTickSnapshot = {
      schema: METER_SNAPSHOT_SCHEMA,
      sampleRate: this.options.sampleRate,
      channels: this.options.channels,
      samplesProcessed: this.samplesProcessed,
      integratedLufs: Number.NaN,
      loudnessRange:  Number.NaN,
      gatedBlocks: 0,
      shortTermLufs: k.shortTermLufs,
      momentaryLufs: k.momentaryLufs,
      truePeakDbtp:  k.truePeakDbtp,
      samplePeakDb:  k.samplePeakDb,
      rmsDb:         k.rmsDb,
      correlation:   k.correlation,
      msRatioDb:     k.msRatioDb,
    };

    for (const sub of this.tickSubs) {
      const period = rateToMs(sub.rate ?? '10Hz');
      if (now - sub.lastEmit >= period) {
        sub.cb(tick);
        sub.lastEmit = now;
      }
    }

    if (this.fullSubs.length && now - this.lastFullAt >= 1000) {
      this.lastFullAt = now;
      const full = this.buildFullSnapshot(k);
      for (const sub of this.fullSubs) sub.cb(full);
    }

    if (this.fftSubs.length && now - this.lastFftAt >= 33) {
      this.lastFftAt = now;
      const mag = k.spectrumDb ?? DEFAULT_PINK_SPECTRUM;
      const frame: FftFrame = {
        schema: FFT_FRAME_SCHEMA,
        sampleRate: this.options.sampleRate,
        samplesProcessed: this.samplesProcessed,
        fftSize: 2048,
        binCentresHz: SPEC_CENTRES,
        magnitudeDb: mag,
        peakHoldDb:  mag.map((d) => d + 3),
      };
      for (const sub of this.fftSubs) sub.cb(frame);
    }

    if (this.stereoSubs.length && now - this.lastStereoAt >= 33) {
      this.lastStereoAt = now;
      const frame: StereoAggregateFrame = {
        schema: STEREO_SCOPE_FRAME_SCHEMA,
        correlation: k.correlation,
        msRatioDb:   k.msRatioDb,
        widthIndex:  Math.max(0, 1 - k.correlation * 0.5) * 2,
        windowFrames: this.options.sampleRate,
      };
      for (const sub of this.stereoSubs) sub.cb(frame);
    }
  }

  private buildFullSnapshot(k: MockKeyframe): MeterSnapshot {
    return {
      schema: METER_SNAPSHOT_SCHEMA,
      sampleRate: this.options.sampleRate,
      channels: this.options.channels,
      samplesProcessed: this.samplesProcessed,
      integratedLufs: k.integratedLufs,
      shortTermLufs:  k.shortTermLufs,
      momentaryLufs:  k.momentaryLufs,
      loudnessRange:  k.loudnessRange,
      truePeakDbtp:   k.truePeakDbtp,
      samplePeakDb:   k.samplePeakDb,
      rmsDb:          k.rmsDb,
      correlation:    k.correlation,
      msRatioDb:      k.msRatioDb,
      gatedBlocks:    0,
    };
  }
}

/**
 * Factory that produces a MockAnalyzerSession bound to a specific preset.
 * Created via the helper `mockFactory(preset)`.
 */
class MockAnalyzerSessionFactory implements AnalyzerSessionFactory {
  constructor(private readonly preset: MockPresetId | MockPreset) {}
  create(options: AnalyzerSessionOptions): AnalyzerSession {
    return new MockAnalyzerSession({
      sampleRate: options.sampleRate,
      channels: options.channels,
      ...(options.peakRmsWindowSec !== undefined && { peakRmsWindowSec: options.peakRmsWindowSec }),
      ...(options.stereoWindowSec  !== undefined && { stereoWindowSec:  options.stereoWindowSec  }),
      preset: this.preset,
    });
  }
}

/** Build a factory bound to a named preset. */
export function mockFactory(preset: MockPresetId | MockPreset): AnalyzerSessionFactory {
  return new MockAnalyzerSessionFactory(preset);
}

/**
 * Direct session constructor — bypasses the factory layer when a story
 * wants explicit lifecycle control (e.g., to call `setPreset()` for
 * live timeline switching).
 */
export function createMockSession(options: MockSessionOptions): MockAnalyzerSession {
  return new MockAnalyzerSession(options);
}

export type { MockAnalyzerSession };
