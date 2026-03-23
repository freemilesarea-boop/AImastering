// ── Python bridge & high-level API ────────────────────────────────────────────
export { PythonBridge }  from './utils/pythonBridge.js';
export { analyzeFile }   from './analyzers/index.js';
export { masterFile }    from './mastering/index.js';
export { runQC }         from './qc/index.js';

// ── FFmpeg binary resolution ───────────────────────────────────────────────────
export {
  resolveFFmpegPath,
  resolveFFprobePath,
  resolveFFmpegBinaries,
} from './ffmpeg/resolver.js';

// ── FFmpeg subprocess functions ────────────────────────────────────────────────
export {
  runFFprobe,
  measureLoudnessPass1,
  normalizeLoudnessPass2,
  encodePreviewMp3,
  FFmpegSpawnError,
  FFmpegParseError,
} from './ffmpeg/runner.js';

// ── Startup health check ───────────────────────────────────────────────────────
export { checkFFmpeg }   from './ffmpeg/check.js';

// ── Types ──────────────────────────────────────────────────────────────────────
export type * from './types/index.js';
