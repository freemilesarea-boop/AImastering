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
import type { MasteringHistory } from '../audio/mastering-history.js';
import {
  emptyHistory, entryFromRevision, addEntry as addHistoryEntry,
  removeEntry as removeHistoryEntryPure, renameEntry as renameHistoryEntryPure,
  toggleFavorite as toggleHistoryFavoritePure, getEntry as getHistoryEntry,
  serializeHistory, deserializeHistory,
} from '../audio/mastering-history.js';
import type { SectionMasteringPlan, SectionSegment, RebalancePreciseOptions } from '@aimaster/shared-types';
import {
  defaultSectionPlan, buildSectionPlanFromAnalysis,
  sanitizeSectionPlan, setSectionGain as setSectionGainPure,
} from '../audio/section-plan.js';
import {
  type ParametricEqBand,
  sanitizeBands,
  defaultBand,
  MAX_BANDS,
} from '../audio/modules/parametric-eq-model.js';
import {
  type MultibandConfig,
  type MultibandBand,
  defaultMultibandConfig,
  sanitizeMultiband,
} from '../audio/multiband-config.js';
import {
  type ImagerMultibandConfig,
  defaultImagerMultiband,
  sanitizeImagerMultiband,
} from '../audio/imager-config.js';
import {
  type SaturationConfig as SatConfig,
  defaultSaturationConfig,
  sanitizeSaturation,
} from '../audio/saturation-config.js';
import {
  type TransientConfig as TransConfig,
  type TransientBand,
  defaultTransientConfig,
  sanitizeTransient,
} from '../audio/transient-config.js';
import {
  type DynamicEqConfig as DynEqConfig,
  type DynEqBand,
  defaultDynamicEqConfig,
  defaultDynEqBand,
  sanitizeDynamicEq,
  MAX_DYNEQ_BANDS,
} from '../audio/dyneq-config.js';
import {
  type DeesserConfig,
  defaultDeesserConfig,
  sanitizeDeesser,
} from '../audio/deesser-config.js';
import {
  type RebalanceConfig,
  type StemId,
  defaultRebalanceConfig,
  sanitizeRebalance,
} from '../audio/rebalance-config.js';

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
  /** Phase 3 — precise stem rebalance (applied on the offline export). */
  rebalance?: RebalancePreciseOptions;
  /** P2 — per-section gain automation (applied on the offline export). */
  sectionPlan?: SectionMasteringPlan;
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

  // ── Durable mastering history (P2) ─────────────────────────────────────
  /** Cross-session library of past masters (settings + metrics). */
  history: MasteringHistory;
  /** Load persisted history from the main process (call once on startup). */
  hydrateHistory: () => Promise<void>;
  /** Record a master into durable history (write-through to disk). */
  pushHistoryEntry: (input: RevisionInput) => void;
  removeHistoryEntry: (id: string) => void;
  renameHistoryEntry: (id: string, label: string) => void;
  toggleHistoryFavorite: (id: string) => void;
  /** Restore an entry's options snapshot back into the active options. */
  restoreHistoryEntry: (id: string) => void;

  // ── Per-section mastering (P2) ─────────────────────────────────────────
  /** Editable per-section gain plan (applied on export). */
  sectionPlan: SectionMasteringPlan;
  /** Rebuild the plan from detected sections (preserves existing gains). */
  syncSectionPlan: (sections: SectionSegment[] | undefined | null) => void;
  setSectionGain: (index: number, gainDb: number) => void;
  toggleSectionPlan: (enabled: boolean) => void;
  resetSectionPlan: () => void;

  // ── Free parametric EQ (C-1) ───────────────────────────────────────────
  /** User-defined parametric EQ bands, spliced live into the preview chain. */
  parametricEqBands: ParametricEqBand[];
  /** Replace the whole band list (sanitised + capped to MAX_BANDS). */
  setParametricEqBands: (bands: ParametricEqBand[]) => void;
  /** Append a new band (default bell @ given freq).  No-op past MAX_BANDS. */
  addParametricBand: (frequencyHz?: number) => void;
  /** Patch one band by id (sanitised). */
  updateParametricBand: (id: string, patch: Partial<Omit<ParametricEqBand, 'id'>>) => void;
  /** Remove a band by id. */
  removeParametricBand: (id: string) => void;
  /** Clear all parametric bands. */
  resetParametricEq: () => void;

  // ── 4-band multiband compressor (C-Phase2) ─────────────────────────────
  /** Multiband compressor config; applied to the offline render + worklet preview. */
  multiband: MultibandConfig;
  /** Patch top-level multiband fields (bypass / crossovers). */
  updateMultiband: (patch: Partial<Omit<MultibandConfig, 'bands'>>) => void;
  /** Patch one band (0..3) by index. */
  updateMultibandBand: (index: number, patch: Partial<MultibandBand>) => void;
  /** Replace the whole multiband config (sanitised). */
  setMultiband: (cfg: MultibandConfig) => void;
  /** Reset multiband to the bypassed default. */
  resetMultiband: () => void;

  // ── 4-band M/S stereo imager (C-Phase2) ────────────────────────────────
  imagerMultiband: ImagerMultibandConfig;
  /** Patch top-level imager-multiband fields (enabled / crossovers). */
  updateImagerMultiband: (patch: Partial<Omit<ImagerMultibandConfig, 'widthsPct'>>) => void;
  /** Set one band's width % (index 0..3). */
  updateImagerBandWidth: (index: number, widthPct: number) => void;
  setImagerMultiband: (cfg: ImagerMultibandConfig) => void;
  resetImagerMultiband: () => void;

  // ── Saturation / exciter (C-Phase2) ────────────────────────────────────
  saturation: SatConfig;
  /** Patch top-level saturation fields. */
  updateSaturation: (patch: Partial<Omit<SatConfig, 'bandDrivesPct'>>) => void;
  /** Set one band's drive % (index 0..3). */
  updateSaturationBandDrive: (index: number, drivePct: number) => void;
  setSaturation: (cfg: SatConfig) => void;
  resetSaturation: () => void;

  // ── Transient / impact (C-Phase2) ──────────────────────────────────────
  transient: TransConfig;
  updateTransient: (patch: Partial<Omit<TransConfig, 'bands'>>) => void;
  updateTransientBand: (index: number, patch: Partial<TransientBand>) => void;
  setTransient: (cfg: TransConfig) => void;
  resetTransient: () => void;

  // ── Dynamic EQ (C-Phase2) ──────────────────────────────────────────────
  dynamicEq: DynEqConfig;
  /** Patch top-level dynamic-EQ fields (bypass). */
  updateDynamicEq: (patch: Partial<Omit<DynEqConfig, 'bands'>>) => void;
  /** Append a band (default bell @ freq).  No-op past MAX_DYNEQ_BANDS. */
  addDynEqBand: (freqHz?: number) => void;
  /** Patch one band by id. */
  updateDynEqBand: (id: string, patch: Partial<Omit<DynEqBand, 'id'>>) => void;
  /** Remove a band by id. */
  removeDynEqBand: (id: string) => void;
  setDynamicEq: (cfg: DynEqConfig) => void;
  resetDynamicEq: () => void;

  // ── De-esser (built on the Dynamic EQ) ─────────────────────────────────
  deesser: DeesserConfig;
  updateDeesser: (patch: Partial<DeesserConfig>) => void;
  resetDeesser: () => void;

  // ── Stem rebalance (approximation + Demucs/ONNX precise) ────────────────
  rebalance: RebalanceConfig;
  updateRebalance: (patch: Partial<Omit<RebalanceConfig, 'stemGainsDb'>>) => void;
  updateStemGain: (stem: StemId, db: number) => void;
  resetRebalance: () => void;

  /** Apply a one-click module preset (sets all 5 module slices at once). */
  applyModulePreset: (configs: {
    multiband: MultibandConfig; imagerMultiband: ImagerMultibandConfig;
    saturation: SatConfig; transient: TransConfig; dynamicEq: DynEqConfig;
  }) => void;

  /** Apply an AI-music correction bundle (5 modules + de-esser). */
  applyAiMusicCorrection: (c: {
    multiband: MultibandConfig; imagerMultiband: ImagerMultibandConfig;
    saturation: SatConfig; transient: TransConfig; dynamicEq: DynEqConfig; deesser: DeesserConfig;
  }) => void;
}

function baseName(p: string): string {
  return p.split('/').pop()?.split('\\').pop() ?? p;
}

/** Fire-and-forget write-through of history to the main process (never throws). */
function persistHistory(history: MasteringHistory): void {
  try {
    void window.electronAPI?.invoke('history:set', serializeHistory(history));
  } catch { /* persistence is best-effort */ }
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

  // ── Durable mastering history (P2) ─────────────────────────────────────
  history: emptyHistory(),
  hydrateHistory: async () => {
    try {
      const raw = await window.electronAPI?.invoke('history:get');
      set({ history: deserializeHistory(raw) });
    } catch { /* corrupt / unavailable → keep empty */ }
  },
  pushHistoryEntry: (input) => set((s) => {
    const next = addHistoryEntry(s.history, entryFromRevision(input));
    persistHistory(next);
    return { history: next };
  }),
  removeHistoryEntry: (id) => set((s) => {
    const next = removeHistoryEntryPure(s.history, id);
    persistHistory(next);
    return { history: next };
  }),
  renameHistoryEntry: (id, label) => set((s) => {
    const next = renameHistoryEntryPure(s.history, id, label);
    persistHistory(next);
    return { history: next };
  }),
  toggleHistoryFavorite: (id) => set((s) => {
    const next = toggleHistoryFavoritePure(s.history, id);
    persistHistory(next);
    return { history: next };
  }),
  restoreHistoryEntry: (id) => set((s) => {
    const entry = getHistoryEntry(s.history, id);
    return entry ? { options: { ...s.options, ...entry.optionsSnapshot } } : s;
  }),

  // ── Per-section mastering (P2) ─────────────────────────────────────────
  sectionPlan: defaultSectionPlan(),
  syncSectionPlan: (sections) => set((s) => ({ sectionPlan: buildSectionPlanFromAnalysis(sections, s.sectionPlan) })),
  setSectionGain: (index, gainDb) => set((s) => ({ sectionPlan: setSectionGainPure(s.sectionPlan, index, gainDb) })),
  toggleSectionPlan: (enabled) => set((s) => ({ sectionPlan: sanitizeSectionPlan({ ...s.sectionPlan, enabled }) })),
  resetSectionPlan: () => set({ sectionPlan: defaultSectionPlan() }),

  // ── Free parametric EQ ─────────────────────────────────────────────────
  parametricEqBands: [],
  setParametricEqBands: (bands) => set({ parametricEqBands: sanitizeBands(bands) }),
  addParametricBand: (frequencyHz = 1000) => set((s) => (
    s.parametricEqBands.length >= MAX_BANDS
      ? s
      : { parametricEqBands: [...s.parametricEqBands, defaultBand(frequencyHz)] }
  )),
  updateParametricBand: (id, patch) => set((s) => ({
    parametricEqBands: sanitizeBands(
      s.parametricEqBands.map((b) => (b.id === id ? { ...b, ...patch, id: b.id } : b)),
    ),
  })),
  removeParametricBand: (id) => set((s) => ({
    parametricEqBands: s.parametricEqBands.filter((b) => b.id !== id),
  })),
  resetParametricEq: () => set({ parametricEqBands: [] }),

  // ── Multiband compressor ───────────────────────────────────────────────
  multiband: defaultMultibandConfig(),
  updateMultiband: (patch) => set((s) => ({ multiband: sanitizeMultiband({ ...s.multiband, ...patch }) })),
  updateMultibandBand: (index, patch) => set((s) => {
    if (index < 0 || index > 3) return s;
    const bands = s.multiband.bands.map((b, i) => (i === index ? { ...b, ...patch } : b)) as MultibandConfig['bands'];
    return { multiband: sanitizeMultiband({ ...s.multiband, bands }) };
  }),
  setMultiband: (cfg) => set({ multiband: sanitizeMultiband(cfg) }),
  resetMultiband: () => set({ multiband: defaultMultibandConfig() }),

  // ── 4-band M/S stereo imager ───────────────────────────────────────────
  imagerMultiband: defaultImagerMultiband(),
  updateImagerMultiband: (patch) => set((s) => ({ imagerMultiband: sanitizeImagerMultiband({ ...s.imagerMultiband, ...patch }) })),
  updateImagerBandWidth: (index, widthPct) => set((s) => {
    if (index < 0 || index > 3) return s;
    const widthsPct = s.imagerMultiband.widthsPct.map((w, i) => (i === index ? widthPct : w)) as ImagerMultibandConfig['widthsPct'];
    return { imagerMultiband: sanitizeImagerMultiband({ ...s.imagerMultiband, widthsPct }) };
  }),
  setImagerMultiband: (cfg) => set({ imagerMultiband: sanitizeImagerMultiband(cfg) }),
  resetImagerMultiband: () => set({ imagerMultiband: defaultImagerMultiband() }),

  // ── Saturation / exciter ───────────────────────────────────────────────
  saturation: defaultSaturationConfig(),
  updateSaturation: (patch) => set((s) => ({ saturation: sanitizeSaturation({ ...s.saturation, ...patch }) })),
  updateSaturationBandDrive: (index, drivePct) => set((s) => {
    if (index < 0 || index > 3) return s;
    const bandDrivesPct = s.saturation.bandDrivesPct.map((d, i) => (i === index ? drivePct : d)) as SatConfig['bandDrivesPct'];
    return { saturation: sanitizeSaturation({ ...s.saturation, bandDrivesPct }) };
  }),
  setSaturation: (cfg) => set({ saturation: sanitizeSaturation(cfg) }),
  resetSaturation: () => set({ saturation: defaultSaturationConfig() }),

  // ── Transient / impact ─────────────────────────────────────────────────
  transient: defaultTransientConfig(),
  updateTransient: (patch) => set((s) => ({ transient: sanitizeTransient({ ...s.transient, ...patch }) })),
  updateTransientBand: (index, patch) => set((s) => {
    if (index < 0 || index > 3) return s;
    const bands = s.transient.bands.map((b, i) => (i === index ? { ...b, ...patch } : b)) as TransConfig['bands'];
    return { transient: sanitizeTransient({ ...s.transient, bands }) };
  }),
  setTransient: (cfg) => set({ transient: sanitizeTransient(cfg) }),
  resetTransient: () => set({ transient: defaultTransientConfig() }),

  // ── Dynamic EQ ─────────────────────────────────────────────────────────
  dynamicEq: defaultDynamicEqConfig(),
  updateDynamicEq: (patch) => set((s) => ({ dynamicEq: sanitizeDynamicEq({ ...s.dynamicEq, ...patch }) })),
  addDynEqBand: (freqHz = 1000) => set((s) => (
    s.dynamicEq.bands.length >= MAX_DYNEQ_BANDS
      ? s
      : { dynamicEq: sanitizeDynamicEq({ ...s.dynamicEq, bands: [...s.dynamicEq.bands, defaultDynEqBand(freqHz)] }) }
  )),
  updateDynEqBand: (id, patch) => set((s) => ({
    dynamicEq: sanitizeDynamicEq({ ...s.dynamicEq, bands: s.dynamicEq.bands.map((b) => (b.id === id ? { ...b, ...patch, id: b.id } : b)) }),
  })),
  removeDynEqBand: (id) => set((s) => ({ dynamicEq: { ...s.dynamicEq, bands: s.dynamicEq.bands.filter((b) => b.id !== id) } })),
  setDynamicEq: (cfg) => set({ dynamicEq: sanitizeDynamicEq(cfg) }),
  resetDynamicEq: () => set({ dynamicEq: defaultDynamicEqConfig() }),

  // ── De-esser ───────────────────────────────────────────────────────────
  deesser: defaultDeesserConfig(),
  updateDeesser: (patch) => set((s) => ({ deesser: sanitizeDeesser({ ...s.deesser, ...patch }) })),
  resetDeesser: () => set({ deesser: defaultDeesserConfig() }),

  // ── Stem rebalance ─────────────────────────────────────────────────────
  rebalance: defaultRebalanceConfig(),
  updateRebalance: (patch) => set((s) => ({ rebalance: sanitizeRebalance({ ...s.rebalance, ...patch }) })),
  updateStemGain: (stem, db) => set((s) => ({ rebalance: sanitizeRebalance({ ...s.rebalance, stemGainsDb: { ...s.rebalance.stemGainsDb, [stem]: db } }) })),
  resetRebalance: () => set({ rebalance: defaultRebalanceConfig() }),

  applyModulePreset: (c) => set({
    multiband: sanitizeMultiband(c.multiband),
    imagerMultiband: sanitizeImagerMultiband(c.imagerMultiband),
    saturation: sanitizeSaturation(c.saturation),
    transient: sanitizeTransient(c.transient),
    dynamicEq: sanitizeDynamicEq(c.dynamicEq),
  }),

  applyAiMusicCorrection: (c) => set({
    multiband: sanitizeMultiband(c.multiband),
    imagerMultiband: sanitizeImagerMultiband(c.imagerMultiband),
    saturation: sanitizeSaturation(c.saturation),
    transient: sanitizeTransient(c.transient),
    dynamicEq: sanitizeDynamicEq(c.dynamicEq),
    deesser: sanitizeDeesser(c.deesser),
  }),
}));
