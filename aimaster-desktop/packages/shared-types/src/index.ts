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
  /** v3 — dynamic EQ intensity (0=off, 1=full). 누락 시 1.0. */
  dynamicEqIntensity?: number;
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
  /**
   * v3.3.1 — vocal-protection 엔진 가드 결과.
   * 항상 활성이며, 모드 무관 보컬 명료도 우선.
   */
  vocalProtection?: VocalProtectionReport;

  /** v3.4 — Ozone-style reference matching result */
  referenceMatch?:    ReferenceMatchReport;
  referenceProfile?:  ReferenceProfile;
  targetProfile?:     TargetProfile;
  appliedBandCorrections?: AppliedBandCorrection[];
  /** v3.4.1 — reference validation + genre-mismatch warnings */
  referenceWarnings?: ReferenceWarning[];

  // ────────────────────────────────────────────────────────────────────────
  // Phase-D — Song-level intelligence (read-only metadata for the UI).
  // All fields are OPTIONAL: the UI must render even when none are present.
  // ────────────────────────────────────────────────────────────────────────
  /** Verse / chorus / bridge timeline + dynamic-range / alternation metrics. */
  sectionAnalysis?:   SectionAnalysis;
  /** Heuristic AI-artifact findings (phase / metallic / sub-rumble). */
  aiArtifactCheck?:   AIArtifactCheck;
  /** Vocal mood + clarity intelligence. */
  vocalIntelligence?: VocalIntelligence;
  /** Predicted translation across phone / laptop / club. */
  translationCheck?:  TranslationCheck;
  /** Best-fit mastering mode suggestion based on the song itself. */
  modeSuggestion?:    ModeSuggestion;
}

export interface ReferenceWarning {
  code: string;
  severity: 'info' | 'warn' | 'danger';
  userMessage: string;
}

export interface ReferencePreset {
  key: string;
  label: string;
  description: string;
  bestFor: string;
  targetLufs: number;
  targetLra: number;
}

export interface ReferencePresetRecommendation {
  key: string;
  label: string;
  reason: string;
  targetLufs: number;
}

// ── v3.4 Reference matching shared types ────────────────────────────────────

export interface BandEnergies {
  low:   number;
  mid:   number;
  vocal: number;
  high:  number;
}

export interface ReferenceProfile {
  path:           string;
  durationSec:    number;
  integratedLufs: number;
  truePeakDbtp:   number;
  lra:            number;
  samplePeakDb:   number;
  rmsDb:          number;
  crestDb:        number;
  bands:          BandEnergies;
  stereoWidth:    number | null;
  lrCorrelation:  number | null;
  available:      boolean;
}

export interface TargetProfile {
  targetLufs:        number;
  targetTruePeak:    number;
  targetLra:         number;
  targetBands:       BandEnergies;
  targetStereoWidth: number | null;
  targetCrestDb:     number;
  sourceReferencePath: string;
}

export interface AppliedBandCorrection {
  band:        'low' | 'mid' | 'vocal' | 'high';
  rangeHz:     [number, number];
  centreHz:    number;
  q:           number;
  requestedDb: number;
  appliedDb:   number;
}

export interface ReferenceMatchReport {
  /** 0–100 weighted overall match score */
  overall: number | null;
  perAxis: {
    lufs:     number | null;
    lra:      number | null;
    truePeak: number | null;
    bands: {
      low:   number | null;
      mid:   number | null;
      vocal: number | null;
      high:  number | null;
    };
    stereoWidth: number | null;
    weakestAxis: string | null;
  };
  weakestAxis:     string | null;
  iterations:      number;
  maxIterations:   number;
  perIteration: Array<{
    iteration:    number;
    scoreOverall: number | null;
    outputLufs:   number;
    outputLra:    number;
    elapsedSec:   number;
  }>;
  acceptThreshold: number;
  stoppedReason:   'accept_threshold_met' | 'no_significant_improvement' | 'max_iterations_reached' | 'no_iterations';
}

export interface VocalProtectionClamp {
  where:    string;
  original: unknown;
  clamped:  unknown;
  reason:   string;
}

export interface VocalProtectionReport {
  enabled:               boolean;
  active:                boolean;     // true if any clamp was applied
  appliedClamps:         VocalProtectionClamp[];
  vocalLossDb:           number | null;
  vocalLossSeverity:     'ok' | 'warn' | 'danger';
  autoFallbackTriggered: boolean;
  autoFallbackReason:    string;
  userMessage:           string;
  config: {
    vocalBandHz:           [number, number];
    maxVocalBandCutDb:     number;
    maxRatio:              number;
    minAttackMs:           number;
    maxMakeupDb:           number;
    maxEntryGainDb:        number;
    maxLimiterInputGainDb: number;
  };
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

// ── Phase-D — Song-level intelligence ────────────────────────────────────────
//
// These types describe *analysis* results, not DSP actions.  They are
// produced by Phase-D analyzers (no new DSP) and consumed by the Phase-E
// UI layer.  Every field is optional so a partially-populated result still
// renders cleanly.  Severities use a conservative vocabulary
// ('possible', 'detected pattern', 'may') — the UI layer must not promise
// detection it has not actually performed.

export type SectionKind = 'verse' | 'chorus' | 'bridge' | 'intro' | 'outro' | 'drop' | 'breakdown' | 'unknown';

/** Energy bucket assigned by the section analyzer. */
export type SectionEnergy = 'low' | 'mid' | 'high';

export interface SectionSegment {
  /** Section start in seconds from the beginning of the track. */
  start:  number;
  /** Section end in seconds. */
  end:    number;
  /** Detected role (verse / chorus / bridge…). */
  kind:   SectionKind;
  /** Coarse energy bucket relative to the track. */
  energy: SectionEnergy;
  /** Optional human label, e.g. "Chorus 2". */
  label?: string;
}

export interface SectionAnalysis {
  /** Detected sections in chronological order.  Empty = analysis ran but found nothing. */
  sections:        SectionSegment[];
  /** Track-level dynamic range across sections, in LU. */
  dynamicRangeLu:  number | null;
  /**
   * 0–1 score for verse/chorus alternation.
   * Higher = stronger contrast between sections.
   */
  alternationScore: number | null;
  /** Counts derived from `sections`, exposed for cheap UI rendering. */
  sectionCounts: {
    high: number;
    mid:  number;
    low:  number;
  };
  /**
   * If the analyzer believes a different mastering mode would suit the song
   * better than the user's current selection, this is populated.  The UI
   * shows it ONLY when it differs from `currentMode`.
   */
  modeSuggestion?: ModeSuggestion;
}

export type AIArtifactSeverity = 'info' | 'warn' | 'danger';

/**
 * One artifact finding.  `present === false` means the analyzer ran and
 * found no anomaly — the UI should hide such entries instead of showing
 * an "all good" check (we only surface possible issues).
 */
export interface AIArtifactFinding {
  present:    boolean;
  severity:   AIArtifactSeverity;
  /** Human-readable Korean explanation, conservative wording. */
  message:    string;
  /** Optional confidence 0–1.  UI must NOT fabricate this. */
  confidence?: number;
}

export interface AIArtifactCheck {
  /** L/R phase anomaly (collapse on mono playback, mirrored content, …). */
  phaseAnomaly?:       AIArtifactFinding;
  /** Metallic high-frequency artifact (typical 4–7 kHz AI signature). */
  metallicHighFreq?:   AIArtifactFinding;
  /** Sub-bass rumble below ~30 Hz that translates poorly. */
  subRumble?:          AIArtifactFinding;
  /** Optional analyzer build / version tag, useful for the export report. */
  analyzerVersion?:    string;
}

/** Vocal-track intelligence (instrument-aware; safe-no-op for instrumentals). */
export interface VocalIntelligence {
  /** True if the analyzer is confident a vocal is present. */
  vocalPresent:    boolean;
  /** 0–1 clarity / intelligibility estimate. */
  clarityScore:    number | null;
  /** Mood label, e.g. 'warm', 'aggressive', 'breathy'. */
  mood?:           string;
  /** Sibilance hot-spot frequency (Hz) if detected. */
  sibilanceHz?:    number | null;
  /** Conservative Korean note shown beneath the score. */
  note?:           string;
}

/** Predicted translation across reference playback systems. */
export interface TranslationCheck {
  /** 0–1 score per device.  null = not analyzed. */
  phone:    number | null;
  laptop:   number | null;
  club:     number | null;
  /** Korean note, e.g. "전화기 스피커에서 저역이 약하게 들릴 수 있습니다." */
  notes?:   string[];
}

/** Best-fit mastering-mode suggestion produced by the song-intelligence layer. */
export interface ModeSuggestion {
  /** Mode the analyzer thinks fits the song best. */
  suggestedMode: MasteringStyle | string;
  /** Mode the user is currently mastering with (echoed for UI comparison). */
  currentMode:   MasteringStyle | string;
  /** Conservative Korean reason. */
  reason:        string;
  /** 0–1 confidence (optional). */
  confidence?:   number;
}

// ── Preview re-render IPC contract (M3-P-NEXT-5C) ─────────────────────────
//
// The product layout stages UI parameter changes into a render override.
// When the user clicks "Update Preview", the renderer sends a
// PreviewRenderRequest; the main process re-runs the EXISTING Python
// preview render with the merged options and returns a new preview path.
// No Python pipeline change — this reuses the same `masterFile` path the
// initial master uses.

/** Request to re-render the preview with an options override. */
export interface PreviewRenderRequest {
  /** Monotonic id for latest-wins / stale-response rejection. */
  requestId: number;
  /** Original source audio path (the file the master was made from). */
  sourceAudioPath: string;
  /** Full mastering options to render with (base merged with the override). */
  options: MasteringOptions;
  /**
   * The subset of `options` that changed vs the last render — informational,
   * surfaced in logs so the handler / dev UI can see what drove the render.
   */
  changedKeys: string[];
  /** Deterministic hash of the renderable override (dedup / stale checks). */
  patchHash?: string;
  /** MasteringOptions keys actually applied as overrides this render. */
  appliedOverrideKeys?: string[];
  /** UI parameter ids staged but NOT applied (no renderable mapping). */
  skippedParameterIds?: string[];
  /** Short human summary of the target (e.g. "−10 LUFS · −1.0 dBTP"). */
  targetSummary?: string;
}

/** Successful preview re-render. */
export interface PreviewRenderSuccess {
  requestId: number;
  ok: true;
  /** Path to the freshly-rendered preview audio (MP3). */
  previewPath: string;
  /** Optional post-render loudness metrics. */
  metrics?: {
    integratedLufs?: number;
    truePeakDbtp?: number;
  };
  /** Wall-clock render duration (ms). */
  durationMs: number;
  /** Echo of the override keys applied (mirrors the request). */
  appliedOverrideKeys?: string[];
  /** Echo of the patch hash (for stale matching alongside requestId). */
  patchHash?: string;
}

/** Failed preview re-render. */
export interface PreviewRenderFailure {
  requestId: number;
  ok: false;
  error: string;
}

export type PreviewRenderResponse = PreviewRenderSuccess | PreviewRenderFailure;

// ── Save-audio IPC contract (M3-P-NEXT-5D-2-d) ────────────────────────────
//
// A NEW channel separate from `file:save-wav` (which is unchanged).  It
// saves a source WAV to a user-chosen location, transcoding to the target
// format / quality / dither via ffmpeg when needed.  WAV-with-no-transcode
// falls back to a plain copy.

export type ExportFormat = 'wav' | 'flac' | 'mp3' | 'aiff' | 'ogg';
export type ExportDither = 'none' | 'tpdf' | 'shaped';

export interface SaveAudioRequest {
  /** Source audio file (a rendered master WAV). */
  sourcePath: string;
  /** Target container format. */
  format: ExportFormat;
  /** Optional target sample rate (Hz).  Omit to keep the source rate. */
  sampleRate?: number;
  /** Optional target bit depth (16/24/32).  Omit to keep the source depth. */
  bitDepth?: number;
  /** Dither applied on integer bit-depth reduction.  Default 'none'. */
  dither?: ExportDither;
  /** Suggested filename (without path) for the save dialog. */
  suggestedName?: string;
}

export interface SaveAudioResponse {
  /** Saved file path, or null if the user cancelled the dialog. */
  savedPath: string | null;
  /** Echo of the format actually written. */
  format?: ExportFormat;
  /** Wall-clock duration (ms). */
  durationMs?: number;
  /** Whether ffmpeg transcoding ran (false = plain WAV copy). */
  transcoded?: boolean;
  /** Non-fatal note (e.g. "Dither ignored for MP3"). */
  warning?: string;
  /** Fatal error message (when the save failed). */
  error?: string;
}
