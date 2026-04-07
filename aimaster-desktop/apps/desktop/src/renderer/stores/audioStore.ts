import { create } from 'zustand';
import type {
  AudioAnalysisResult,
  MasteringResult,
  QCResult,
  MasteringStyle,
} from '@aimaster/shared-types';

// ── Structured error ──────────────────────────────────────────────────────────

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

export function toStructuredError(err: unknown): StructuredError {
  if (err != null && typeof err === 'object') {
    const o = err as Record<string, unknown>;

    // 1. Already a fully-structured AppError (same-process or future Electron versions)
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

    // 2. Electron IPC wraps errors as:
    //    "Error invoking remote method 'audio:xxx': AppError: {json}"
    //    Extract the JSON part and decode it.
    if (typeof o['message'] === 'string') {
      const msg = o['message'] as string;
      // Find the first '{' to extract the JSON payload
      const jsonStart = msg.indexOf('{');
      if (jsonStart !== -1) {
        try {
          const parsed = JSON.parse(msg.slice(jsonStart)) as Record<string, unknown>;
          if (
            parsed['__appError'] === true &&
            typeof parsed['code']        === 'string' &&
            typeof parsed['userMessage'] === 'string' &&
            typeof parsed['devDetail']   === 'string' &&
            typeof parsed['recoverable'] === 'boolean'
          ) {
            return {
              code:        parsed['code']        as AppErrorCode,
              userMessage: parsed['userMessage'] as string,
              devDetail:   parsed['devDetail']   as string,
              recoverable: parsed['recoverable'] as boolean,
            };
          }
        } catch { /* not valid JSON — fall through */ }
      }
      return { code: 'UNKNOWN', userMessage: msg, devDetail: msg, recoverable: true };
    }
  }
  return { code: 'UNKNOWN', userMessage: '알 수 없는 오류가 발생했습니다.', devDetail: String(err), recoverable: true };
}

// ── Queue item ────────────────────────────────────────────────────────────────

export type QueueStatus = 'pending' | 'analyzing' | 'mastering' | 'done' | 'error';

export interface QueueItem {
  id: string;
  filePath: string;
  fileName: string;
  status: QueueStatus;
  analysis?: AudioAnalysisResult;
  masteringResult?: MasteringResult;
  error?: StructuredError;
  progress: number;
  progressStage: string;
}

export const MAX_QUEUE_SIZE = 20;

// ── Mastering options ─────────────────────────────────────────────────────────

export interface MasteringOptions {
  style: MasteringStyle;
  targetLufs: number;
  targetTp: number;
  sampleRate: number;
  bitDepth: 16 | 24;
  applyAiCorrections: boolean;
}

const defaultOptions: MasteringOptions = {
  style:              'balanced',
  targetLufs:         -14.5,
  targetTp:           -1.0,
  sampleRate:         44100,
  bitDepth:           24,
  applyAiCorrections: true,
};

// ── Store ─────────────────────────────────────────────────────────────────────

interface AudioStore {
  // ── Multi-file queue ───────────────────────────────────────────────────
  queue: QueueItem[];
  isBatchRunning: boolean;
  addFilesToQueue: (paths: string[]) => void;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;
  updateQueueItem: (id: string, updates: Partial<Omit<QueueItem, 'id'>>) => void;
  setIsBatchRunning: (v: boolean) => void;

  // ── Single-file (used by AnalysisPage / MasteringPage / ResultPage) ────
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

function baseName(p: string): string {
  return p.split('/').pop()?.split('\\').pop() ?? p;
}

export const useAudioStore = create<AudioStore>((set) => ({
  // ── Queue ──────────────────────────────────────────────────────────────
  queue: [],
  isBatchRunning: false,

  addFilesToQueue: (paths) => set((s) => {
    const existing = new Set(s.queue.map((i) => i.filePath));
    const slots = MAX_QUEUE_SIZE - s.queue.length;
    const newItems: QueueItem[] = paths
      .filter((p) => !existing.has(p))
      .slice(0, slots)
      .map((p) => ({
        id:            crypto.randomUUID(),
        filePath:      p,
        fileName:      baseName(p),
        status:        'pending',
        progress:      0,
        progressStage: '',
      }));
    return { queue: [...s.queue, ...newItems] };
  }),

  removeFromQueue: (id) => set((s) => ({
    queue: s.queue.filter((i) => i.id !== id),
  })),

  clearQueue: () => set({ queue: [] }),

  updateQueueItem: (id, updates) => set((s) => ({
    queue: s.queue.map((item) =>
      item.id === id ? { ...item, ...updates } : item
    ),
  })),

  setIsBatchRunning: (v) => set({ isBatchRunning: v }),

  // ── Single-file ────────────────────────────────────────────────────────
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

  setFile:            (path)       => set({ selectedFile: path, analysis: null, masteringResult: null, qcResult: null, error: null }),
  setAnalysis:        (r)          => set({ analysis: r }),
  setMasteringResult: (r)          => set({ masteringResult: r }),
  setQcResult:        (r)          => set({ qcResult: r }),
  setIsAnalyzing:     (v)          => set({ isAnalyzing: v }),
  setIsMastering:     (v)          => set({ isMastering: v }),
  setProgress:        (pct, stage) => set({ progress: pct, progressStage: stage }),
  setError:           (err)        => set({ error: err }),
  setStyle:           (style)      => set((s) => ({ options: { ...s.options, style } })),
  reset:              ()           => set({ selectedFile: null, analysis: null, masteringResult: null, qcResult: null, error: null, progress: 0, progressStage: '', queue: [], isBatchRunning: false }),
}));
