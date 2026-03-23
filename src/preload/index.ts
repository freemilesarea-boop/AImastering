/**
 * Electron Preload 스크립트
 *
 * contextBridge를 통해 렌더러 프로세스에 안전한 IPC API 노출
 * nodeIntegration=false 환경에서 렌더러가 IPC를 사용할 수 있게 함
 */
import { contextBridge, ipcRenderer } from 'electron'

// ─────────────────────────────────────────
// 허용된 IPC 채널 목록 (화이트리스트)
// ─────────────────────────────────────────
const INVOKE_CHANNELS = [
  'audio:analyze',
  'audio:master',
  'audio:qc',
  'file:open-dialog',
  'file:save-dialog',
  'file:open-in-finder',
  'file:get-info',
  'file:get-recent',
  'license:status',
  'license:activate',
  'license:deactivate',
  'settings:get',
  'settings:set',
  'settings:choose-output-dir',
] as const

const LISTEN_CHANNELS = [
  'audio:progress',
  'navigate',
  'menu:open-file',
  'check-update',
] as const

type InvokeChannel = typeof INVOKE_CHANNELS[number]
type ListenChannel = typeof LISTEN_CHANNELS[number]

// ─────────────────────────────────────────
// API 노출
// ─────────────────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * IPC invoke (요청/응답)
   */
  invoke: <T = unknown>(channel: InvokeChannel, data?: unknown): Promise<T> => {
    if (!INVOKE_CHANNELS.includes(channel as InvokeChannel)) {
      return Promise.reject(new Error(`Unauthorized channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, data)
  },

  /**
   * IPC 이벤트 리스너 등록
   */
  on: (channel: ListenChannel, callback: (...args: unknown[]) => void): (() => void) => {
    if (!LISTEN_CHANNELS.includes(channel as ListenChannel)) {
      console.warn(`Unauthorized listen channel: ${channel}`)
      return () => {}
    }
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    // 클린업 함수 반환
    return () => ipcRenderer.removeListener(channel, handler)
  },

  /**
   * 플랫폼 정보
   */
  platform: process.platform,
  version: process.env.npm_package_version || '1.0.0',
})

// TypeScript 전역 타입 선언은 renderer/types/global.d.ts에서
