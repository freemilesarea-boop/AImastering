// ── Audio ─────────────────────────────────────────────────────────────────────

/**
 * Mastering 모드.
 * v3 추가: natural / loud / kpop_loud
 * v2 호환: balanced / warm / bright / punch
 */
export type MasteringStyle =
  | 'natural'
  | 'balanced'
  | 'bright'
  | 'loud'
  | 'kpop_loud'
  | 'warm'
  | 'punch';

/** Brickwall limiter 입력 게인 강도. */
export type LimiterStrength = 'low' | 'medium' | 'high';

/** UI 모드 카드 데이터. */
export interface MasteringModePreset {
  id: MasteringStyle;
  name: string;
  hint: string;
  detail: string;
  targetLufs: number;
  targetTp: number;
  limiterStrength: LimiterStrength;
  legacy?: boolean;
}

export const MASTERING_MODES: MasteringModePreset[] = [
  {
    id: 'natural', name: 'Natural', hint: '원본 보존',
    detail: '약한 EQ + 약한 컴프. AI 원음을 거의 그대로 유지.',
    targetLufs: -14, targetTp: -1.0, limiterStrength: 'low',
  },
  {
    id: 'balanced', name: 'Balanced', hint: '범용',
    detail: '적당한 EQ/comp/saturation. 일반 발매용 기본값.',
    targetLufs: -12, targetTp: -1.0, limiterStrength: 'medium',
  },
  {
    id: 'bright', name: 'Bright', hint: '선명한',
    detail: '고역 선명도. 과압축 없음 / air band 보존.',
    targetLufs: -12, targetTp: -1.0, limiterStrength: 'medium',
  },
  {
    id: 'loud', name: 'Loud', hint: '음압 강화',
    detail: 'soft clipping + limiter 적극. 다이나믹 손상 가능.',
    targetLufs: -10, targetTp: -1.0, limiterStrength: 'high',
  },
  {
    id: 'kpop_loud', name: 'KPOP Loud', hint: '체감 볼륨',
    detail: 'low-end 정리 + mid/high clarity + 강한 limiter.',
    targetLufs: -9, targetTp: -0.8, limiterStrength: 'high',
  },
  {
    id: 'warm', name: 'Warm', hint: '따뜻한',
    detail: '고역 자극 완화 (legacy).',
    targetLufs: -14, targetTp: -1.0, limiterStrength: 'low', legacy: true,
  },
  {
    id: 'punch', name: 'Punch', hint: '강한 저음',
    detail: '저역 밀도 + 타격감 (legacy).',
    targetLufs: -11, targetTp: -1.0, limiterStrength: 'high', legacy: true,
  },
];

/** YouTube/Streaming/KPOP/EDM 등 빠른 프리셋. */
export interface MasteringQuickPreset {
  id: string;
  name: string;
  description: string;
  style: MasteringStyle;
  targetLufs: number;
  targetTp: number;
  limiterStrength: LimiterStrength;
}

export const MASTERING_QUICK_PRESETS: MasteringQuickPreset[] = [
  { id: 'youtube_safe',   name: 'YouTube Safe',   description: '-14 LUFS / -1.0 dBTP',
    style: 'balanced',  targetLufs: -14, targetTp: -1.0, limiterStrength: 'low'    },
  { id: 'streaming_loud', name: 'Streaming Loud', description: '-11 LUFS / -1.0 dBTP',
    style: 'balanced',  targetLufs: -11, targetTp: -1.0, limiterStrength: 'medium' },
  { id: 'kpop_loud',      name: 'KPOP Loud',      description: '-9 LUFS / -0.8 dBTP',
    style: 'kpop_loud', targetLufs: -9,  targetTp: -0.8, limiterStrength: 'high'   },
  { id: 'edm_loud',       name: 'EDM Loud',       description: '-8 LUFS / -0.5 dBTP',
    style: 'loud',      targetLufs: -8,  targetTp: -0.5, limiterStrength: 'high'   },
];

export const LIMITER_STRENGTH_LABELS: Record<LimiterStrength, string> = {
  low:    'Low',
  medium: 'Medium',
  high:   'High',
};

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
  /** v3 — limiter 강도 (low/medium/high). 누락 시 medium. */
  limiterStrength?: LimiterStrength;
  /** v3 — saturation 강도 (0~1). undefined = 모드 기본값. */
  saturationAmount?: number;
  /** v3 — stereo width (1.0 = 그대로). undefined = 모드 기본값. */
  stereoWidth?: number;
  /** v3 — output gain dB (-6~+6). 누락 시 0. */
  outputGainDb?: number;
}

export interface EqMoveReport {
  band: string;
  freqHz: number;
  gainDb: number;
  gainStr: string;
  filter: 'bell' | 'highshelf' | 'lowshelf';
  adaptive: boolean;
}

/** v3 — 마스터링 메타 (목표값/적용 게인/리미터 압축 등). */
export interface MasteringMeta {
  mode: MasteringStyle | string;
  targetLufs: number;
  targetTruePeak: number;
  limiterStrength: LimiterStrength;
  appliedGainDb: number;
  limiterReductionDb: number;
  correctionApplied: boolean;
  correctionGainDb: number;
  /**
   * v3.2 — Inter-Sample Peak safety post-processor 가 적용한 정적 down-gain (dB).
   * 0 = 적용 없음. 음수 값 = ceiling 초과 ISP 를 잡기 위해 적용된 게인 감소.
   */
  ispCorrectionDb?: number;
  /**
   * v3.2 — high-LUFS 모드 (loud, kpop_loud) 에서 dynamic loudnorm 의 envelope
   * 출렁임을 막기 위해 사용한 정적 체인 (volume= 정적 게인 매칭) 여부.
   * true 이면 loudnorm pass2 가 사용되지 않고, pre_lufs 측정값 + volume 노드로
   * 정적 매칭이 적용됨. false 이면 기존 loudnorm 2-pass.
   */
  staticChain?: boolean;
  useLinearLoudnorm: boolean;
  targetReached: boolean;
}

export interface AnalysisReport {
  /** v3 — Mastering 모드/목표/실제 결과 메타. */
  mastering?: MasteringMeta;
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

/**
 * v3.2 P2 — before/after metric 비교 row.  UI 가 표 형태로 표시.
 * status: ok = 안전 / warn = 주의 / danger = 재마스터링 권장
 */
export interface MetricComparisonRow {
  key: string;
  label: string;
  unit: string;
  before: number | string | null;
  after:  number | string | null;
  delta:  number | null;
  status: 'ok' | 'warn' | 'danger';
  hint:   string;
}

/** v3.2 P2 — 마스터링 결과 자동 품질 검사 한 항목. */
export interface QualityCheckItem {
  name:    string;
  status:  'ok' | 'warn' | 'danger';
  message: string;
  value?:  number | string | Record<string, unknown> | null;
}

/** v3.2 P2 — 마스터링 결과 자동 품질 검사 리포트. */
export interface QualityCheckReport {
  overall: 'ok' | 'warn' | 'danger';
  summary: string;
  items:   QualityCheckItem[];
}

/** v3.2 P3 — 적용된 Dynamic EQ 한 밴드. */
export interface DynamicEqBand {
  name:      string;
  label:     string;
  freq:      number;
  q:         number;
  threshold: number;
  reduction: number;
  mode:      'cut' | 'boost';
  engine:    'adynamicequalizer' | 'fallback';
}

/** v3.2 P3 — Dynamic EQ 리포트. */
export interface DynamicEqReport {
  preset: string | null;
  engine: 'adynamicequalizer' | 'fallback' | 'none';
  bands:  DynamicEqBand[];
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
  /**
   * v3.2 P2 — before/after waveform PNG 절대 경로.
   * 생성 실패 / generate_waveforms=false 일 때는 누락.
   */
  beforeWaveformPath?:  string;
  afterWaveformPath?:   string;
  compareWaveformPath?: string;
  /**
   * v3.2 P2 — before/after metric 비교 (UI 표 직접 렌더링).
   */
  metricComparison?: MetricComparisonRow[];
  /**
   * v3.2 P2 — 마스터링 결과 자동 품질 검사 (TP / pumping / clipping / 과압축 / drop).
   */
  qualityCheck?: QualityCheckReport;
  /**
   * v3.2 P3 — 적용된 Dynamic EQ 리포트.
   */
  dynamicEq?: DynamicEqReport;

  // ────────────────────────────────────────────────────────────────────────
  // v3.3 — Debug-quality system (vocal-mush / radio-quality / over-limiting).
  // ────────────────────────────────────────────────────────────────────────
  /** Limiter 과다 적용 자동 검사 결과. */
  limiterCheck?: LimiterCheckReport;
  /** 시간대별 의심 구간 (excessive_limiter_reduction / brickwall_flat / sudden_rms_drop). */
  suspectSegments?: SuspectSegment[];
  /** 시간 시리즈 분석 요약 (per-window 데이터는 debug bundle 에만). */
  segmentAnalysis?: { windowSec: number; summary: SegmentSummary | null; windowCount: number };
  /** 위험 신호에 따른 모드 추천 — UI banner / chip 으로 노출. */
  modeRecommendations?: ModeRecommendation[];
  /** 입력 파일 메타데이터 (codec / sampleRate / VBR-CBR 등). */
  inputFileInfo?: InputFileInfo;
  /** DebugRecorder summary — debug bundle export 시 그대로 전달. */
  debugSummary?: DebugSummary;
  /** Safe-mode 가 적용된 경우 사용자가 선택한 모드 키 echo. */
  appliedSafeModes?: string[];
  /**
   * v3.3 — gain-staging report.  매 단계 적용된 dB 와 vocal/background
   * band 변화를 추적해 "메인 멜로디 눌리고 배경 커진" 문제를 자동 진단.
   */
  gainStaging?: GainStagingReport;
}

export interface GainStagingReport {
  stages: {
    compressorMakeupDb: number;
    preGainDb:          number;     // entry-gain push in static chain
    limiterInputGainDb: number;
    correctionGainDb:   number;
    ispCorrectionDb:    number;
    totalAppliedGainDb: number;
  };
  bandsBefore:        Record<string, number>;
  bandsAfter:         Record<string, number>;
  bandDeltaDb:        Record<string, number>;
  vocalLossDb:        number | null;
  backgroundRiseDb:   number | null;
  crestFactorDropPct: number | null;
  lraDropPct:         number | null;
  verdict:            'ok' | 'warn' | 'danger';
  issues:             string[];
  recommendations:    string[];
  available:          boolean;
}

// ── Debug-quality system shared types ────────────────────────────────────────

export interface InputFileInfo {
  path: string | null;
  name: string | null;
  codec: string;
  codecLongName?: string | null;
  sampleRate: number;
  channels: number;
  channelLayout?: string | null;
  bitDepth: number;
  sampleFmt?: string | null;
  bitRateBps: number | null;
  sizeBytes: number | null;
  durationSec: number;
  containerFormat: string;
  containerLongName?: string;
  vbrCbr: 'CBR' | 'VBR' | 'VBR-suspected' | 'unknown' | null;
  encoderTag?: string | null;
}

export interface SuspectSegment {
  start: number;
  end: number;
  reason:
    | 'excessive_limiter_reduction'
    | 'brickwall_flat'
    | 'sudden_rms_drop'
    | 'tight_crest'
    | string;
  severity: 'info' | 'warn' | 'danger';
  details: string;
}

export interface SegmentSummary {
  rmsP05: number;
  rmsP50: number;
  rmsP95: number;
  rmsSpread: number;
  minCrestDb: number;
  ceilingAttachedFrac: number;
}

export interface LimiterCheckItem {
  name: string;
  status: 'ok' | 'warn' | 'danger';
  message: string;
  value: number | string | null;
}

export interface LimiterCheckReport {
  overall: 'ok' | 'warn' | 'danger';
  items: LimiterCheckItem[];
  metrics: {
    crestDelta?: number | null;
    lraReductionRatio?: number;
    ceilingAttachedFrac?: number;
    brickwallSampleRatio?: number;
    lufsOvershoot?: number;
    ispCorrectionDb?: number;
  };
  recommendations: string[];
}

export interface ModeRecommendation {
  mode: 'safe' | 'vocal_safe' | 'low_limit' | 'convert_to_wav' | string;
  reason: string;
  severity: 'info' | 'warn' | 'danger';
  evidence: string[];
}

export interface DebugSummary {
  jobId: string;
  debugMode: boolean;
  elapsedSec: number;
  ffmpegInvocations: number;
  stages: string[];
  warnings: Array<{ t: number; level: string; msg: string; data?: unknown }>;
  errors:   Array<{ t: number; level: string; msg: string; data?: unknown }>;
  filterChain: Record<string, unknown>;
  limiterQc:   Record<string, unknown>;
  suspectSegments: SuspectSegment[];
  recommendations: ModeRecommendation[];
  artifactDir: string | null;
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
