// ── Audio ─────────────────────────────────────────────────────────────────────

export type MasteringStyle = 'balanced' | 'warm' | 'bright' | 'punch';

export interface AudioFileInfo {
  path: string;
  name: string;
  sizeBytes: number;
  durationSec: number;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  format: string;
}

export interface LoudnessStats {
  integratedLufs: number;
  truePeakDbtp: number;
  lra: number;
  shortTermMax: number;
}

export interface AIDetectionResult {
  harshHighMid: boolean;
  boomyLowEnd: boolean;
  brickwallCompression: boolean;
  stereoImbalance: boolean;
  silenceAtStart: boolean;
  silenceAtEnd: boolean;
  intersampleRisk: boolean;
  upsampleSuspected: boolean;
}

export interface AudioAnalysisResult {
  fileInfo: AudioFileInfo;
  loudness: LoudnessStats;
  aiDetection: AIDetectionResult;
  dcOffsetDb: number;
  silenceStartMs: number;
  silenceEndMs: number;
}

export interface MasteringOptions {
  style: MasteringStyle;
  targetLufs: number;
  targetTp: number;
  sampleRate: number;
  bitDepth: number;
  applyAiCorrections: boolean;
}

export interface EqMoveReport {
  band: string;
  freqHz: number;
  gainDb: number;
  gainStr: string;
  filter: 'bell' | 'highshelf' | 'lowshelf';
  adaptive: boolean;
}

export interface AnalysisReport {
  eqMoves: EqMoveReport[];
  compressor: {
    style: string;
    thresholdDb: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
    estimatedGrDb: number;
  };
  limiter: {
    ceilingDbtp: number;
    preGainDbtp: number;
    appliedGrDb: number;
    preLimLufs: number;
  };
  loudnorm: {
    targetLufs: number;
    measuredBefore: number;
    gainAppliedDb: number;
  };
  spectralBefore: { lowToMidDb: number; highToMidDb: number } | null;
  spectralAfter:  { lowToMidDb: number; highToMidDb: number } | null;
  loudnessBefore: { integratedLufs: number; truePeakDbtp: number; lra: number };
  loudnessAfter:  { integratedLufs: number; truePeakDbtp: number; lra: number };
}

export interface MasteringResult {
  /** Absolute path to the master WAV. */
  outputPath: string;
  /** Absolute path to the MP3 preview. Always populated on success. */
  previewPath: string;
  appliedCorrections: string[];
  loudnessBefore: { integratedLufs: number; truePeakDbtp: number; lra: number };
  loudnessAfter: LoudnessStats;
  spectralBalance: { lowToMidDb: number; highToMidDb: number } | null;
  analysisReport: AnalysisReport | null;
  pipelineWarnings: Array<{ code: string; level: string; userMessage: string }>;
  processingTimeSec: number;
}

// ── QC ────────────────────────────────────────────────────────────────────────

export type QCStatus = 'pass' | 'warning' | 'fail';

export interface QCItem {
  id: string;
  label: string;
  status: QCStatus;
  message: string;
  value?: string | number;
}

export interface QCResult {
  overall: QCStatus;
  passCount: number;
  totalCount: number;
  items: QCItem[];
  platforms: PlatformTarget[];
}

export interface PlatformTarget {
  name: string;
  targetLufs: number;
  targetTp: number;
  currentLufs: number;
  status: QCStatus;
}

// ── License ───────────────────────────────────────────────────────────────────

export type LicenseTier = 'free' | 'pro';

export interface LicenseInfo {
  tier: LicenseTier;
  trialUsed: number;
  trialMax: number;
  key?: string;
  activatedAt?: string;
  expiresAt?: string;
  canSaveMasterWav: boolean;
  canExportReport: boolean;
  canUseAllPresets: boolean;
}

/** Returned by the license:can-process IPC handler. */
export interface CanProcessResult {
  allowed: boolean;
  isPaid: boolean;
  /** Remaining free-tier uses (Infinity for paid). */
  remaining: number;
  /** Korean-language reason shown in the UI when allowed is false. */
  reason?: string;
}

// ── IPC Channels ──────────────────────────────────────────────────────────────

export const IPC = {
  // Audio
  ANALYZE:  'audio:analyze',
  MASTER:   'audio:master',
  QC:       'audio:qc',
  PROGRESS: 'audio:progress',
  // License
  LICENSE_STATUS:          'license:status',
  LICENSE_ACTIVATE:        'license:activate',
  LICENSE_DEACTIVATE:      'license:deactivate',
  LICENSE_CAN_PROCESS:     'license:can-process',
  LICENSE_DECREMENT_TRIAL: 'license:decrement-trial',
  LICENSE_GET_REMAINING:   'license:get-remaining',
  // Files
  FILE_OPEN:   'file:open-dialog',
  FILE_SAVE:   'file:save-dialog',
  FILE_INFO:   'file:get-info',
  FILE_RECENT: 'file:get-recent',
  FILE_REVEAL: 'file:open-in-finder',
  // Settings
  SETTINGS_GET:        'settings:get',
  SETTINGS_SET:        'settings:set',
  SETTINGS_OUTPUT_DIR: 'settings:choose-output-dir',
  // System
  FFMPEG_STATUS: 'system:ffmpeg-status',
} as const;

export type IPCChannel = typeof IPC[keyof typeof IPC];

// ── Python JSON-RPC ───────────────────────────────────────────────────────────

export interface RPCRequest {
  id: string;
  method: 'analyze' | 'master' | 'qc_check';
  params: Record<string, unknown>;
}

export interface RPCResponse<T = unknown> {
  id: string;
  result?: T;
  error?: { code: number; message: string };
}

export interface RPCProgress {
  type: 'progress';
  jobId: string;
  percent: number;
  stage: string;
}
