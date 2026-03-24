import { create } from 'zustand';
import type {
  AudioAnalysisResult,
  MasteringResult,
  QCResult,
  MasteringStyle,
} from '@aimaster/shared-types';

export interface MasteringOptions {
  style: MasteringStyle;
  targetLufs: number;
  targetTp: number;
  sampleRate: number;
  bitDepth: 16 | 24;
  applyAiCorrections: boolean;
}

interface AudioStore {
  selectedFile: string | null;
  analysis: AudioAnalysisResult | null;
  masteringResult: MasteringResult | null;
  qcResult: QCResult | null;
  isAnalyzing: boolean;
  isMastering: boolean;
  progress: number;
  progressStage: string;
  error: string | null;
  options: MasteringOptions;

  setFile: (path: string | null) => void;
  setAnalysis: (r: AudioAnalysisResult | null) => void;
  setMasteringResult: (r: MasteringResult | null) => void;
  setQcResult: (r: QCResult | null) => void;
  setIsAnalyzing: (v: boolean) => void;
  setIsMastering: (v: boolean) => void;
  setProgress: (percent: number, stage: string) => void;
  setError: (msg: string | null) => void;
  setStyle: (style: MasteringStyle) => void;
  reset: () => void;
}

const defaultOptions: MasteringOptions = {
  style:              'balanced',
  targetLufs:         -14,
  targetTp:           -1.0,
  sampleRate:         44100,
  bitDepth:           24,
  applyAiCorrections: true,
};

export const useAudioStore = create<AudioStore>((set) => ({
  selectedFile:    null,
  analysis:        null,
  masteringResult: null,
  qcResult:        null,
  isAnalyzing:     false,
  isMastering:     false,
  progress:        0,
  progressStage:   '',
  error:           null,
  options:         defaultOptions,

  setFile:           (path)         => set({ selectedFile: path, analysis: null, masteringResult: null, qcResult: null, error: null }),
  setAnalysis:       (r)            => set({ analysis: r }),
  setMasteringResult:(r)            => set({ masteringResult: r }),
  setQcResult:       (r)            => set({ qcResult: r }),
  setIsAnalyzing:    (v)            => set({ isAnalyzing: v }),
  setIsMastering:    (v)            => set({ isMastering: v }),
  setProgress:       (pct, stage)   => set({ progress: pct, progressStage: stage }),
  setError:          (msg)          => set({ error: msg }),
  setStyle:          (style)        => set((s) => ({ options: { ...s.options, style } })),
  reset:             ()             => set({ selectedFile: null, analysis: null, masteringResult: null, qcResult: null, error: null, progress: 0, progressStage: '' }),
}));
