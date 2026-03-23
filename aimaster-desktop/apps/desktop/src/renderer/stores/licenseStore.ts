import { create } from 'zustand';
import type { LicenseInfo } from '@aimaster/shared-types';

interface LicenseStore {
  licenseInfo: LicenseInfo | null;
  isLoading: boolean;
  showModal: boolean;
  setLicenseInfo: (info: LicenseInfo) => void;
  setLoading: (v: boolean) => void;
  setShowModal: (v: boolean) => void;
}

export const useLicenseStore = create<LicenseStore>((set) => ({
  licenseInfo: null,
  isLoading: false,
  showModal: false,
  setLicenseInfo: (info) => set({ licenseInfo: info }),
  setLoading: (v) => set({ isLoading: v }),
  setShowModal: (v) => set({ showModal: v }),
}));
