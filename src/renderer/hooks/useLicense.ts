/**
 * 라이센스 상태 커스텀 훅
 */
import { useCallback, useEffect } from 'react'
import { useLicenseStore } from '../store/licenseStore'
import { useAppStore } from '../store/appStore'
import { LicenseInfo } from '../types/license'

export function useLicense() {
  const { licenseInfo, isLoading, showModal, setLicenseInfo, setLoading, setShowModal } = useLicenseStore()
  const { showNotification } = useAppStore()

  // 앱 시작 시 라이센스 상태 로드
  useEffect(() => {
    loadStatus()
  }, [])

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await window.electronAPI.invoke<{ success: boolean; data: LicenseInfo }>('license:status')
      if (resp.success) {
        setLicenseInfo(resp.data)
      }
    } catch (err) {
      console.error('License status load error:', err)
    } finally {
      setLoading(false)
    }
  }, [setLicenseInfo, setLoading])

  const activate = useCallback(async (key: string) => {
    setLoading(true)
    try {
      const resp = await window.electronAPI.invoke<{
        success: boolean
        data: { success: boolean; message: string; tier?: string }
        error?: string
      }>('license:activate', { key })

      if (resp.success && resp.data.success) {
        showNotification('success', '라이센스가 활성화되었습니다!')
        await loadStatus()
        setShowModal(false)
        return true
      } else {
        showNotification('error', resp.data.message || resp.error || '활성화 실패')
        return false
      }
    } catch (err) {
      showNotification('error', '라이센스 서버에 연결할 수 없습니다.')
      return false
    } finally {
      setLoading(false)
    }
  }, [setLoading, showNotification, loadStatus, setShowModal])

  const deactivate = useCallback(async () => {
    if (!confirm('라이센스를 비활성화하시겠습니까? 이 기기에서 사용이 중단됩니다.')) return
    setLoading(true)
    try {
      await window.electronAPI.invoke('license:deactivate')
      showNotification('info', '라이센스가 비활성화되었습니다.')
      await loadStatus()
    } finally {
      setLoading(false)
    }
  }, [setLoading, showNotification, loadStatus])

  return {
    licenseInfo,
    isLoading,
    showModal,
    setShowModal,
    activate,
    deactivate,
    refresh: loadStatus,
    isValid: licenseInfo?.isValid ?? false,
    isPro: licenseInfo?.tier === 'pro' || licenseInfo?.tier === 'enterprise',
    isTrial: licenseInfo?.tier === 'free_trial',
    trialRemaining: licenseInfo ? licenseInfo.trialMax - licenseInfo.trialUsed : 0,
  }
}
