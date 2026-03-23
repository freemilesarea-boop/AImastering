/**
 * 오디오 엔진 커스텀 훅 v2
 * IPC 통신 추상화 + 에러 사용자 친화적 표시
 */
import { useCallback, useEffect } from 'react'
import { useAudioStore } from '../store/audioStore'
import { useAppStore } from '../store/appStore'
import { MasteringOptions } from '../types/audio'

export function useAudioEngine() {
  const {
    selectedFile, fileInfo, analysisResult,
    processingState, progress, currentStage, error,
    masteringResult, qcResult, masteringOptions,
    setSelectedFile, setFileInfo, setAnalysisResult,
    setProcessingState, setProgress, setError,
    setMasteringResult, setQCResult, updateMasteringOptions,
    reset,
  } = useAudioStore()

  const { showNotification } = useAppStore()

  // 진행률 이벤트 구독
  useEffect(() => {
    const cleanup = window.electronAPI.on('audio:progress', (data) => {
      const p = data as { jobId: string; percent: number; stage: string }
      setProgress(p)
    })
    return cleanup
  }, [setProgress])

  /**
   * 파일 선택 + 분석
   */
  const selectAndAnalyze = useCallback(async (filePath: string) => {
    try {
      // 파일 기본 정보
      const infoResp = await window.electronAPI.invoke<{
        success: boolean
        data:    { name: string; size: number; ext: string }
      }>('file:get-info', { filePath })
      if (infoResp.success) setFileInfo(infoResp.data)

      setSelectedFile(filePath)
      setProcessingState('analyzing')
      setError(null)

      const resp = await window.electronAPI.invoke<{
        success: boolean
        data:    typeof analysisResult
        error?:  string
      }>('audio:analyze', { filePath })

      if (!resp.success) throw new Error(resp.error || '분석 실패')

      setAnalysisResult(resp.data)
      setProcessingState('idle')
      return resp.data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      showNotification('error', msg)
      return null
    }
  }, [setSelectedFile, setFileInfo, setProcessingState, setError, setAnalysisResult, showNotification, analysisResult])

  /**
   * 파일 선택 대화상자
   */
  const openFileDialog = useCallback(async () => {
    const paths = await window.electronAPI.invoke<string[] | null>('file:open-dialog')
    if (paths?.[0]) await selectAndAnalyze(paths[0])
  }, [selectAndAnalyze])

  /**
   * 마스터링 실행
   */
  const startMastering = useCallback(async (options?: Partial<MasteringOptions>) => {
    if (!selectedFile) {
      showNotification('error', '파일을 먼저 선택하세요.')
      return null
    }
    try {
      setProcessingState('processing')
      setError(null)

      const resp = await window.electronAPI.invoke<{
        success:          boolean
        data:             typeof masteringResult
        error?:           string
        requiresLicense?: boolean
        isPaid?:          boolean
      }>('audio:master', {
        filePath: selectedFile,
        options:  { ...masteringOptions, ...options },
      })

      if (!resp.success) {
        if (resp.requiresLicense) {
          showNotification('warning', resp.error || '라이센스가 필요합니다.')
        } else {
          showNotification('error', resp.error || '마스터링 실패')
        }
        setError(resp.error || '알 수 없는 오류')
        return null
      }

      setMasteringResult(resp.data)
      setProcessingState('done')
      showNotification('success', resp.isPaid ? '마스터링 완료! Master WAV 저장됨' : '마스터링 완료! Preview MP3 저장됨')
      return resp.data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      showNotification('error', msg)
      return null
    }
  }, [selectedFile, masteringOptions, setProcessingState, setError, setMasteringResult, showNotification, masteringResult])

  /**
   * QC 검사
   */
  const runQC = useCallback(async (filePath?: string) => {
    const target = filePath || masteringResult?.outputPath || masteringResult?.previewPath || selectedFile
    if (!target) { showNotification('error', 'QC할 파일이 없습니다.'); return null }

    try {
      const resp = await window.electronAPI.invoke<{
        success: boolean
        data:    typeof qcResult
        error?:  string
      }>('audio:qc', { filePath: target })

      if (!resp.success) throw new Error(resp.error || 'QC 실패')

      setQCResult(resp.data)
      return resp.data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showNotification('error', msg)
      return null
    }
  }, [selectedFile, masteringResult, qcResult, showNotification, setQCResult])

  /**
   * Finder에서 파일 위치 열기
   */
  const showInFinder = useCallback(async (filePath: string) => {
    if (!filePath) return
    await window.electronAPI.invoke('file:open-in-finder', { filePath })
  }, [])

  return {
    selectedFile, fileInfo, analysisResult,
    processingState, progress, currentStage, error,
    masteringResult, qcResult, masteringOptions,
    isIdle:       processingState === 'idle',
    isAnalyzing:  processingState === 'analyzing',
    isProcessing: processingState === 'processing',
    isDone:       processingState === 'done',
    isError:      processingState === 'error',
    // Actions
    selectAndAnalyze, openFileDialog,
    startMastering, runQC, showInFinder, reset,
    updateMasteringOptions,
  }
}
