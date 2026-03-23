/**
 * FFmpeg 설치 여부 확인 유틸리티
 * 앱 시작 시 FFmpeg/FFprobe 경로 검증
 */
import { execSync } from 'child_process'
import { logger } from './logger'

export interface FFmpegStatus {
  ffmpeg:  { available: boolean; version?: string; path: string }
  ffprobe: { available: boolean; version?: string; path: string }
}

export function checkFFmpeg(
  ffmpegPath  = 'ffmpeg',
  ffprobePath = 'ffprobe'
): FFmpegStatus {
  const checkBin = (bin: string): { available: boolean; version?: string; path: string } => {
    try {
      const version = execSync(`${bin} -version 2>&1`, { timeout: 3000 })
        .toString()
        .split('\n')[0]
        .match(/version ([^\s]+)/)?.[1]
      return { available: true, version, path: bin }
    } catch {
      return { available: false, path: bin }
    }
  }

  const status: FFmpegStatus = {
    ffmpeg:  checkBin(ffmpegPath),
    ffprobe: checkBin(ffprobePath),
  }

  if (!status.ffmpeg.available) {
    logger.error('FFmpeg not found! Audio processing will fail.')
    logger.error('Install: brew install ffmpeg (macOS) or apt install ffmpeg (Ubuntu)')
  } else {
    logger.info(`FFmpeg v${status.ffmpeg.version} found`)
  }

  if (!status.ffprobe.available) {
    logger.error('FFprobe not found!')
  } else {
    logger.info(`FFprobe v${status.ffprobe.version} found`)
  }

  return status
}
