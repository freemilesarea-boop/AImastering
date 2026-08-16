import { create } from 'zustand';
import type {
  AudioAnalysisResult,
  MasteringResult,
  QCResult,
  MasteringStyle,
  LimiterStrength,
} from '@aimaster/shared-types';
import type { RevisionGroup, RevisionInput } from '../audio/revisions/revision-types.js';
import {
  addRevision as addRevisionToGroup,
  setActiveRevision as setActiveInGroup,
  removeRevision as removeFromGroup,
  renameRevision as renameInGroup,
  toggleFavorite as toggleFavoriteInGroup,
} from '../audio/revisions/revision-logic.js';
import { savedSongPaths, loadSongSettings } from '../audio/session/song-settings.js';

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
  /** Per-file Loui preset override (undefined = use the global options). */
  presetId: string | undefined;
  /**
   * Epoch ms of the last Studio save for this file, or undefined.
   *
   * A marker only — the settings themselves live in `song-settings`, keyed
   * by absolute path so they outlive both this queue item and the app
   * session. This field exists so a queue row can show "저장됨" without
   * every row parsing storage on every render.
   */
  studioSavedAt?: number;
}

export const MAX_QUEUE_SIZE = 20;

// ── Mastering options ─────────────────────────────────────────────────────────

/**
 * Real-time DSP overrides — applied LIVE to the preview audio element via
 * the WebAudio native DSP chain on ResultPage.  Values mirror
 * RealtimeChainConfig.  Each field is optional; undefined means the
 * field is omitted from the chain config (chain falls back to its own
 * default).  ALL fields default to a neutral pass-through value so the
 * sliders read "0 dB / 100 %" before the user touches anything.
 */
export interface RealtimeDspOverrides {
  eqLowCutHz?:    number; eqLowShelfDb?: number;
  eqPresenceDb?:  number; eqAirDb?:      number;
  dynThresholdDb?: number; dynRatio?:     number;
  dynAttackMs?:    number; dynReleaseMs?: number;
  dynMixPct?:      number;
  imgWidthPct?:  number; imgLowMonoHz?: number;
  limCeilingDbtp?: number;
  eqBypass?: boolean; dynBypass?: boolean; imgBypass?: boolean; limBypass?: boolean;
  masterBypass?: boolean;
}

export interface MasteringOptions {
  style: MasteringStyle;
  targetLufs: number;
  targetTp: number;
  sampleRate: number;
  bitDepth: 16 | 24;
  applyAiCorrections: boolean;
  // v3 신규
  limiterStrength: LimiterStrength;
  saturationAmount?: number | undefined;     // undefined = 모드 기본값
  stereoWidth?: number | undefined;          // undefined = 모드 기본값
  outputGainDb?: number | undefined;         // undefined = 0
  /** Dynamic EQ intensity (0=off, 1=full).  undefined = 1.0 (full). */
  dynamicEqIntensity?: number | undefined;
  /** UI 상태: 어떤 빠른 프리셋이 선택되어 있는지 */
  quickPreset?: string | undefined;
  /** Live DSP overrides — applied to the WebAudio preview chain. */
  rt?: RealtimeDspOverrides;
}

const defaultRtOverrides: RealtimeDspOverrides = {
  eqLowCutHz:     20,
  eqLowShelfDb:   0,
  eqPresenceDb:   0,
  eqAirDb:        0,
  dynThresholdDb: -18,
  dynRatio:       2,
  dynAttackMs:    10,
  dynReleaseMs:   120,
  dynMixPct:      100,
  imgWidthPct:    100,
  imgLowMonoHz:   120,
  limCeilingDbtp: -1,
  eqBypass:       false,
  dynBypass:      false,
  imgBypass:      false,
  limBypass:      false,
  masterBypass:   false,
};

const defaultOptions: MasteringOptions = {
  style:              'balanced',
  targetLufs:         -14,
  targetTp:           -1.0,
  sampleRate:         44100,
  bitDepth:           24,
  applyAiCorrections: true,
  limiterStrength:    'medium',
  rt:                 defaultRtOverrides,
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
  /**
   * The one preset the whole batch is finished with, or null.
   *
   * Deliberately global rather than per-item: an album is meant to come out
   * at one loudness, and a per-song copy of this would be twenty chances to
   * end up with one track 3 LU quieter than the rest. Per-song intent is
   * carried by the saved Studio settings instead, which win over this.
   */
  albumPresetId: string | null;
  setAlbumPreset: (id: string | null) => void;
  /** Re-read which queued files have saved Studio settings. */
  refreshStudioSaved: () => void;

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
  /** v3 — 임의 옵션 부분 업데이트 (sliders 용) */
  updateOptions: (patch: Partial<MasteringOptions>) => void;
  reset: () => void;

  /** Advanced Settings 패널 펼침 여부 */
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;

  // ── Reference track for A/B comparison ────────────────────────────────
  /** Absolute path to a user-loaded reference audio file (null = none). */
  referenceFilePath: string | null;
  setReferenceFile: (path: string | null) => void;
  /**
   * Integrated LUFS of the reference track measured via audio:analyze.
   * null = reference loaded but measurement still in progress (LU comp disabled).
   * undefined-like state = no reference (referenceFilePath is null).
   */
  referenceLufs: number | null;
  setReferenceLufs: (lufs: number | null) => void;

  // ── Revision workflow (M3-REVISION-WORKFLOW) ───────────────────────────
  /** Multiple mastering versions of the active source file.  null = none. */
  revisionGroup: RevisionGroup | null;
  /** Append a revision (becomes active).  Starts a group if needed / source changed. */
  addRevision: (input: RevisionInput) => void;
  /** Select an existing revision as active. */
  setActiveRevision: (id: string) => void;
  /** Remove a revision (never the last; source untouched). */
  removeRevision: (id: string) => void;
  renameRevision: (id: string, label: string) => void;
  toggleRevisionFavorite: (id: string) => void;
  /** Clear the revision group (e.g. on new source / queue clear). */
  clearRevisions: () => void;
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
        status:        'pending' as const,
        progress:      0,
        progressStage: '',
        presetId:      undefined,
      }));
    return { queue: [...s.queue, ...newItems] };
  }),

  removeFromQueue: (id) => set((s) => ({
    queue: s.queue.filter((i) => i.id !== id),
  })),

  clearQueue: () => set({ queue: [], revisionGroup: null }),

  updateQueueItem: (id, updates) => set((s) => ({
    queue: s.queue.map((item) =>
      item.id === id ? { ...item, ...updates } : item
    ),
  })),

  setIsBatchRunning: (v) => set({ isBatchRunning: v }),

  albumPresetId: null,
  setAlbumPreset: (id) => set({ albumPresetId: id }),

  refreshStudioSaved: () => set((s) => {
    // One storage read for the whole queue rather than one per row.
    const saved = new Set(savedSongPaths());
    let changed = false;
    const queue = s.queue.map((item) => {
      const has = saved.has(item.filePath);
      if (has === (item.studioSavedAt !== undefined)) return item;
      changed = true;
      const next = { ...item };
      if (has) next.studioSavedAt = loadSongSettings(item.filePath)?.savedAt ?? Date.now();
      else delete next.studioSavedAt;
      return next;
    });
    // Returning the same array when nothing moved keeps subscribers still.
    return changed ? { queue } : {};
  }),

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
  setStyle:           (style)      => set((s) => ({ options: { ...s.options, style, quickPreset: undefined } })),
  updateOptions:      (patch)      => set((s) => ({ options: { ...s.options, ...patch } })),
  reset:              ()           => set({ selectedFile: null, analysis: null, masteringResult: null, qcResult: null, error: null, progress: 0, progressStage: '', queue: [], isBatchRunning: false, revisionGroup: null }),

  showAdvanced:       false,
  setShowAdvanced:    (v)          => set({ showAdvanced: v }),

  // ── Reference track ─────────────────────────────────────────────────
  referenceFilePath: null,
  // Clear referenceLufs whenever the reference file is removed.
  setReferenceFile: (path) => set({ referenceFilePath: path, ...(path === null ? { referenceLufs: null } : {}) }),
  referenceLufs: null,
  setReferenceLufs: (lufs) => set({ referenceLufs: lufs }),

  // ── Revision workflow ────────────────────────────────────────────────
  revisionGroup: null,
  addRevision:          (input)    => set((s) => ({ revisionGroup: addRevisionToGroup(s.revisionGroup, input) })),
  setActiveRevision:    (id)       => set((s) => ({ revisionGroup: s.revisionGroup ? setActiveInGroup(s.revisionGroup, id) : s.revisionGroup })),
  removeRevision:       (id)       => set((s) => ({ revisionGroup: s.revisionGroup ? removeFromGroup(s.revisionGroup, id) : s.revisionGroup })),
  renameRevision:       (id, l)    => set((s) => ({ revisionGroup: s.revisionGroup ? renameInGroup(s.revisionGroup, id, l) : s.revisionGroup })),
  toggleRevisionFavorite: (id)     => set((s) => ({ revisionGroup: s.revisionGroup ? toggleFavoriteInGroup(s.revisionGroup, id) : s.revisionGroup })),
  clearRevisions:       ()         => set({ revisionGroup: null }),
}));
