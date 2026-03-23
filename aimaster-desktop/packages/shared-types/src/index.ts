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
  harshHighMid: boolean;     // 3–5 kHz energy ratio > 0.28
  boomyLowEnd: boolean;      // 60–200 Hz energy ratio > 0.45
  brickwallCompression: boolean; // LRA < 2.5 LU
  stereoImbalance: boolean;  // L/R RMS diff > 3 dB
  silenceAtStart: boolean;   // > 500 ms
  silenceAtEnd: boolean;     // > 500 ms
  intersampleRisk: boolean;  // true peak > -0.5 dBTP
  upsampleSuspected: boolean; // Nyquist energy heuristic
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
  targetLufs: number;     // default -14
  targetTp: number;       // default -1.0
  sampleRate: number;     // default 44100
  bitDepth: number;       // 16 | 24
  applyAiCorrections: boolean;
}

export interface MasteringResult {
  outputPath: string;       // WAV — empty string for free tier
  previewPath: string;      // MP3 320 kbps — always set
  appliedCorrections: string[];
  loudnessAfter: LoudnessStats;
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

// ── IPC Channels ──────────────────────────────────────────────────────────────

export const IPC = {
  ANALYZE: 'audio:analyze',
  MASTER:  'audio:master',
  QC:      'audio:qc',
  PROGRESS:'audio:progress',
  LICENSE_STATUS:     'license:status',
  LICENSE_ACTIVATE:   'license:activate',
  LICENSE_DEACTIVATE: 'license:deactivate',
  FILE_OPEN:    'file:open-dialog',
  FILE_SAVE:    'file:save-dialog',
  FILE_INFO:    'file:get-info',
  FILE_RECENT:  'file:get-recent',
  FILE_REVEAL:  'file:open-in-finder',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  FFMPEG_STATUS:'system:ffmpeg-status',
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
