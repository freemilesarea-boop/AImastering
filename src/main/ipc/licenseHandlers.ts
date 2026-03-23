/**
 * 라이센스 IPC 핸들러
 */
import { ipcMain } from 'electron'
import { licenseService } from '../services/LicenseService'
import { logger } from '../utils/logger'

export function registerLicenseHandlers(): void {
  /**
   * license:status — 현재 라이센스 상태 조회
   */
  ipcMain.handle('license:status', async () => {
    try {
      const status = await licenseService.getStatus()
      return { success: true, data: status }
    } catch (err) {
      logger.error('license:status error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * license:activate — 라이센스 키 활성화
   */
  ipcMain.handle('license:activate', async (_event, { key }: { key: string }) => {
    try {
      const result = await licenseService.activate(key)
      return { success: result.success, data: result }
    } catch (err) {
      logger.error('license:activate error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * license:deactivate — 라이센스 비활성화
   */
  ipcMain.handle('license:deactivate', async () => {
    try {
      await licenseService.deactivate()
      return { success: true }
    } catch (err) {
      logger.error('license:deactivate error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
