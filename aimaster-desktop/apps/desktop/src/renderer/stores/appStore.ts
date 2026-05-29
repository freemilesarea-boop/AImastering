import { create } from 'zustand';

export type Page = 'home' | 'analysis' | 'mastering' | 'result' | 'qc' | 'settings';

interface Notification {
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

interface AppStore {
  currentPage: Page;
  notification: Notification | null;
  setPage: (page: Page) => void;
  notify: (message: string, type?: Notification['type']) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  currentPage:  'home',
  notification: null,

  setPage: (page) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[appStore] setPage:', page, new Error('caller stack').stack?.split('\n').slice(1, 6).join(' | '));
    }
    set({ currentPage: page });
  },

  notify: (message, type = 'info') => {
    set({ notification: { message, type } });
    setTimeout(() => set({ notification: null }), 3500);
  },
}));
