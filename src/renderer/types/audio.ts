/**
 * 오디오 관련 TypeScript 타입 정의 (v2)
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
// 마스터링 스타일 프리셋
// ─────────────────────────────────────────────────────
export type MasteringStyle = 'balanced' | 'warm' | 'bright' | 'punch'

export interface StylePreset {
  id:          MasteringStyle
  name:        string
  emoji:       string
  description: string
  detail:      string
  targetLUFS:  number
  targetTP:    number
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    emoji: '⚖️',
    description: '기본 추천',
    detail: '최소 개입으로 전체 밸런스를 유지합니다. AI 생성 음원의 첫 마스터링에 적합합니다.',
    targetLUFS: -14,
    targetTP: -1.0,
  },
  {
    id: 'warm',
    name: 'Warm',
    emoji: '🌅',
    description: '따뜻하고 부드럽게',
    detail: '고역 자극을 완화하고 저중역을 살짝 보강합니다. AI 음원 특유의 날카로운 고역을 부드럽게 처리합니다.',
    targetLUFS: -14,
    targetTP: -1.0,
  },
  {
    id: 'bright',
    name: 'Bright',
    emoji: '✨',
    description: '선명하고 존재감 있게',
    detail: '선명도와 존재감을 강조합니다. 팝, 일렉트로닉 장르에 적합합니다.',
    targetLUFS: -14,
    targetTP: -1.0,
  },
  {
    id: 'punch',
    name: 'Punch',
    emoji: '🥊',
    description: '타격감과 에너지',
    detail: '저역 밀도와 타격감을 강화합니다. 힙합, EDM, 록 장르에 적합합니다.',
    targetLUFS: -14,
    targetTP: -1.0,
  },
]

// ─────────────────────────────────────────────────────
// 마스터링 옵션
// ─────────────────────────────────────────────────────
export interface MasteringOptions {
  style:              MasteringStyle
  targetLUFS:         number
  targetTruePeak:     number
  enableEQ:           boolean
  enableCompression:  boolean
  enableStereoEnhance: boolean
  outputFormat:       'wav' | 'flac' | 'mp3'
  outputBitDepth:     16 | 24 | 32
  outputSampleRate:   44100 | 48000 | 96000
  outputPath?:        string
}

// ─────────────────────────────────────────────────────
// 마스터링 결과
// ─────────────────────────────────────────────────────
export interface MasteringResult {
  success:               boolean
  outputPath:            string
  previewPath:           string | null   // Preview MP3 경로
  jobId:                 string
  style:                 MasteringStyle
  inputAnalysis:         AudioAnalysisResult
  outputAnalysis:        AudioAnalysisResult
  processedAt:           string
  processingTimeMs:      number
  aiCorrectionsApplied:  string[]        // 적용된 AI 자동 보정 목록
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
