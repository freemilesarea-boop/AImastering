/**
 * 오디오 엔진 커스텀 훅
 * IPC 통신을 추상화하여 컴포넌트에서 간편하게 사용
 */
import { useCallback, useEffect } from 'react'
import { useAudioStore } from '../store/audioStore'
import { useAppStore } from '../store/appStore'
import { MasteringOptions } from '../types/audio'

export function useAudioEngine() {
  const {
    selectedFile,
    processingState,
    progress,
    currentStage,
    error,
    analysisResult,
    masteringResult,
    qcResult,
    masteringOptions,
    setSelectedFile,
    setFileInfo,
    setAnalysisResult,
    setProcessingState,
    setProgress,
    setError,
    setMasteringResult,
    setQCResult,
    reset,
  } = useAudioStore()

  const { showNotification } = useAppStore()

  // 진행률 이벤트 구독
  useEffect(() => {
    const cleanup = window.electronAPI.on('audio:progress', (data) => {
      const progress = data as { jobId: string; percent: number; stage: string }
      setProgress(progress)
    })
    return cleanup
  }, [setProgress])

  /**
   * 파일 선택 및 초기 분석
   */
  const selectAndAnalyze = useCallback(async (filePath: string) => {
    try {
      // 파일 기본 정보 가져오기
      const infoResp = await window.electronAPI.invoke<{
        success: boolean
        data: { name: string; size: number; ext: string }
      }>('file:get-info', { filePath })

      if (infoResp.success) {
        setFileInfo(infoResp.data)
      }

      setSelectedFile(filePath)
      setProcessingState('analyzing')
      setError(null)

      const resp = await window.electronAPI.invoke<{
        success: boolean
        data: typeof analysisResult
        error?: string
      }>('audio:analyze', { filePath })

      if (!resp.success) {
        throw new Error(resp.error || '분석 실패')
      }

      setAnalysisResult(resp.data)
      setProcessingState('idle')
      return resp.data
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      showNotification('error', `분석 오류: ${message}`)
      return null
    }
  }, [setSelectedFile, setFileInfo, setProcessingState, setError, setAnalysisResult, showNotification, analysisResult])

  /**
   * 파일 선택 대화상자 열기
   */
  const openFileDialog = useCallback(async () => {
    const paths = await window.electronAPI.invoke<string[] | null>('file:open-dialog')
    if (paths && paths.length > 0) {
      await selectAndAnalyze(paths[0])
    }
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
        success: boolean
        data: typeof masteringResult
        error?: string
      }>('audio:master', { filePath: selectedFile, options: { ...masteringOptions, ...options } })

      if (!resp.success) {
        throw new Error(resp.error || '마스터링 실패')
      }

      setMasteringResult(resp.data)
      setProcessingState('done')
      showNotification('success', '마스터링이 완료되었습니다!')
      return resp.data
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      showNotification('error', `마스터링 오류: ${message}`)
      return null
    }
  }, [selectedFile, masteringOptions, setProcessingState, setError, setMasteringResult, showNotification, masteringResult])

  /**
   * QC 검사 실행
   */
  const runQC = useCallback(async (filePath?: string) => {
    const targetPath = filePath || masteringResult?.outputPath || selectedFile
    if (!targetPath) {
      showNotification('error', 'QC할 파일이 없습니다.')
      return null
    }

    try {
      const resp = await window.electronAPI.invoke<{
        success: boolean
        data: typeof qcResult
        error?: string
      }>('audio:qc', { filePath: targetPath })

      if (!resp.success) {
        throw new Error(resp.error || 'QC 검사 실패')
      }

      setQCResult(resp.data)
      return resp.data
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showNotification('error', `QC 오류: ${message}`)
      return null
    }
  }, [selectedFile, masteringResult, qcResult, showNotification, setQCResult])

  /**
   * Finder/Explorer에서 파일 열기
   */
  const showInFinder = useCallback(async (filePath: string) => {
    await window.electronAPI.invoke('file:open-in-finder', { filePath })
  }, [])

  return {
    // 상태
    selectedFile,
    processingState,
    progress,
    currentStage,
    error,
    analysisResult,
    masteringResult,
    qcResult,
    masteringOptions,
    isIdle: processingState === 'idle',
    isAnalyzing: processingState === 'analyzing',
    isProcessing: processingState === 'processing',
    isDone: processingState === 'done',
    isError: processingState === 'error',

    // 액션
    selectAndAnalyze,
    openFileDialog,
    startMastering,
    runQC,
    showInFinder,
    reset,
  }
}
