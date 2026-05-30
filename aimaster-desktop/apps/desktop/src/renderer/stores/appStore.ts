import { create } from 'zustand';

export type Page = 'home' | 'mastering' | 'result' | 'tweak' | 'qc' | 'settings';

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

// ── Bootstrap guard ───────────────────────────────────────────────────────────
// Block any automatic navigation to the result page before the first real user
// interaction.  Spurious setPage('result') calls during boot (e.g. from hot
// reload state leakage or stale callbacks) are silently dropped instead of
// loading ProductPage with no data → white screen.
let _userHasInteracted = false;

if (typeof window !== 'undefined') {
  const _markInteracted = () => { _userHasInteracted = true; };
  window.addEventListener('pointerdown', _markInteracted, { once: true, capture: true });
  window.addEventListener('keydown',     _markInteracted, { once: true, capture: true });
}

export const useAppStore = create<AppStore>((set) => ({
  currentPage:  'home',
  notification: null,

  setPage: (page) => {
    if (page === 'result' && !_userHasInteracted) {
      // eslint-disable-next-line no-console
      console.warn('[AppInner] invalid result route, fallback home — caller:', new Error().stack?.split('\n').slice(2, 5).join(' | '));
      return;
    }
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
