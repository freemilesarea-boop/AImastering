/**
 * 오디오 처리 상태 스토어 (Zustand) — v2
 */
import { create } from 'zustand'
import {
  AudioAnalysisResult,
  MasteringResult,
  MasteringOptions,
  QCResult,
  ProgressEvent,
  MasteringStyle,
} from '../types/audio'

export type ProcessingState = 'idle' | 'analyzing' | 'processing' | 'done' | 'error'

interface AudioState {
  // 선택 파일
  selectedFile: string | null
  fileInfo: { name: string; size: number; ext: string } | null

  // 분석 결과
  analysisResult: AudioAnalysisResult | null

  // 처리 상태
  processingState: ProcessingState
  progress:        number
  currentStage:    string
  error:           string | null

  // 마스터링 결과
  masteringResult: MasteringResult | null

  // QC 결과
  qcResult: QCResult | null

  // 마스터링 옵션
  masteringOptions: Partial<MasteringOptions>

  // Actions
  setSelectedFile:       (path: string | null) => void
  setFileInfo:           (info: AudioState['fileInfo']) => void
  setAnalysisResult:     (result: AudioAnalysisResult | null) => void
  setProcessingState:    (state: ProcessingState) => void
  setProgress:           (progress: ProgressEvent) => void
  setError:              (error: string | null) => void
  setMasteringResult:    (result: MasteringResult | null) => void
  setQCResult:           (result: QCResult | null) => void
  updateMasteringOptions:(opts: Partial<MasteringOptions>) => void
  setStyle:              (style: MasteringStyle) => void
  reset:                 () => void
}

const initialOptions: Partial<MasteringOptions> = {
  style:               'balanced',
  targetLUFS:          -14,
  targetTruePeak:      -1.0,
  enableEQ:            true,
  enableCompression:   true,
  enableStereoEnhance: false,
  outputFormat:        'wav',
  outputBitDepth:      24,
  outputSampleRate:    44100,
}

const initialState = {
  selectedFile:     null,
  fileInfo:         null,
  analysisResult:   null,
  processingState:  'idle' as ProcessingState,
  progress:         0,
  currentStage:     '',
  error:            null,
  masteringResult:  null,
  qcResult:         null,
  masteringOptions: initialOptions,
}

export const useAudioStore = create<AudioState>((set) => ({
  ...initialState,

  setSelectedFile:    (path)   => set({ selectedFile: path, error: null }),
  setFileInfo:        (info)   => set({ fileInfo: info }),
  setAnalysisResult:  (result) => set({ analysisResult: result }),
  setProcessingState: (state)  => set({ processingState: state }),

  setProgress: ({ percent, stage }: ProgressEvent) =>
    set({ progress: percent, currentStage: stage }),

  setError: (error) =>
    set({ error, processingState: error ? 'error' : 'idle' }),

  setMasteringResult:    (result) => set({ masteringResult: result }),
  setQCResult:           (result) => set({ qcResult: result }),

  updateMasteringOptions: (opts) =>
    set((state) => ({ masteringOptions: { ...state.masteringOptions, ...opts } })),

  setStyle: (style) =>
    set((state) => ({ masteringOptions: { ...state.masteringOptions, style } })),

  reset: () => set(initialState),
}))
