/**
 * 오디오 엔진 오케스트레이터
 * Python 파이프라인을 Node.js에서 제어하는 서비스 레이어
 *
 * 역할:
 * - Python 브릿지를 통한 분석/마스터링/QC 명령 전달
 * - 진행률 이벤트 중계 (Python → IPC → Renderer)
 * - 작업 큐 관리 (배치 처리)
 */
import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import * as path from 'path'
import * as fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { pythonBridge, PythonBridge } from '../utils/pythonBridge'
import { settingsService } from './SettingsService'
import { getTempDir } from '../utils/pathUtils'
import { logger } from '../utils/logger'

// ─────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────

export interface AudioAnalysisResult {
  filePath: string
  duration: number          // 초
  sampleRate: number
  bitDepth: number
  channels: number
  fileSize: number          // bytes
  lufsIntegrated: number
  lufsShortterm: number
  lfusMomentary: number
  truePeak: number          // dBTP
  lra: number               // Loudness Range
  dynamicRange: number      // DR
  spectral: {
    lowEnergy: number       // 0~250Hz 에너지 비율
    midEnergy: number       // 250Hz~4kHz
    highEnergy: number      // 4kHz~
    centroid: number        // 스펙트럼 중심 주파수
  }
  clippingDetected: boolean
  clippingSamples: number
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
  outputPath: string
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

export type JobStatus = 'queued' | 'analyzing' | 'processing' | 'done' | 'error'

interface Job {
  id: string
  inputPath: string
  options: MasteringOptions
  status: JobStatus
  progress: number
  stage: string
  result?: MasteringResult
  error?: string
  createdAt: Date
}

// ─────────────────────────────────────────
// AudioEngine 구현
// ─────────────────────────────────────────

class AudioEngine extends EventEmitter {
  private bridge: PythonBridge
  private jobs: Map<string, Job> = new Map()
  private mainWindow: BrowserWindow | null = null

  constructor(bridge: PythonBridge) {
    super()
    this.bridge = bridge

    // Python에서 오는 진행률 이벤트를 렌더러로 중계
    this.bridge.on('progress', (msg: { jobId: string; percent: number; stage: string }) => {
      const job = this.jobs.get(msg.jobId)
      if (job) {
        job.progress = msg.percent
        job.stage = msg.stage
      }
      this.sendToRenderer('audio:progress', msg)
    })
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  /**
   * 오디오 파일 분석 (마스터링 전 Pre-analysis)
   */
  async analyze(filePath: string): Promise<AudioAnalysisResult> {
    logger.info(`Analyzing: ${filePath}`)
    this.validateFilePath(filePath)

    const result = await this.bridge.call<AudioAnalysisResult>('analyze', {
      filePath,
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
      ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    })

    logger.info(`Analysis complete: LUFS=${result.lufsIntegrated} TP=${result.truePeak}`)
    return result
  }

  /**
   * 마스터링 실행
   */
  async master(inputPath: string, options?: Partial<MasteringOptions>): Promise<MasteringResult> {
    this.validateFilePath(inputPath)

    const settings = settingsService.getAll()
    const jobId = uuidv4()

    // 출력 파일 경로 결정
    const outputFilename = settingsService.buildOutputFilename(inputPath)
    const outputPath = options?.outputPath || path.join(settings.outputDir, outputFilename)

    // 출력 디렉토리 생성
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })

    const mergedOptions: MasteringOptions = {
      preset: settings.defaultPreset,
      targetLUFS: settings.targetLUFS,
      targetTruePeak: settings.targetTruePeak,
      enableEQ: true,
      enableCompression: true,
      enableStereoEnhance: false,
      outputFormat: settings.outputFormat,
      outputBitDepth: settings.outputBitDepth,
      outputSampleRate: settings.outputSampleRate,
      outputPath,
      ...options,
    }

    // 작업 등록
    const job: Job = {
      id: jobId,
      inputPath,
      options: mergedOptions,
      status: 'analyzing',
      progress: 0,
      stage: '초기화 중...',
      createdAt: new Date(),
    }
    this.jobs.set(jobId, job)

    logger.info(`Mastering job started: ${jobId}`)
    const startTime = Date.now()

    try {
      job.status = 'processing'
      const result = await this.bridge.call<MasteringResult>('master', {
        jobId,
        inputPath,
        options: mergedOptions,
        ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
        ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
        tempDir: getTempDir(),
      })

      result.processingTimeMs = Date.now() - startTime
      job.status = 'done'
      job.result = result
      job.progress = 100

      logger.info(`Mastering complete: ${jobId} in ${result.processingTimeMs}ms`)
      return result
    } catch (err) {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      logger.error(`Mastering failed: ${jobId}`, job.error)
      throw err
    }
  }

  /**
   * QC 검사 실행
   */
  async runQC(filePath: string): Promise<QCResult> {
    this.validateFilePath(filePath)
    logger.info(`Running QC: ${filePath}`)

    const result = await this.bridge.call<QCResult>('qc_check', {
      filePath,
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    })

    logger.info(`QC complete: passed=${result.passed}`)
    return result
  }

  /**
   * 작업 상태 조회
   */
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId)
  }

  /**
   * 렌더러로 이벤트 전송 (IPC push)
   */
  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow?.webContents && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  private validateFilePath(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`파일을 찾을 수 없습니다: ${filePath}`)
    }
    const ext = path.extname(filePath).toLowerCase()
    const allowed = ['.wav', '.flac', '.aiff', '.mp3', '.m4a']
    if (!allowed.includes(ext)) {
      throw new Error(`지원하지 않는 파일 형식입니다: ${ext}`)
    }
  }
}

export const audioEngine = new AudioEngine(pythonBridge)
