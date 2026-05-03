/**
 * 오디오 관련 TypeScript 타입 정의 (v3)
 */

// ─────────────────────────────────────────────────────
// AI 음원 특화 감지 결과
// ─────────────────────────────────────────────────────
export interface AIDetectionResult {
  harshHighmid:      boolean   // 3~5kHz 과도한 에너지
  harshHighmidRatio: number    // 비율값 (0~1)
  boomyLow:          boolean   // 60~200Hz 과도한 에너지
  boomyLowRatio:     number
  brickwall:         boolean   // 과도한 압축 의심
  lra:               number
  stereoImbalance:   boolean   // L/R 에너지 불균형
  stereoImbalanceDb: number
}

// ─────────────────────────────────────────────────────
// 오디오 분석 결과
// ─────────────────────────────────────────────────────
export interface AudioAnalysisResult {
  filePath:         string
  duration:         number
  sampleRate:       number
  bitDepth:         number
  channels:         number
  fileSize:         number
  codec:            string
  // 라우드니스
  lufsIntegrated:   number
  lufsShortterm:    number
  lfusMomentary:    number
  truePeak:         number
  lra:              number
  dynamicRange:     number
  // 스펙트럼
  spectral: {
    lowEnergy:  number
    midEnergy:  number
    highEnergy: number
    centroid:   number
  }
  // 클리핑
  clippingDetected: boolean
  clippingSamples:  number
  // AI 음원 특화
  aiDetection:         AIDetectionResult
  // 추가 검사
  dcOffset:            number
  silenceStartMs:      number
  silenceEndMs:        number
  intersampleRisk:     boolean
  upsampleSuspected:   boolean
}

// ─────────────────────────────────────────────────────
// 마스터링 모드 (v3) — 새 5종 + 레거시 2종
// ─────────────────────────────────────────────────────
export type MasteringMode =
  | 'natural'
  | 'balanced'
  | 'bright'
  | 'loud'
  | 'kpop_loud'
  // legacy
  | 'warm'
  | 'punch'

/** 레거시 'style' 별칭 (v2 호환) */
export type MasteringStyle = MasteringMode

export type LimiterStrength = 'low' | 'medium' | 'high'

export interface ModePreset {
  id:          MasteringMode
  name:        string
  emoji:       string
  description: string
  detail:      string
  targetLUFS:  number
  targetTP:    number
  limiterStrength: LimiterStrength
  legacy?:     boolean
}

/**
 * 5개 메인 모드 (v3) + 2개 레거시 (UI 에서는 고급 옵션으로 노출)
 */
export const MASTERING_MODES: ModePreset[] = [
  {
    id: 'natural',
    name: 'Natural',
    emoji: '🌿',
    description: '원본 보존',
    detail: '약한 EQ + 약한 컴프레션. AI 원음의 톤을 거의 그대로 유지합니다.',
    targetLUFS: -14,
    targetTP: -1.0,
    limiterStrength: 'low',
  },
  {
    id: 'balanced',
    name: 'Balanced',
    emoji: '⚖️',
    description: '기본값',
    detail: '적당한 EQ/comp/saturation. 일반 발매용 기본 추천.',
    targetLUFS: -12,
    targetTP: -1.0,
    limiterStrength: 'medium',
  },
  {
    id: 'bright',
    name: 'Bright',
    emoji: '✨',
    description: '고역 선명도',
    detail: 'air band 를 살리되 harsh 하지 않게. 과압축 없음.',
    targetLUFS: -12,
    targetTP: -1.0,
    limiterStrength: 'medium',
  },
  {
    id: 'loud',
    name: 'Loud',
    emoji: '🔊',
    description: '음압 강화',
    detail: 'soft clipping + limiter 적극 사용. 다이나믹 손상 가능.',
    targetLUFS: -10,
    targetTP: -1.0,
    limiterStrength: 'high',
  },
  {
    id: 'kpop_loud',
    name: 'KPOP Loud',
    emoji: '🎤',
    description: '체감 볼륨 우선',
    detail: 'low-end 정리 + mid/high clarity + 강한 limiter (v3.1: -10 LUFS / -1 dBTP 안정화).',
    targetLUFS: -10,
    targetTP: -1.0,
    limiterStrength: 'high',
  },
  // legacy
  {
    id: 'warm',
    name: 'Warm',
    emoji: '🌅',
    description: '고역 자극 완화',
    detail: 'AI 음원 특유의 날카로운 고역을 부드럽게 처리합니다 (legacy).',
    targetLUFS: -14,
    targetTP: -1.0,
    limiterStrength: 'low',
    legacy: true,
  },
  {
    id: 'punch',
    name: 'Punch',
    emoji: '🥊',
    description: '타격감 강화',
    detail: '저역 밀도와 타격감을 강화 (legacy).',
    targetLUFS: -11,
    targetTP: -1.0,
    limiterStrength: 'high',
    legacy: true,
  },
]

/** 레거시 export (v2 호환). 카드 UI 가 이 이름으로 import 함. */
export const STYLE_PRESETS: ModePreset[] = MASTERING_MODES

// ─────────────────────────────────────────────────────
// 빠른 프리셋 (LUFS / TP / mode 일괄 적용)
// ─────────────────────────────────────────────────────
export interface MasteringQuickPreset {
  id:          string
  name:        string
  emoji:       string
  description: string
  mode:        MasteringMode
  targetLUFS:  number
  targetTP:    number
  limiterStrength: LimiterStrength
}

export const MASTERING_PRESETS: MasteringQuickPreset[] = [
  {
    id: 'youtube_safe',
    name: 'YouTube Safe',
    emoji: '📺',
    description: '-14 LUFS / -1.0 dBTP',
    mode: 'balanced',
    targetLUFS: -14,
    targetTP: -1.0,
    limiterStrength: 'low',
  },
  {
    id: 'streaming_loud',
    name: 'Streaming Loud',
    emoji: '🎧',
    description: '-11 LUFS / -1.0 dBTP',
    mode: 'balanced',
    targetLUFS: -11,
    targetTP: -1.0,
    limiterStrength: 'medium',
  },
  {
    id: 'kpop_loud',
    name: 'KPOP Loud',
    emoji: '🎤',
    description: '-10 LUFS / -1.0 dBTP',
    mode: 'kpop_loud',
    targetLUFS: -10,
    targetTP: -1.0,
    limiterStrength: 'high',
  },
  {
    id: 'edm_loud',
    name: 'EDM Loud',
    emoji: '⚡',
    description: '-8 LUFS / -0.5 dBTP',
    mode: 'loud',
    targetLUFS: -8,
    targetTP: -0.5,
    limiterStrength: 'high',
  },
]

// ─────────────────────────────────────────────────────
// 마스터링 옵션
// ─────────────────────────────────────────────────────
export interface MasteringOptions {
  /** v3 권장 키 */
  mode:                MasteringMode
  /** v2 호환 키 (mode 와 동일) */
  style?:              MasteringMode
  targetLUFS:          number
  targetTruePeak:      number
  limiterStrength:     LimiterStrength
  saturationAmount?:   number          // 0.0 ~ 1.0 (undefined = mode 기본값)
  stereoWidth?:        number          // 1.0 = passthrough, undefined = mode 기본값
  outputGainDb?:       number          // -12 ~ +12 dB (선택)
  enableEQ:            boolean
  enableCompression:   boolean
  enableStereoEnhance?: boolean        // legacy
  outputFormat:        'wav' | 'flac' | 'mp3'
  outputBitDepth:      16 | 24 | 32
  outputSampleRate:    44100 | 48000 | 96000
  outputPath?:         string
  /** v2 호환: 어떤 빠른 프리셋을 선택했는지 (UI 상태) */
  preset?:             string
}

// ─────────────────────────────────────────────────────
// 오디오 metrics (v3.1) — 전/후 비교용
// ─────────────────────────────────────────────────────
export type MetricStatus = 'ok' | 'warn' | 'danger'

export interface MetricComparisonRow {
  key:    string
  label:  string
  unit:   string
  before: number | string | null
  after:  number | string | null
  delta:  number | null
  status: MetricStatus
  hint:   string
}

export interface AudioMetrics {
  lufsIntegrated:   number | null
  truePeak:         number | null
  lra:              number | null
  dynamicRange:     number | null
  peakDb:           number | null
  rmsDb:            number | null
  crestFactor:      number | null
  shortTermVarLU:   number | null
  pumpingRisk:      boolean
  clippingDetected: boolean
  clippingSamples:  number
}

// ─────────────────────────────────────────────────────
// 품질 체크 (v3.1)
// ─────────────────────────────────────────────────────
export type QualityStatus = 'ok' | 'warn' | 'danger'

export interface QualityCheckItem {
  name:    string
  status:  QualityStatus
  message: string
  value:   unknown
}

export interface QualityCheckResult {
  overall: QualityStatus
  summary: string
  items:   QualityCheckItem[]
}

// ─────────────────────────────────────────────────────
// 마스터링 결과 리포트 (v3.1)
// ─────────────────────────────────────────────────────
export interface MasteringReport {
  mode:                MasteringMode
  targetLUFS:          number
  targetTruePeak:      number
  targetLRA?:          number
  limiterStrength:     LimiterStrength
  beforeLUFS:          number
  afterLUFS:           number
  beforeTruePeak:      number
  afterTruePeak:       number
  appliedGainDb:       number
  limiterReductionDb:  number
  correctionApplied:   boolean
  correctionGainDb:    number
  lufsDelta:           number
  truePeakOverDb:      number
  targetReached:       boolean
  warnings:            string[]
  useLinearLoudnorm:   boolean
  // v3.1
  processingChain?:      string[]
  dynamicEqMode?:        string
  adynamicEqSupported?:  boolean
  metricComparison?:     MetricComparisonRow[]
  qualityCheck?:         QualityCheckResult
  // v3.2 — fully static chain
  entryGainDb?:          number
  loudnormUsed?:         boolean
}

// ─────────────────────────────────────────────────────
// 마스터링 결과 (v3.1)
// ─────────────────────────────────────────────────────
export interface MasteringResult {
  success:               boolean
  outputPath:            string
  previewPath:           string | null
  jobId:                 string
  /** v2 호환 */
  style:                 MasteringMode
  /** v3 권장 */
  mode:                  MasteringMode
  inputAnalysis:         AudioAnalysisResult
  outputAnalysis:        AudioAnalysisResult
  processedAt:           string
  processingTimeMs:      number
  aiCorrectionsApplied:  string[]
  report?:               MasteringReport
  // v3.1
  originalPath?:          string         // A/B 미리듣기용 원본 경로
  beforeWaveformPath?:    string | null
  afterWaveformPath?:     string | null
  compareWaveformPath?:   string | null
  inputMetrics?:          AudioMetrics
  outputMetrics?:         AudioMetrics
  metricComparison?:      MetricComparisonRow[]
  qualityCheck?:          QualityCheckResult
  processingChain?:       string[]
  stageLog?:              Array<{ name: string; ok: boolean; detail: string }>

  // ───────────────────────────────────────────────────────────
  // v3.3 — Debug-quality system (vocal-mush / radio-quality / over-limiting)
  // ───────────────────────────────────────────────────────────
  limiterCheck?:        LimiterCheckReport
  suspectSegments?:     SuspectSegment[]
  segmentAnalysis?:     {
    windowSec: number
    summary:   SegmentSummary | null
    windowCount: number
  }
  modeRecommendations?: ModeRecommendation[]
  inputFileInfo?:       InputFileInfo
  debugSummary?:        DebugSummary
  appliedSafeModes?:    string[]
  /** v3.3 — gain-staging report (vocal/background balance + per-stage dB push) */
  gainStaging?:         GainStagingReport
  /** v3.3.1 — vocal-protection 엔진 가드 결과 (항상 활성). */
  vocalProtection?:     VocalProtectionReport
}

export interface VocalProtectionClamp {
  where:    string
  original: unknown
  clamped:  unknown
  reason:   string
}

export interface VocalProtectionReport {
  enabled:               boolean
  active:                boolean
  appliedClamps:         VocalProtectionClamp[]
  vocalLossDb:           number | null
  vocalLossSeverity:     'ok' | 'warn' | 'danger'
  autoFallbackTriggered: boolean
  autoFallbackReason:    string
  userMessage:           string
  config: {
    vocalBandHz:           [number, number]
    maxVocalBandCutDb:     number
    maxRatio:              number
    minAttackMs:           number
    maxMakeupDb:           number
    maxEntryGainDb:        number
    maxLimiterInputGainDb: number
  }
}

export interface GainStagingReport {
  stages: {
    compressorMakeupDb: number
    preGainDb:          number
    limiterInputGainDb: number
    correctionGainDb:   number
    ispCorrectionDb:    number
    totalAppliedGainDb: number
  }
  bandsBefore:        Record<string, number>
  bandsAfter:         Record<string, number>
  bandDeltaDb:        Record<string, number>
  vocalLossDb:        number | null
  backgroundRiseDb:   number | null
  crestFactorDropPct: number | null
  lraDropPct:         number | null
  verdict:            'ok' | 'warn' | 'danger'
  issues:             string[]
  recommendations:    string[]
  available:          boolean
}

// ─────────────────────────────────────────────────────
// Debug-quality system types
// ─────────────────────────────────────────────────────
export interface InputFileInfo {
  path:           string | null
  name:           string | null
  codec:          string
  codecLongName?: string | null
  sampleRate:     number
  channels:       number
  channelLayout?: string | null
  bitDepth:       number
  sampleFmt?:     string | null
  bitRateBps:     number | null
  sizeBytes:      number | null
  durationSec:    number
  containerFormat: string
  vbrCbr:         'CBR' | 'VBR' | 'VBR-suspected' | 'unknown' | null
  encoderTag?:    string | null
}

export interface SuspectSegment {
  start:    number
  end:      number
  reason:   'excessive_limiter_reduction' | 'brickwall_flat' |
            'sudden_rms_drop' | 'tight_crest' | string
  severity: 'info' | 'warn' | 'danger'
  details:  string
}

export interface SegmentSummary {
  rmsP05:               number
  rmsP50:               number
  rmsP95:               number
  rmsSpread:            number
  minCrestDb:           number
  ceilingAttachedFrac:  number
}

export interface LimiterCheckItem {
  name:    string
  status:  'ok' | 'warn' | 'danger'
  message: string
  value:   number | string | null
}

export interface LimiterCheckReport {
  overall:  'ok' | 'warn' | 'danger'
  items:    LimiterCheckItem[]
  metrics:  {
    crestDelta?:           number | null
    lraReductionRatio?:    number
    ceilingAttachedFrac?:  number
    brickwallSampleRatio?: number
    lufsOvershoot?:        number
    ispCorrectionDb?:      number
  }
  recommendations: string[]
}

export type SafeModeKey = 'safe' | 'vocal_safe' | 'low_limit' | 'convert_to_wav'

export interface ModeRecommendation {
  mode:     SafeModeKey | string
  reason:   string
  severity: 'info' | 'warn' | 'danger'
  evidence: string[]
}

export interface DebugSummary {
  jobId:             string
  debugMode:         boolean
  elapsedSec:        number
  ffmpegInvocations: number
  stages:            string[]
  warnings:          Array<{ t: number; level: string; msg: string; data?: unknown }>
  errors:            Array<{ t: number; level: string; msg: string; data?: unknown }>
  filterChain:       Record<string, unknown>
  limiterQc:         Record<string, unknown>
  suspectSegments:   SuspectSegment[]
  recommendations:   ModeRecommendation[]
  artifactDir:       string | null
}

// ─────────────────────────────────────────────────────
// QC 결과 (12항목)
// ─────────────────────────────────────────────────────
export type QCStatus = 'pass' | 'warning' | 'fail'

export interface QCItem {
  name:    string
  status:  QCStatus
  message: string
  value:   unknown
}

export interface PlatformQC {
  platform:     string
  targetLUFS:   number
  targetTP:     number
  measuredLUFS: number
  measuredTP:   number
  passed:       boolean
  issues:       string[]
}

export interface QCResult {
  passed:     boolean
  overall:    QCStatus
  summary:    string
  passCount:  number
  totalCount: number
  items:      QCItem[]
  platforms:  PlatformQC[]
  analysis: {
    lufsIntegrated: number
    truePeak:       number
    lra:            number
    dynamicRange:   number
  }
  aiDetection: Partial<AIDetectionResult>
}

// ─────────────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────────────
export interface ProgressEvent {
  jobId:   string
  percent: number
  stage:   string
}

/** QC 상태 → 사람이 읽는 라벨 */
export const QC_STATUS_LABELS: Record<QCStatus, string> = {
  pass:    '통과',
  warning: '주의',
  fail:    '확인 필요',
}

/** QC 상태 → 색상 */
export const QC_STATUS_COLORS: Record<QCStatus, string> = {
  pass:    'text-green-400',
  warning: 'text-yellow-400',
  fail:    'text-red-400',
}

export const QC_STATUS_BG: Record<QCStatus, string> = {
  pass:    'bg-green-900/20 border-green-800/50',
  warning: 'bg-yellow-900/20 border-yellow-800/50',
  fail:    'bg-red-900/20 border-red-800/50',
}

/** 리미터 강도 라벨 */
export const LIMITER_STRENGTH_LABELS: Record<LimiterStrength, string> = {
  low:    'Low (가벼움)',
  medium: 'Medium (보통)',
  high:   'High (강함)',
}
