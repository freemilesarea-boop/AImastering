/**
 * 경로 유틸리티
 * macOS/Windows 크로스 플랫폼 경로 처리
 */
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'

/**
 * Python 실행 파일 경로 반환
 * - 개발: 시스템 python3
 * - 프로덕션: 앱 번들 내 python 바이너리
 */
export function getPythonPath(): string {
  if (process.env.NODE_ENV === 'development') {
    // 개발 환경: 가상 환경 우선 확인
    const venvPython = path.join(process.cwd(), '.venv', 'bin', 'python3')
    if (fs.existsSync(venvPython)) return venvPython
    return 'python3'
  }

  // 프로덕션: 앱 번들 내부
  const resourcesPath = process.resourcesPath
  const bundledPython = path.join(resourcesPath, 'python', 'bin', 'python3')
  if (fs.existsSync(bundledPython)) return bundledPython

  return 'python3' // 폴백
}

/**
 * Python 스크립트 경로 반환
 */
export function getPythonScriptPath(): string {
  if (process.env.NODE_ENV === 'development') {
    return path.join(process.cwd(), 'python', 'main.py')
  }
  return path.join(process.resourcesPath, 'python', 'main.py')
}

/**
 * 임시 작업 디렉토리 경로 반환 (처리 중간 파일 저장)
 */
export function getTempDir(): string {
  const tmpDir = path.join(app.getPath('temp'), 'aimastering')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  return tmpDir
}

/**
 * 사용자 데이터 디렉토리
 */
export function getUserDataPath(filename?: string): string {
  const base = app.getPath('userData')
  return filename ? path.join(base, filename) : base
}

/**
 * ffmpeg/ffprobe 바이너리 경로
 */
export function getFFmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
  if (process.platform === 'win32') return 'ffmpeg.exe'
  return 'ffmpeg'
}

export function getFFprobePath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH
  if (process.platform === 'win32') return 'ffprobe.exe'
  return 'ffprobe'
}
