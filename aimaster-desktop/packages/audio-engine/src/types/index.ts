export type {
  AudioFileInfo,
  AudioAnalysisResult,
  MasteringOptions,
  MasteringResult,
  QCResult,
  RPCRequest,
  RPCResponse,
  RPCProgress,
  MasteringStyle,
} from '@aimaster/shared-types';

// ── FFmpeg status (startup health check) ──────────────────────────────────────

export interface FFmpegStatus {
  available: boolean;
  version?: string;
  path?: string;
  ffprobeAvailable: boolean;
}

// ── Python bridge ─────────────────────────────────────────────────────────────

export interface PythonBridgeOptions {
  pythonPath: string;
  scriptPath: string;
  timeoutMs?: number;
}

// ── FFmpeg runner types (re-exported for consumers) ───────────────────────────

export type {
  LoudnormMeasurements,
  FFprobeResult,
  RunnerOptions,
  Pass1Options,
  Pass2Options,
  EncodeOptions,
} from '../ffmpeg/runner.js';

export type { ResolveBinOptions } from '../ffmpeg/resolver.js';

// ── FFmpeg runner errors (re-exported so callers can instanceof-check) ─────────

export { FFmpegSpawnError, FFmpegParseError } from '../ffmpeg/runner.js';
