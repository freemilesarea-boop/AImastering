import { create } from 'zustand';

type Page = 'home' | 'mastering' | 'result' | 'qc' | 'settings';

interface Notification { message: string; type: 'info' | 'success' | 'error' | 'warning'; }

interface AppStore {
  currentPage: Page;
  notification: Notification | null;
  pythonReady: boolean;
  setPage: (page: Page) => void;
  notify: (message: string, type?: Notification['type']) => void;
  setPythonReady: (v: boolean) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  currentPage: 'home',
  notification: null,
  pythonReady: false,
  setPage: (page) => set({ currentPage: page }),
  notify: (message, type = 'info') => {
    set({ notification: { message, type } });
    setTimeout(() => set({ notification: null }), 3000);
  },
  setPythonReady: (v) => set({ pythonReady: v }),
}));
