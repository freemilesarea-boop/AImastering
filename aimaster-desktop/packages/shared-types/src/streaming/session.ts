// Analyzer session lifecycle + subscription API.
//
// Implementation lives in either:
//   • Electron renderer (WASM build of loui-dsp-wasm in an AudioWorklet)
//   • Electron main (N-API build of loui-dsp-node)
//   • Future: web app (WASM only)
//
// The interface defined here is **transport-independent** — the same code
// in a React hook can subscribe via either binding.  The bridge layer
// (next M2-lite-NEXT-NEXT) picks one based on context.

import type { MeterTickSnapshot, MeterSnapshot } from './meter-snapshot.js';
import type { FftFrame } from './fft-frame.js';
import type { StereoScopeFrame } from './stereo-scope-frame.js';

/** Analyzer construction parameters. */
export interface AnalyzerSessionOptions {
  /** Sample rate of audio that will be fed in (Hz). */
  sampleRate: number;
  /** Channel count.  1 or 2 supported by M2-lite. */
  channels: 1 | 2;
  /** Sliding-window length for peak/RMS meter (seconds).  Default 1.0. */
  peakRmsWindowSec?: number;
  /** Sliding-window length for stereo meter (seconds).  Default 1.0. */
  stereoWindowSec?: number;
}

/** Subscription handle returned by `on*` calls.  Calling `()` unsubscribes. */
export type AnalyzerUnsubscribe = () => void;

/** Subscription cadence hints.  The bridge throttles to this rate. */
export type SubscriptionRate =
  | 'audio'     // every block — only safe for `tick` snapshots
  | '60Hz'      // ≈ 16 ms — UI default
  | '30Hz'      // ≈ 33 ms — spectrum default
  | '10Hz';     // ≈ 100 ms — meter default

/** Analyzer session — transport-independent interface. */
export interface AnalyzerSession {
  /** Construction-time options.  Read-only after `start()`. */
  readonly options: AnalyzerSessionOptions;
  /** Whether the session is currently consuming audio. */
  readonly isRunning: boolean;

  /** Start a new session.  Idempotent if already running. */
  start(): Promise<void>;

  /** Stop the session — call before discarding the handle. */
  stop(): Promise<void>;

  /** Subscribe to meter snapshots (light, audio-thread safe). */
  onTickSnapshot(rate: SubscriptionRate, cb: (snap: MeterTickSnapshot) => void): AnalyzerUnsubscribe;

  /** Subscribe to full snapshots (integrated LUFS + LRA).  Throttled to ≤ 5 Hz. */
  onFullSnapshot(cb: (snap: MeterSnapshot) => void): AnalyzerUnsubscribe;

  /** Subscribe to FFT frames for a spectrum visualiser. */
  onFftFrame(cb: (frame: FftFrame) => void): AnalyzerUnsubscribe;

  /** Subscribe to stereo scope frames. */
  onStereoFrame(cb: (frame: StereoScopeFrame) => void): AnalyzerUnsubscribe;

  /**
   * Request a full snapshot immediately (off the audio thread).  Returns
   * the snapshot value rather than emitting on the `onFullSnapshot` stream.
   * Useful at end-of-track / "Export" button click.
   */
  requestSnapshot(): Promise<MeterSnapshot>;

  /** Reset analyzer state (e.g. on track change). */
  reset(): Promise<void>;
}

/**
 * Factory abstract type — concrete implementations live in:
 *   • apps/desktop/src/renderer/audio/analyzer-session-wasm.ts (M3 wiring)
 *   • apps/desktop/src/main/analyzer-session-napi.ts            (M3 wiring)
 *   • apps/web/src/audio/analyzer-session-wasm.ts                (future)
 *
 * The bridge module (also M3) picks the appropriate implementation based
 * on the host environment.
 */
export interface AnalyzerSessionFactory {
  create(options: AnalyzerSessionOptions): AnalyzerSession;
}
