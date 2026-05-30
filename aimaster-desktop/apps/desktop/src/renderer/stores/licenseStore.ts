import { create } from 'zustand';
import type { LicenseInfo } from '@aimaster/shared-types';

interface LicenseStore {
  licenseInfo: LicenseInfo | null;
  isLoading: boolean;
  error: string | null;
  showModal: boolean;

  // Actions
  setLicenseInfo: (info: LicenseInfo) => void;
  setLoading: (v: boolean) => void;
  setError: (msg: string | null) => void;
  setShowModal: (v: boolean) => void;

  /** Load current license state from main process. */
  load: () => Promise<void>;

  /** Attempt to activate a license key. Resolves on success, rejects with message on failure. */
  activate: (key: string) => Promise<void>;
}

export const useLicenseStore = create<LicenseStore>((set, _get) => ({
  licenseInfo: null,
  isLoading:   false,
  error:       null,
  showModal:   false,

  setLicenseInfo: (info) => set({ licenseInfo: info }),
  setLoading:     (v)    => set({ isLoading: v }),
  setError:       (msg)  => set({ error: msg }),
  setShowModal:   (v)    => set({ showModal: v, error: null }),

  load: async () => {
    if (!window.electronAPI) {
      // eslint-disable-next-line no-console
      console.warn('[licenseStore] electronAPI not available — skipping license load');
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const info = await window.electronAPI.invoke('license:status') as LicenseInfo;
      set({ licenseInfo: info });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[licenseStore] license:status error:', err);
      set({ error: (err as Error).message });
    } finally {
      set({ isLoading: false });
    }
  },

  activate: async (key: string) => {
    if (!window.electronAPI) throw new Error('electronAPI not available');
    set({ isLoading: true, error: null });
    try {
      const info = await window.electronAPI.invoke('license:activate', key) as LicenseInfo;
      set({ licenseInfo: info, showModal: false, error: null });
    } catch (err) {
      // Surface the Korean error message from LicenseService
      set({ error: (err as Error).message });
      throw err;   // re-throw so the modal can stay open
    } finally {
      set({ isLoading: false });
    }
  },
}));

// ── Selector helpers ─────────────────────────────────────────────────────────

/** True when the user is on the free tier (or info not yet loaded). */
export function selectIsFree(store: LicenseStore): boolean {
  return store.licenseInfo?.tier !== 'pro';
}

/** Remaining free trial count, or 0 if paid (WAV save unlocked regardless). */
export function selectRemainingTrials(store: LicenseStore): number {
  const info = store.licenseInfo;
  if (!info) return 3;
  if (info.tier === 'pro') return Infinity;
  return Math.max(0, info.trialMax - info.trialUsed);
}
