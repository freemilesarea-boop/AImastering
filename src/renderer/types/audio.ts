/**
 * 오디오 관련 TypeScript 타입 정의
 */

export interface AudioAnalysisResult {
  filePath: string
  duration: number
  sampleRate: number
  bitDepth: number
  channels: number
  fileSize: number
  lufsIntegrated: number
  lufsShortterm: number
  lfusMomentary: number
  truePeak: number
  lra: number
  dynamicRange: number
  spectral: {
    lowEnergy: number
    midEnergy: number
    highEnergy: number
    centroid: number
  }
  clippingDetected: boolean
  clippingSamples: number
}

export interface MasteringPreset {
  id: string
  name: string
  description: string
  targetLUFS: number
  targetTruePeak: number
  enableEQ: boolean
  enableCompression: boolean
  enableStereoEnhance: boolean
  eqSettings?: EQSettings
  compressionSettings?: CompressionSettings
}

export interface EQSettings {
  highpassFreq: number      // Hz (저역 차단)
  lowShelfGain: number      // dB
  midFreq: number           // Hz
  midGain: number           // dB
  midQ: number
  highShelfFreq: number     // Hz
  highShelfGain: number     // dB
  airFreq: number           // Hz (공기감 EQ)
  airGain: number           // dB
}

export interface CompressionSettings {
  threshold: number   // dBFS
  ratio: number       // x:1
  attack: number      // ms
  release: number     // ms
  makeupGain: number  // dB
  knee: number        // dB
}

export interface MasteringOptions {
  preset: string
  targetLUFS: number
  targetTruePeak: number
  enableEQ: boolean
  enableCompression: boolean
  enableStereoEnhance: boolean
  outputFormat: 'wav' | 'flac' | 'mp3'
  outputBitDepth: 16 | 24 | 32
  outputSampleRate: 44100 | 48000 | 96000
  outputPath?: string
}

export interface MasteringResult {
  success: boolean
  outputPath: string
  jobId: string
  inputAnalysis: AudioAnalysisResult
  outputAnalysis: AudioAnalysisResult
  processedAt: string
  processingTimeMs: number
}

export interface QCResult {
  passed: boolean
  platforms: PlatformQC[]
  summary: string
}

export interface PlatformQC {
  platform: string
  targetLUFS: number
  targetTP: number
  measuredLUFS: number
  measuredTP: number
  passed: boolean
  issues: string[]
}

export interface ProgressEvent {
  jobId: string
  percent: number
  stage: string
}

// 내장 마스터링 프리셋 목록
export const MASTERING_PRESETS: MasteringPreset[] = [
  {
    id: 'youtube_music',
    name: 'YouTube Music',
    description: '통합 -14 LUFS / TP -1.0 dBTP 기준 마스터링 프로필',
    targetLUFS: -14,
    targetTruePeak: -1.0,
    enableEQ: true,
    enableCompression: true,
    enableStereoEnhance: false,
  },
  {
    id: 'spotify',
    name: 'Spotify',
    description: '통합 -14 LUFS / TP -1.0 dBTP',
    targetLUFS: -14,
    targetTruePeak: -1.0,
    enableEQ: true,
    enableCompression: true,
    enableStereoEnhance: false,
  },
  {
    id: 'apple_music',
    name: 'Apple Music / iTunes',
    description: '통합 -16 LUFS / TP -1.0 dBTP (더 여유있는 다이나믹)',
    targetLUFS: -16,
    targetTruePeak: -1.0,
    enableEQ: true,
    enableCompression: false,
    enableStereoEnhance: false,
  },
  {
    id: 'tidal',
    name: 'Tidal / Amazon Music HD',
    description: '통합 -14 LUFS / TP -1.0 dBTP (고음질 스트리밍)',
    targetLUFS: -14,
    targetTruePeak: -1.0,
    enableEQ: true,
    enableCompression: true,
    enableStereoEnhance: false,
  },
  {
    id: 'broadcast',
    name: '방송/팟캐스트',
    description: '-23 LUFS (EBU R128 방송 표준)',
    targetLUFS: -23,
    targetTruePeak: -1.0,
    enableEQ: true,
    enableCompression: true,
    enableStereoEnhance: false,
  },
  {
    id: 'custom',
    name: '사용자 정의',
    description: '직접 타깃 값 설정',
    targetLUFS: -14,
    targetTruePeak: -1.0,
    enableEQ: true,
    enableCompression: true,
    enableStereoEnhance: false,
  },
]
