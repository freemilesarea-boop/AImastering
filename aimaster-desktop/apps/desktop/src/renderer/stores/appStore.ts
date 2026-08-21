import { create } from 'zustand';

export type Page = 'home' | 'mastering' | 'result' | 'tweak' | 'qc' | 'settings' | 'daw';

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

/**
 * Which page to open on, in DEV only.
 *
 * `pnpm dev` lands on the home screen, which is right for the product and
 * wrong for working on the DAW: every reload costs two clicks to get back to
 * where you were.  `?page=daw` on the dev-server URL skips them.
 *
 * Gated on `import.meta.env.DEV` rather than trusted from the URL, because in
 * the packaged app the renderer is loaded from a file:// path a user could in
 * principle influence, and a deep link is not worth a route somebody else can
 * choose.  Unknown values fall back to home rather than rendering nothing.
 */
function initialPage(): Page {
  if (!import.meta.env.DEV || typeof window === 'undefined') return 'home';
  const wanted = new URLSearchParams(window.location.search).get('page');
  const pages: Page[] = ['home', 'mastering', 'result', 'tweak', 'qc', 'settings', 'daw'];
  // 'result' needs data that a fresh boot does not have — it would white-screen.
  return wanted && wanted !== 'result' && (pages as string[]).includes(wanted)
    ? wanted as Page : 'home';
}

export const useAppStore = create<AppStore>((set) => ({
  currentPage:  initialPage(),
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
