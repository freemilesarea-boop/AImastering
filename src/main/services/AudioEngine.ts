/**
 * 오디오 엔진 오케스트레이터 v2
 * Python 파이프라인 제어 + 진행률 중계 + 작업 관리
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

// ─────────────────────────────────────────────────────
// 타입 (Python 결과를 그대로 통과시키는 인터페이스)
// ─────────────────────────────────────────────────────
export interface AudioAnalysisResult {
  filePath:         string
  duration:         number
  sampleRate:       number
  bitDepth:         number
  channels:         number
  fileSize:         number
  codec:            string
  lufsIntegrated:   number
  lufsShortterm:    number
  lfusMomentary:    number
  truePeak:         number
  lra:              number
  dynamicRange:     number
  spectral:         Record<string, number>
  clippingDetected: boolean
  clippingSamples:  number
  aiDetection:      Record<string, unknown>
  dcOffset:         number
  silenceStartMs:   number
  silenceEndMs:     number
  intersampleRisk:  boolean
  upsampleSuspected:boolean
}

export interface MasteringOptions {
  style:              string
  targetLUFS:         number
  targetTruePeak:     number
  enableEQ:           boolean
  enableCompression:  boolean
  outputFormat:       'wav' | 'flac' | 'mp3'
  outputBitDepth:     16 | 24 | 32
  outputSampleRate:   44100 | 48000 | 96000
  outputPath:         string
}

export interface MasteringResult {
  success:              boolean
  outputPath:           string
  previewPath:          string | null
  jobId:                string
  style:                string
  inputAnalysis:        AudioAnalysisResult
  outputAnalysis:       AudioAnalysisResult
  processedAt:          string
  processingTimeMs:     number
  aiCorrectionsApplied: string[]
}

export interface QCResult {
  passed:     boolean
  overall:    string
  summary:    string
  passCount:  number
  totalCount: number
  items:      Array<{ name: string; status: string; message: string; value: unknown }>
  platforms:  Array<Record<string, unknown>>
  analysis:   Record<string, number>
  aiDetection:Record<string, unknown>
}

export type JobStatus = 'queued' | 'analyzing' | 'processing' | 'done' | 'error'

interface Job {
  id:        string
  inputPath: string
  options:   MasteringOptions
  status:    JobStatus
  progress:  number
  stage:     string
  result?:   MasteringResult
  error?:    string
  createdAt: Date
}

// ─────────────────────────────────────────────────────
// AudioEngine
// ─────────────────────────────────────────────────────
class AudioEngine extends EventEmitter {
  private bridge: PythonBridge
  private jobs: Map<string, Job> = new Map()
  private mainWindow: BrowserWindow | null = null

  constructor(bridge: PythonBridge) {
    super()
    this.bridge = bridge

    // Python 진행률 이벤트 → 렌더러로 중계
    this.bridge.on('progress', (msg: { jobId: string; percent: number; stage: string }) => {
      const job = this.jobs.get(msg.jobId)
      if (job) { job.progress = msg.percent; job.stage = msg.stage }
      this.sendToRenderer('audio:progress', msg)
    })
  }

  setMainWindow(win: BrowserWindow): void { this.mainWindow = win }

  async analyze(filePath: string): Promise<AudioAnalysisResult> {
    logger.info(`Analyzing: ${filePath}`)
    this.validateFilePath(filePath)
    return this.bridge.call<AudioAnalysisResult>('analyze', {
      filePath,
      ffmpegPath:  process.env.FFMPEG_PATH  || 'ffmpeg',
      ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    })
  }

  async master(
    inputPath: string,
    options?: Partial<MasteringOptions>
  ): Promise<MasteringResult> {
    this.validateFilePath(inputPath)

    const settings   = settingsService.getAll()
    const jobId      = uuidv4()
    const outputFilename = settingsService.buildOutputFilename(inputPath)
    const outputPath = options?.outputPath || path.join(settings.outputDir, outputFilename)

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })

    const mergedOptions: MasteringOptions = {
      style:             settings.defaultPreset || 'balanced',
      targetLUFS:        settings.targetLUFS,
      targetTruePeak:    settings.targetTruePeak,
      enableEQ:          true,
      enableCompression: true,
      outputFormat:      settings.outputFormat,
      outputBitDepth:    settings.outputBitDepth,
      outputSampleRate:  settings.outputSampleRate,
      outputPath,
      ...options,
    }

    const job: Job = {
      id: jobId, inputPath, options: mergedOptions,
      status: 'analyzing', progress: 0, stage: '초기화 중...',
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
        ffmpegPath:  process.env.FFMPEG_PATH  || 'ffmpeg',
        ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
        tempDir: getTempDir(),
      })

      result.processingTimeMs = Date.now() - startTime
      job.status = 'done'; job.result = result; job.progress = 100

      logger.info(`Mastering complete: ${jobId} in ${result.processingTimeMs}ms`)
      return result
    } catch (err) {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      logger.error(`Mastering failed: ${jobId}`, job.error)
      throw err
    }
  }

  async runQC(filePath: string): Promise<QCResult> {
    this.validateFilePath(filePath)
    return this.bridge.call<QCResult>('qc_check', {
      filePath,
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    })
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow?.webContents && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  private validateFilePath(filePath: string): void {
    if (!fs.existsSync(filePath)) throw new Error(`파일을 찾을 수 없습니다: ${filePath}`)
    const ext = path.extname(filePath).toLowerCase()
    if (!['.wav', '.flac', '.aiff', '.mp3', '.m4a'].includes(ext)) {
      throw new Error(`지원하지 않는 파일 형식: ${ext}`)
    }
  }
}

export const audioEngine = new AudioEngine(pythonBridge)
