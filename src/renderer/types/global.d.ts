/**
 * 렌더러 전역 타입 선언
 * window.electronAPI 타입 정의
 */

interface ElectronAPI {
  invoke: <T = unknown>(channel: string, data?: unknown) => Promise<T>
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  platform: NodeJS.Platform
  version: string
}

declare global {
  interface Window {
    // preload가 로드되지 않은 경우 undefined일 수 있으므로 optional로 선언
    electronAPI?: ElectronAPI
  }
}

export {}
