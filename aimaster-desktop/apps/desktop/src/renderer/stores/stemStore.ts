// stemStore — the stem session: which stems, what they are, how they sit.
//
// One session at a time, held here and persisted so closing the app does not
// lose an hour of fader moves. What is persisted is deliberately only the
// DECISIONS — paths, roles, faders, mutes. Analysis results are not: they are
// derived from files that may have been re-exported since, and a stale
// measurement presented as current is worse than measuring again.
//
// # Roles the user set are not overwritten
//
// The classifier runs on import and can run again (a stem replaced, a file
// re-analysed). If it overwrote a role the user had corrected, the
// correction would silently disappear the next time anything triggered an
// analysis — so `roleLocked` marks a user's choice and re-analysis leaves
// those alone.

import { create } from 'zustand';
import type { StemRole } from '../audio/presets/stem-defaults.js';
import type { ModuleId } from '../audio/parameters/parameter-state.js';

const STORAGE_KEY = 'loui.stem.session';

export type StemStatus = 'pending' | 'analyzing' | 'ready' | 'error';
export type RoleBasis = 'name' | 'spectrum' | 'name+spectrum';

export interface StemTrackState {
  /** Stable key for React and for addressing a row. */
  id: string;
  filePath: string;
  /** Basename, shown in the mixer. */
  name: string;
  role: StemRole;
  /** True once the user picks a role — re-analysis must not overwrite it. */
  roleLocked: boolean;
  confidence: number;
  basis: RoleBasis;
  /** Why the classifier decided what it did, Korean. */
  why: string;
  /** Name/measurement disagreement, or an empty stem. Korean. */
  warning?: string | undefined;
  /** Fader, dB. */
  gainDb: number;
  /** Balance, -1..1. */
  pan: number;
  mute: boolean;
  solo: boolean;
  status: StemStatus;
  error?: string | undefined;
  /**
   * Plugins on this track's channel, as module ids.
   *
   * Held here rather than derived from the saved rack state, because a rack
   * state has a bypass flag for all twenty-five modules and cannot tell
   * "the user added this and switched it off" from "the user never added
   * it". A plugin the user bypassed has to stay in the list, or switching
   * it off would delete it.
   *
   * Empty means "not set up yet" — the role's own chain is used until the
   * user opens the rack, at which point it is seeded from that same chain.
   */
  inserts?: ModuleId[] | undefined;
}

/** The subset that survives a restart. */
interface PersistedTrack {
  id: string; filePath: string; name: string;
  role: StemRole; roleLocked: boolean;
  gainDb: number; pan: number; mute: boolean; solo: boolean;
  inserts?: ModuleId[];
}

export interface StemRenderReport {
  rendered: number;
  skipped: number;
  sumPeakDb: number;
  outputPeakDb: number;
  alignmentSamples: number;
  latencyAvailable: boolean;
  masterLufs: number;
  masterTruePeakDb: number;
  loudnessGainDb: number;
  loudnessNote: 'ok' | 'silence' | 'clamped-boost' | 'clamped-cut' | 'ceiling-limited' | 'not-requested';
  loudnessPasses: number;
  durationSec: number;
  renderMs: number;
}

/** Default master bus — the neutral streaming target, not the loudest one. */
export const DEFAULT_MASTER_PRESET = 'streaming-pro';

interface StemStore {
  tracks: StemTrackState[];
  /**
   * Master bus preset id, or null for no master bus at all.
   *
   * Null is a real choice, not an unset one: rendering the sum with nothing
   * on it is how you hear what the stem chains alone did, and how you get a
   * file to master somewhere else.
   */
  masterPresetId: string | null;
  /** Loudness target, or null to use whatever the preset asks for. */
  masterTargetLufs: number | null;
  /** Set while a render is running. */
  rendering: boolean;
  lastOutputPath: string | null;
  lastReport: StemRenderReport | null;
  renderError: string | null;

  addFiles: (paths: string[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  setRole: (id: string, role: StemRole) => void;
  setGain: (id: string, gainDb: number) => void;
  setPan: (id: string, pan: number) => void;
  toggleMute: (id: string) => void;
  toggleSolo: (id: string) => void;
  /** Replace a track's plugin list. */
  setInserts: (id: string, inserts: ModuleId[]) => void;
  setMasterPreset: (id: string | null) => void;
  setMasterTargetLufs: (lufs: number | null) => void;
  /** Run the classifier over every stem that has not been analysed yet. */
  analyzePending: () => Promise<void>;
  setRendering: (v: boolean) => void;
  setRenderResult: (outputPath: string | null, report: StemRenderReport | null, error: string | null) => void;
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

let seq = 0;
function makeId(): string {
  seq += 1;
  return `stem-${Date.now().toString(36)}-${seq}`;
}

function load(): StemTrackState[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedTrack[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t) => ({
      id: typeof t.id === 'string' ? t.id : makeId(),
      filePath: String(t.filePath ?? ''),
      name: String(t.name ?? basename(String(t.filePath ?? ''))),
      role: (t.role ?? 'other') as StemRole,
      roleLocked: t.roleLocked === true,
      confidence: 0,
      basis: 'name' as RoleBasis,
      // The measurement is not restored — see the header. The session says
      // so rather than showing last week's verdict as if it were fresh.
      why: '이전 세션에서 불러왔습니다. 분석을 다시 실행하면 최신 측정으로 갱신됩니다.',
      gainDb: Number.isFinite(t.gainDb) ? t.gainDb : 0,
      pan: Number.isFinite(t.pan) ? t.pan : 0,
      mute: t.mute === true,
      solo: t.solo === true,
      status: 'pending' as StemStatus,
      ...(Array.isArray(t.inserts) ? { inserts: t.inserts } : {}),
    })).filter((t) => t.filePath.length > 0);
  } catch {
    return [];
  }
}

function persist(tracks: StemTrackState[]): void {
  try {
    const slim: PersistedTrack[] = tracks.map((t) => ({
      id: t.id, filePath: t.filePath, name: t.name,
      role: t.role, roleLocked: t.roleLocked,
      gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo,
      ...(t.inserts ? { inserts: t.inserts } : {}),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    // A full or disabled localStorage must not take the mixer down.
  }
}

const MASTER_KEY = 'loui.stem.master';

function loadMaster(): { masterPresetId: string | null; masterTargetLufs: number | null } {
  try {
    const raw = localStorage.getItem(MASTER_KEY);
    if (!raw) return { masterPresetId: DEFAULT_MASTER_PRESET, masterTargetLufs: null };
    const p = JSON.parse(raw) as { masterPresetId?: unknown; masterTargetLufs?: unknown };
    return {
      masterPresetId: typeof p.masterPresetId === 'string' ? p.masterPresetId
        : p.masterPresetId === null ? null : DEFAULT_MASTER_PRESET,
      masterTargetLufs: typeof p.masterTargetLufs === 'number' && Number.isFinite(p.masterTargetLufs)
        ? p.masterTargetLufs : null,
    };
  } catch {
    return { masterPresetId: DEFAULT_MASTER_PRESET, masterTargetLufs: null };
  }
}

function persistMaster(masterPresetId: string | null, masterTargetLufs: number | null): void {
  try {
    localStorage.setItem(MASTER_KEY, JSON.stringify({ masterPresetId, masterTargetLufs }));
  } catch { /* storage full or disabled — not worth taking the mixer down */ }
}

export const useStemStore = create<StemStore>((set, get) => ({
  tracks: load(),
  ...loadMaster(),
  rendering: false,
  lastOutputPath: null,
  lastReport: null,
  renderError: null,

  addFiles: (paths) => {
    const existing = new Set(get().tracks.map((t) => t.filePath));
    const added: StemTrackState[] = paths
      .filter((p) => p && !existing.has(p))
      .map((p) => ({
        id: makeId(),
        filePath: p,
        name: basename(p),
        role: 'other' as StemRole,
        roleLocked: false,
        confidence: 0,
        basis: 'name' as RoleBasis,
        why: '분석 대기 중',
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        status: 'pending' as StemStatus,
      }));
    if (added.length === 0) return;
    const tracks = [...get().tracks, ...added];
    persist(tracks);
    set({ tracks });
  },

  remove: (id) => {
    const tracks = get().tracks.filter((t) => t.id !== id);
    persist(tracks);
    set({ tracks });
  },

  clear: () => {
    persist([]);
    set({ tracks: [], lastOutputPath: null, lastReport: null, renderError: null });
  },

  setRole: (id, role) => {
    // Locked, because the user just said so. See the header.
    const tracks = get().tracks.map((t) =>
      t.id === id ? { ...t, role, roleLocked: true, warning: undefined } : t);
    persist(tracks);
    set({ tracks });
  },

  setGain: (id, gainDb) => {
    const v = Math.max(-60, Math.min(12, Number.isFinite(gainDb) ? gainDb : 0));
    const tracks = get().tracks.map((t) => (t.id === id ? { ...t, gainDb: v } : t));
    persist(tracks);
    set({ tracks });
  },

  setPan: (id, pan) => {
    const v = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
    const tracks = get().tracks.map((t) => (t.id === id ? { ...t, pan: v } : t));
    persist(tracks);
    set({ tracks });
  },

  toggleMute: (id) => {
    const tracks = get().tracks.map((t) => (t.id === id ? { ...t, mute: !t.mute } : t));
    persist(tracks);
    set({ tracks });
  },

  toggleSolo: (id) => {
    const tracks = get().tracks.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t));
    persist(tracks);
    set({ tracks });
  },

  setInserts: (id, inserts) => {
    const tracks = get().tracks.map((t) => (t.id === id ? { ...t, inserts } : t));
    persist(tracks);
    set({ tracks });
  },

  setMasterPreset: (id) => {
    persistMaster(id, get().masterTargetLufs);
    set({ masterPresetId: id });
  },

  setMasterTargetLufs: (lufs) => {
    const v = lufs === null ? null : Math.max(-24, Math.min(-6, Number.isFinite(lufs) ? lufs : -14));
    persistMaster(get().masterPresetId, v);
    set({ masterTargetLufs: v });
  },

  analyzePending: async () => {
    const api = window.electronAPI;
    if (!api) return;
    const pending = get().tracks.filter((t) => t.status === 'pending' || t.status === 'error');
    if (pending.length === 0) return;

    set({
      tracks: get().tracks.map((t) =>
        pending.some((p) => p.id === t.id) ? { ...t, status: 'analyzing' as StemStatus } : t),
    });

    // Sequential on purpose. Each analysis decodes a whole file and runs an
    // FFT over it; twenty of those at once would fight for the same CPU and
    // finish no sooner, while making the app unresponsive throughout.
    for (const track of pending) {
      let patch: Partial<StemTrackState>;
      try {
        const res = await api.invoke('stem:analyze', track.filePath) as {
          ok: boolean; error?: string;
          role?: StemRole; confidence?: number; basis?: RoleBasis;
          why?: string; warning?: string;
        };
        patch = res.ok
          ? {
              status: 'ready',
              confidence: res.confidence ?? 0,
              basis: res.basis ?? 'name',
              why: res.why ?? '',
              ...(res.warning !== undefined ? { warning: res.warning } : { warning: undefined }),
              error: undefined,
            }
          : { status: 'error', error: res.error ?? '분석에 실패했습니다.' };

        // A role the user set outranks the classifier, always.
        const current = get().tracks.find((t) => t.id === track.id);
        if (res.ok && res.role && !current?.roleLocked) patch.role = res.role;
      } catch (err) {
        patch = { status: 'error', error: (err as Error).message };
      }

      const tracks = get().tracks.map((t) => (t.id === track.id ? { ...t, ...patch } : t));
      persist(tracks);
      set({ tracks });
    }
  },

  setRendering: (v) => set({ rendering: v }),
  setRenderResult: (outputPath, report, error) =>
    set({ lastOutputPath: outputPath, lastReport: report, renderError: error, rendering: false }),
}));

// ── Selectors ───────────────────────────────────────────────────────────────

/**
 * Which tracks will be heard.
 *
 * Mirrors `audibleTracks` in `main/offline/stem-render.ts` — the mixer has
 * to show the same answer the render produces, and the two run in different
 * processes. `stem-store-selftest` checks the two agree.
 */
export function audibleFlags(tracks: readonly StemTrackState[]): boolean[] {
  const anySolo = tracks.some((t) => t.solo && !t.mute);
  return tracks.map((t) => (t.mute ? false : anySolo ? t.solo : true));
}

/** Stems still being measured, or waiting to be. */
export function pendingCount(tracks: readonly StemTrackState[]): number {
  return tracks.filter((t) => t.status === 'pending' || t.status === 'analyzing').length;
}

/** Stems the classifier was unsure about, or disagreed with itself over. */
export function needsAttention(tracks: readonly StemTrackState[]): StemTrackState[] {
  return tracks.filter((t) =>
    t.status === 'error' ||
    t.warning !== undefined ||
    (t.status === 'ready' && !t.roleLocked && t.confidence < 0.5));
}
