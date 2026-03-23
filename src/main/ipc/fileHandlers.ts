/**
 * 파일 I/O IPC 핸들러
 */
import { ipcMain, dialog, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { settingsService } from '../services/SettingsService'
import { logger } from '../utils/logger'

export function registerFileHandlers(): void {
  /**
   * file:open-dialog — 파일 선택 대화상자
   */
  ipcMain.handle('file:open-dialog', async () => {
    const result = await dialog.showOpenDialog({
      title: '오디오 파일 선택',
      filters: [
        { name: 'Audio Files', extensions: ['wav', 'flac', 'aiff', 'mp3', 'm4a'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? null : result.filePaths
  })

  /**
   * file:save-dialog — 저장 대화상자
   */
  ipcMain.handle('file:save-dialog', async (_event, { defaultName }: { defaultName: string }) => {
    const result = await dialog.showSaveDialog({
      title: '저장 위치 선택',
      defaultPath: path.join(settingsService.get('outputDir'), defaultName),
      filters: [
        { name: 'WAV', extensions: ['wav'] },
        { name: 'FLAC', extensions: ['flac'] },
        { name: 'MP3', extensions: ['mp3'] },
      ],
    })
    return result.canceled ? null : result.filePath
  })

  /**
   * file:open-in-finder — Finder/Explorer에서 파일 위치 열기
   */
  ipcMain.handle('file:open-in-finder', async (_event, { filePath }: { filePath: string }) => {
    shell.showItemInFolder(filePath)
    return { success: true }
  })

  /**
   * file:get-info — 파일 기본 정보 반환
   */
  ipcMain.handle('file:get-info', async (_event, { filePath }: { filePath: string }) => {
    try {
      const stat = fs.statSync(filePath)
      return {
        success: true,
        data: {
          name: path.basename(filePath),
          ext: path.extname(filePath).toLowerCase().slice(1),
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          modifiedAt: stat.mtime.toISOString(),
        },
      }
    } catch (err) {
      logger.error('file:get-info error', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * file:get-recent — 최근 파일 목록
   */
  ipcMain.handle('file:get-recent', async () => {
    const files = settingsService.get('recentFiles')
    // 존재하지 않는 파일 필터링
    const valid = files.filter(f => fs.existsSync(f))
    if (valid.length !== files.length) {
      settingsService.set('recentFiles', valid)
    }
    return { success: true, data: valid }
  })
}
