/**
 * 오디오 처리 상태 스토어 (Zustand)
 */
import { create } from 'zustand'
import { AudioAnalysisResult, MasteringResult, MasteringOptions, QCResult, ProgressEvent } from '../types/audio'

type ProcessingState = 'idle' | 'analyzing' | 'processing' | 'done' | 'error'

interface AudioState {
  // 현재 선택된 파일
  selectedFile: string | null
  fileInfo: { name: string; size: number; ext: string } | null

  // 분석 결과
  analysisResult: AudioAnalysisResult | null

  // 처리 상태
  processingState: ProcessingState
  progress: number        // 0-100
  currentStage: string    // 현재 처리 단계 설명
  error: string | null

  // 마스터링 결과
  masteringResult: MasteringResult | null

  // QC 결과
  qcResult: QCResult | null

  // 마스터링 옵션
  masteringOptions: Partial<MasteringOptions>

  // Actions
  setSelectedFile: (path: string | null) => void
  setFileInfo: (info: AudioState['fileInfo']) => void
  setAnalysisResult: (result: AudioAnalysisResult | null) => void
  setProcessingState: (state: ProcessingState) => void
  setProgress: (progress: ProgressEvent) => void
  setError: (error: string | null) => void
  setMasteringResult: (result: MasteringResult | null) => void
  setQCResult: (result: QCResult | null) => void
  updateMasteringOptions: (opts: Partial<MasteringOptions>) => void
  reset: () => void
}

const initialState = {
  selectedFile: null,
  fileInfo: null,
  analysisResult: null,
  processingState: 'idle' as ProcessingState,
  progress: 0,
  currentStage: '',
  error: null,
  masteringResult: null,
  qcResult: null,
  masteringOptions: {
    preset: 'youtube_music',
    targetLUFS: -14,
    targetTruePeak: -1.0,
    enableEQ: true,
    enableCompression: true,
    enableStereoEnhance: false,
    outputFormat: 'wav' as const,
    outputBitDepth: 24 as const,
    outputSampleRate: 44100 as const,
  },
}

export const useAudioStore = create<AudioState>((set) => ({
  ...initialState,

  setSelectedFile: (path) => set({ selectedFile: path, error: null }),
  setFileInfo: (info) => set({ fileInfo: info }),
  setAnalysisResult: (result) => set({ analysisResult: result }),
  setProcessingState: (state) => set({ processingState: state }),

  setProgress: ({ percent, stage }: ProgressEvent) =>
    set({ progress: percent, currentStage: stage }),

  setError: (error) => set({ error, processingState: error ? 'error' : 'idle' }),
  setMasteringResult: (result) => set({ masteringResult: result }),
  setQCResult: (result) => set({ qcResult: result }),

  updateMasteringOptions: (opts) =>
    set((state) => ({ masteringOptions: { ...state.masteringOptions, ...opts } })),

  reset: () => set(initialState),
}))
