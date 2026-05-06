/**
 * 오디오 처리 IPC 핸들러 v2
 *
 * 무료/유료 정책:
 * - 무료: Preview MP3 경로만 반환, Master WAV 경로는 null 처리
 * - 유료: Master WAV + Preview MP3 모두 반환
 */
import { ipcMain, BrowserWindow } from 'electron'
import { audioEngine } from '../services/AudioEngine'
import { licenseService } from '../services/LicenseService'
import { settingsService } from '../services/SettingsService'
import { logger } from '../utils/logger'

export function registerAudioHandlers(mainWindow: BrowserWindow): void {
  audioEngine.setMainWindow(mainWindow)

  /**
   * audio:analyze — 사전 분석 (라이센스 무관, 항상 가능)
   */
  ipcMain.handle('audio:analyze', async (_event, { filePath }: { filePath: string }) => {
    try {
      logger.info('IPC audio:analyze', filePath)
      const result = await audioEngine.analyze(filePath)
      settingsService.addRecentFile(filePath)
      return { success: true, data: result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('audio:analyze error', msg)
      return { success: false, error: _userFriendlyError(err) }
    }
  })

  /**
   * audio:master — 마스터링 실행
   * 반환값의 outputPath는 라이센스에 따라 null이 될 수 있음
   */
  ipcMain.handle('audio:master', async (_event, {
    filePath,
    options,
  }: { filePath: string; options?: Record<string, unknown> }) => {
    try {
      const { allowed, message, isPaid } = await licenseService.canProcess()
      if (!allowed) {
        return { success: false, error: message, requiresLicense: true }
      }

      logger.info('IPC audio:master', filePath)
      const result = await audioEngine.master(filePath, options as Parameters<typeof audioEngine.master>[1])

      // 무료 체험: Master WAV 경로를 null로 마스킹
      if (!isPaid) {
        licenseService.consumeTrial()
        result.outputPath = ''          // WAV 접근 차단
        logger.info('Free trial: Master WAV path masked')
      }

      return { success: true, data: result, isPaid }
    } catch (err) {
      logger.error('audio:master error', err)
      return { success: false, error: _userFriendlyError(err) }
    }
  })

  /**
   * audio:qc — QC 검사 (라이센스 무관, 항상 가능)
   */
  ipcMain.handle('audio:qc', async (_event, { filePath }: { filePath: string }) => {
    try {
      logger.info('IPC audio:qc', filePath)
      const result = await audioEngine.runQC(filePath)
      return { success: true, data: result }
    } catch (err) {
      logger.error('audio:qc error', err)
      return { success: false, error: _userFriendlyError(err) }
    }
  })
}

/**
 * 사용자 친화적 오류 메시지 변환
 */
function _userFriendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  if (msg.includes('ffmpeg') || msg.includes('ENOENT')) {
    return 'FFmpeg가 설치되지 않았거나 경로를 찾을 수 없습니다.\nhttps://ffmpeg.org 에서 설치 후 다시 시도하세요.'
  }
  if (msg.includes('No such file') || msg.includes('파일 없음')) {
    return '파일을 찾을 수 없습니다. 파일이 이동되었거나 삭제되었을 수 있습니다.'
  }
  if (msg.includes('Invalid data') || msg.includes('Invalid audio')) {
    return '손상된 오디오 파일입니다. 원본 파일을 확인하세요.'
  }
  if (msg.includes('timeout')) {
    return '처리 시간이 초과되었습니다. 파일 크기를 확인하거나 다시 시도하세요.'
  }
  return msg
}
