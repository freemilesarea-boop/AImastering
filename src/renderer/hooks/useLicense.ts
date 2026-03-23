/**
 * 라이센스 상태 커스텀 훅 v2
 */
import { useCallback, useEffect } from 'react'
import { useLicenseStore } from '../store/licenseStore'
import { useAppStore } from '../store/appStore'
import { LicenseInfo } from '../types/license'

export function useLicense() {
  const { licenseInfo, isLoading, showModal, setLicenseInfo, setLoading, setShowModal } = useLicenseStore()
  const { showNotification } = useAppStore()

  useEffect(() => { loadStatus() }, [])

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await window.electronAPI.invoke<{ success: boolean; data: LicenseInfo }>('license:status')
      if (resp.success) setLicenseInfo(resp.data)
    } catch (err) {
      console.error('License load error:', err)
    } finally {
      setLoading(false)
    }
  }, [setLicenseInfo, setLoading])

  const activate = useCallback(async (key: string): Promise<boolean> => {
    setLoading(true)
    try {
      const resp = await window.electronAPI.invoke<{
        success: boolean
        data:    { success: boolean; message: string; tier?: string }
        error?:  string
      }>('license:activate', { key })

      if (resp.success && resp.data.success) {
        showNotification('success', '라이센스가 활성화되었습니다!')
        await loadStatus()
        setShowModal(false)
        return true
      }
      showNotification('error', resp.data?.message || resp.error || '활성화 실패')
      return false
    } catch {
      showNotification('error', '서버에 연결할 수 없습니다.')
      return false
    } finally {
      setLoading(false)
    }
  }, [setLoading, showNotification, loadStatus, setShowModal])

  const deactivate = useCallback(async () => {
    if (!confirm('라이센스를 비활성화하시겠습니까?\n이 기기에서 유료 기능을 사용할 수 없게 됩니다.')) return
    setLoading(true)
    try {
      await window.electronAPI.invoke('license:deactivate')
      showNotification('info', '라이센스가 비활성화되었습니다.')
      await loadStatus()
    } finally {
      setLoading(false)
    }
  }, [setLoading, showNotification, loadStatus])

  const isTrial   = licenseInfo?.tier === 'free_trial'
  const isPro     = licenseInfo?.tier === 'pro' || licenseInfo?.tier === 'enterprise'
  const trialRemaining = licenseInfo ? licenseInfo.trialMax - licenseInfo.trialUsed : 0

  return {
    licenseInfo,
    isLoading,
    showModal,
    setShowModal,
    activate,
    deactivate,
    refresh: loadStatus,
    isValid:  licenseInfo?.isValid ?? false,
    isPro,
    isTrial,
    trialRemaining,
    canSaveMasterWav: licenseInfo?.canSaveMasterWav ?? false,
    canExportReport:  licenseInfo?.canExportReport  ?? false,
    canUseAllPresets: licenseInfo?.canUseAllPresets  ?? false,
  }
}
