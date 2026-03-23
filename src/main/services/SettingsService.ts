/**
 * 앱 설정 관리 서비스
 * electron-store 기반 영속 저장
 */
import Store from 'electron-store'
import { app } from 'electron'
import * as path from 'path'

export interface AppSettings {
  // 출력 설정
  outputDir: string
  outputFormat: 'wav' | 'flac' | 'mp3'
  outputBitDepth: 16 | 24 | 32
  outputSampleRate: 44100 | 48000 | 96000
  outputFilenamePattern: string // e.g. "{original}_mastered"

  // 마스터링 기본 프리셋
  defaultPreset: string

  // 처리 품질
  processingQuality: 'fast' | 'standard' | 'high'

  // UI 설정
  language: 'ko' | 'en'
  theme: 'dark' | 'light'

  // 라우드니스 타깃
  targetLUFS: number        // 기본 -14
  targetTruePeak: number    // 기본 -1.0

  // 업데이트
  autoCheckUpdate: boolean

  // 최근 파일
  recentFiles: string[]
}

const defaults: AppSettings = {
  outputDir: app.getPath('music'),
  outputFormat: 'wav',
  outputBitDepth: 24,
  outputSampleRate: 44100,
  outputFilenamePattern: '{original}_mastered',
  defaultPreset: 'youtube_music',
  processingQuality: 'standard',
  language: 'ko',
  theme: 'dark',
  targetLUFS: -14,
  targetTruePeak: -1.0,
  autoCheckUpdate: true,
  recentFiles: [],
}

class SettingsService {
  private store: Store<AppSettings>

  constructor() {
    this.store = new Store<AppSettings>({
      name: 'settings',
      defaults,
      // 설정 파일 스키마 검증
      schema: {
        targetLUFS: { type: 'number', minimum: -30, maximum: 0 },
        targetTruePeak: { type: 'number', minimum: -10, maximum: 0 },
        outputFormat: { type: 'string', enum: ['wav', 'flac', 'mp3'] },
        recentFiles: { type: 'array', maxItems: 10 },
      } as Record<string, unknown>,
    })
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.store.get(key)
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.store.set(key, value)
  }

  getAll(): AppSettings {
    return this.store.store
  }

  setAll(settings: Partial<AppSettings>): void {
    for (const [key, value] of Object.entries(settings)) {
      this.store.set(key as keyof AppSettings, value as AppSettings[keyof AppSettings])
    }
  }

  /**
   * 최근 파일 목록에 파일 추가 (중복 제거, 최대 10개 유지)
   */
  addRecentFile(filePath: string): void {
    const recent = this.get('recentFiles').filter(f => f !== filePath)
    recent.unshift(filePath)
    this.set('recentFiles', recent.slice(0, 10))
  }

  /**
   * 출력 파일명 생성
   */
  buildOutputFilename(inputPath: string): string {
    const pattern = this.get('outputFilenamePattern')
    const ext = this.get('outputFormat')
    const original = path.basename(inputPath, path.extname(inputPath))
    const name = pattern.replace('{original}', original)
    return `${name}.${ext}`
  }

  reset(): void {
    this.store.clear()
  }
}

export const settingsService = new SettingsService()
