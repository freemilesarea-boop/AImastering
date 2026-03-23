/**
 * 오디오 처리 IPC 핸들러
 * Renderer ↔ Main 통신 채널 등록
 */
import { ipcMain, BrowserWindow } from 'electron'
import { audioEngine } from '../services/AudioEngine'
import { licenseService } from '../services/LicenseService'
import { settingsService } from '../services/SettingsService'
import { logger } from '../utils/logger'

export function registerAudioHandlers(mainWindow: BrowserWindow): void {
  audioEngine.setMainWindow(mainWindow)

  /**
   * audio:analyze — 오디오 파일 사전 분석
   * 입력: { filePath: string }
   * 출력: AudioAnalysisResult
   */
  ipcMain.handle('audio:analyze', async (_event, { filePath }: { filePath: string }) => {
    try {
      logger.info('IPC audio:analyze', filePath)
      const result = await audioEngine.analyze(filePath)
      settingsService.addRecentFile(filePath)
      return { success: true, data: result }
    } catch (err) {
      logger.error('audio:analyze error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * audio:master — 마스터링 실행
   * 입력: { filePath: string, options?: Partial<MasteringOptions> }
   * 출력: MasteringResult
   */
  ipcMain.handle('audio:master', async (_event, {
    filePath,
    options,
  }: { filePath: string; options?: Record<string, unknown> }) => {
    try {
      // 처리 가능 여부 확인 (라이센스)
      const { allowed, message } = await licenseService.canProcess()
      if (!allowed) {
        return { success: false, error: message }
      }

      logger.info('IPC audio:master', filePath)
      const result = await audioEngine.master(filePath, options as Parameters<typeof audioEngine.master>[1])

      // 무료 체험 소모
      const status = await licenseService.getStatus()
      if (status.tier === 'free_trial') {
        licenseService.consumeTrial()
      }

      return { success: true, data: result }
    } catch (err) {
      logger.error('audio:master error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * audio:qc — QC 검사
   * 입력: { filePath: string }
   * 출력: QCResult
   */
  ipcMain.handle('audio:qc', async (_event, { filePath }: { filePath: string }) => {
    try {
      logger.info('IPC audio:qc', filePath)
      const result = await audioEngine.runQC(filePath)
      return { success: true, data: result }
    } catch (err) {
      logger.error('audio:qc error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
