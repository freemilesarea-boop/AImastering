/**
 * 라이센스 상태 스토어 (Zustand)
 */
import { create } from 'zustand'
import { LicenseInfo } from '../types/license'

interface LicenseState {
  licenseInfo: LicenseInfo | null
  isLoading: boolean
  showModal: boolean

  setLicenseInfo: (info: LicenseInfo) => void
  setLoading: (loading: boolean) => void
  setShowModal: (show: boolean) => void
}

export const useLicenseStore = create<LicenseState>((set) => ({
  licenseInfo: null,
  isLoading: false,
  showModal: false,

  setLicenseInfo: (info) => set({ licenseInfo: info }),
  setLoading: (loading) => set({ isLoading: loading }),
  setShowModal: (show) => set({ showModal: show }),
}))
