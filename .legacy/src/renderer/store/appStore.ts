/**
 * 앱 전역 상태 스토어 (Zustand)
 */
import { create } from 'zustand'

type Page = 'home' | 'mastering' | 'result' | 'qc' | 'settings'

interface AppState {
  currentPage: Page
  recentFiles: string[]
  notification: { type: 'success' | 'error' | 'info' | 'warning'; message: string } | null
  pythonReady: boolean

  navigateTo: (page: Page) => void
  setRecentFiles: (files: string[]) => void
  showNotification: (type: AppState['notification'] extends null ? never : AppState['notification']['type'], message: string) => void
  clearNotification: () => void
  setPythonReady: (ready: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  currentPage: 'home',
  recentFiles: [],
  notification: null,
  pythonReady: false,

  navigateTo: (page) => set({ currentPage: page }),
  setRecentFiles: (files) => set({ recentFiles: files }),

  showNotification: (type, message) => {
    set({ notification: { type, message } })
    // 3초 후 자동 닫기
    setTimeout(() => set({ notification: null }), 3000)
  },

  clearNotification: () => set({ notification: null }),
  setPythonReady: (ready) => set({ pythonReady: ready }),
}))
