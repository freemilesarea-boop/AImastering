/**
 * 앱 설정 타입 정의 (renderer 전용)
 *
 * 이 파일은 main/services/SettingsService.ts 의 AppSettings 인터페이스를
 * renderer에서 안전하게 사용하기 위해 분리한 것입니다.
 * SettingsService.ts 는 electron-store / electron 을 import 하므로
 * renderer에서 직접 import 하면 Vite 번들링 오류가 발생합니다.
 */

export interface AppSettings {
  // 출력 설정
  outputDir: string
  outputFormat: 'wav' | 'flac' | 'mp3'
  outputBitDepth: 16 | 24 | 32
  outputSampleRate: 44100 | 48000 | 96000
  outputFilenamePattern: string

  // 마스터링 기본 프리셋
  defaultPreset: string

  // 처리 품질
  processingQuality: 'fast' | 'standard' | 'high'

  // UI 설정
  language: 'ko' | 'en'
  theme: 'dark' | 'light'

  // 라우드니스 타깃
  targetLUFS: number
  targetTruePeak: number

  // 업데이트
  autoCheckUpdate: boolean

  // 최근 파일
  recentFiles: string[]
}
