import { create } from 'zustand';
import type {
  AudioAnalysisResult,
  MasteringResult,
  QCResult,
  MasteringStyle,
} from '@aimaster/shared-types';

// ── Structured error type (mirrors AppError from audio-engine) ────────────────
// We define a plain-object version here because the renderer cannot import
// Node-only packages.  The main process serialises AppError via .toJSON()
// before sending it over IPC, and we reconstruct it here.

export type AppErrorCode =
  | 'FFMPEG_NOT_FOUND'
  | 'FFPROBE_NOT_FOUND'
  | 'FILE_CORRUPTED'
  | 'FORMAT_UNSUPPORTED'
  | 'PATH_ENCODING_ERROR'
  | 'OUTPUT_DIR_NOT_WRITABLE'
  | 'LOUDNORM_PARSE_FAILED'
  | 'PYTHON_PROCESS_FAILED'
  | 'LICENSE_STORE_CORRUPTED'
  | 'TRIAL_COUNT_ANOMALY'
  | 'UNKNOWN';

export interface StructuredError {
  code: AppErrorCode;
  userMessage: string;
  devDetail: string;
  recoverable: boolean;
}

/** Convert anything thrown from IPC into a StructuredError. */
export function toStructuredError(err: unknown): StructuredError {
  if (err != null && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (
      typeof o['code']        === 'string' &&
      typeof o['userMessage'] === 'string' &&
      typeof o['devDetail']   === 'string' &&
      typeof o['recoverable'] === 'boolean'
    ) {
      return {
        code:        o['code']        as AppErrorCode,
        userMessage: o['userMessage'] as string,
        devDetail:   o['devDetail']   as string,
        recoverable: o['recoverable'] as boolean,
      };
    }
    // Plain Error object
    if (typeof o['message'] === 'string') {
      return {
        code:        'UNKNOWN',
        userMessage: o['message'] as string,
        devDetail:   o['message'] as string,
        recoverable: true,
      };
    }
  }
  return {
    code:        'UNKNOWN',
    userMessage: '알 수 없는 오류가 발생했습니다.',
    devDetail:   String(err),
    recoverable: true,
  };
}

// ── Store ─────────────────────────────────────────────────────────────────────

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
  error: StructuredError | null;
  options: MasteringOptions;

  setFile: (path: string | null) => void;
  setAnalysis: (r: AudioAnalysisResult | null) => void;
  setMasteringResult: (r: MasteringResult | null) => void;
  setQcResult: (r: QCResult | null) => void;
  setIsAnalyzing: (v: boolean) => void;
  setIsMastering: (v: boolean) => void;
  setProgress: (percent: number, stage: string) => void;
  setError: (err: StructuredError | null) => void;
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
  setError:          (err)          => set({ error: err }),
  setStyle:          (style)        => set((s) => ({ options: { ...s.options, style } })),
  reset:             ()             => set({ selectedFile: null, analysis: null, masteringResult: null, qcResult: null, error: null, progress: 0, progressStage: '' }),
}));
