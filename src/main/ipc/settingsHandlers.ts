/**
 * 설정 IPC 핸들러
 */
import { ipcMain, dialog } from 'electron'
import { settingsService, AppSettings } from '../services/SettingsService'
import { logger } from '../utils/logger'

export function registerSettingsHandlers(): void {
  /**
   * settings:get — 모든 설정 조회
   */
  ipcMain.handle('settings:get', async () => {
    return { success: true, data: settingsService.getAll() }
  })

  /**
   * settings:set — 설정 저장
   */
  ipcMain.handle('settings:set', async (_event, updates: Partial<AppSettings>) => {
    try {
      settingsService.setAll(updates)
      return { success: true }
    } catch (err) {
      logger.error('settings:set error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * settings:choose-output-dir — 출력 폴더 선택 대화상자
   */
  ipcMain.handle('settings:choose-output-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '출력 폴더 선택',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return { success: false }
    const chosen = result.filePaths[0]
    settingsService.set('outputDir', chosen)
    return { success: true, data: chosen }
  })
}
