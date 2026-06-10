// mastering-history — durable, cross-session record of mastering runs (P2).
//
// The in-memory `revisionGroup` is per-source and cleared on reset/restart.
// This module is the PERSISTENT layer: a capped, versioned library of past
// masters (settings snapshot + metrics + metadata) that survives restarts via
// electron-store.  The renderer owns this schema; the main process only stores
// the serialized blob (bounded + validated).
//
// Honest scope: the mastered WAV/MP3 live in a temp dir that is purged between
// sessions, so history preserves the *settings + metrics*, not the audio.  Its
// job is "what did I do, and let me restore those settings and re-master" —
// not an audio archive.  Entries therefore never depend on a file existing.
//
// Pure + headless-testable.

import type { MasteringOptions } from '../stores/audioStore.js';
import type { RevisionInput } from './revisions/revision-types.js';

/** Schema version — bump on a breaking change to drop incompatible blobs. */
export const HISTORY_VERSION = 1;
/** Hard cap on retained entries (favorites are kept past the cap). */
export const HISTORY_MAX = 100;

export interface HistoryMetrics {
  integratedLufs: number;
  truePeakDbtp: number;
  lra?: number;
}

export interface HistoryEntry {
  id: string;
  createdAt: number; // epoch ms
  label: string;
  sourceFileName: string;
  sourceFilePath: string;
  optionsSnapshot: MasteringOptions;
  metrics: HistoryMetrics;
  presetId?: string;
  formatSummary?: string;
  notes?: string;
  isFavorite?: boolean;
}

export interface MasteringHistory {
  version: number;
  entries: HistoryEntry[]; // newest-first
}

export function emptyHistory(): MasteringHistory {
  return { version: HISTORY_VERSION, entries: [] };
}

let seq = 0;
function makeId(): string {
  seq = (seq + 1) % 1_000_000;
  return `h_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** Build a history entry from the same input that creates a revision. */
export function entryFromRevision(input: RevisionInput, label?: string): HistoryEntry {
  return {
    id: makeId(),
    createdAt: Date.now(),
    label: label ?? input.label ?? input.sourceFileName,
    sourceFileName: input.sourceFileName,
    sourceFilePath: input.sourceFilePath,
    optionsSnapshot: input.optionsSnapshot,
    metrics: {
      integratedLufs: input.metrics.integratedLufs,
      truePeakDbtp: input.metrics.truePeakDbtp,
      ...(input.metrics.lra !== undefined ? { lra: input.metrics.lra } : {}),
    },
    ...(input.presetId !== undefined ? { presetId: input.presetId } : {}),
    ...(input.formatSummary !== undefined ? { formatSummary: input.formatSummary } : {}),
  };
}

/**
 * Prepend an entry, then prune to HISTORY_MAX while always keeping favorites.
 * Newest entries win; favorites past the cap are retained.
 */
export function addEntry(history: MasteringHistory, entry: HistoryEntry): MasteringHistory {
  return pruneHistory({ version: HISTORY_VERSION, entries: [entry, ...history.entries] });
}

export function removeEntry(history: MasteringHistory, id: string): MasteringHistory {
  return { version: HISTORY_VERSION, entries: history.entries.filter((e) => e.id !== id) };
}

export function renameEntry(history: MasteringHistory, id: string, label: string): MasteringHistory {
  const trimmed = label.trim();
  if (!trimmed) return history;
  return {
    version: HISTORY_VERSION,
    entries: history.entries.map((e) => (e.id === id ? { ...e, label: trimmed.slice(0, 120) } : e)),
  };
}

export function toggleFavorite(history: MasteringHistory, id: string): MasteringHistory {
  return {
    version: HISTORY_VERSION,
    entries: history.entries.map((e) => (e.id === id ? { ...e, isFavorite: !e.isFavorite } : e)),
  };
}

/** Cap total entries at HISTORY_MAX, keeping all favorites + newest non-favorites. */
export function pruneHistory(history: MasteringHistory): MasteringHistory {
  const entries = history.entries;
  if (entries.length <= HISTORY_MAX) return { version: HISTORY_VERSION, entries };
  const favorites = entries.filter((e) => e.isFavorite);
  const nonFavorites = entries.filter((e) => !e.isFavorite);
  const keepNonFav = nonFavorites.slice(0, Math.max(0, HISTORY_MAX - favorites.length));
  // Preserve original (newest-first) order across the kept set.
  const keep = new Set([...favorites, ...keepNonFav]);
  return { version: HISTORY_VERSION, entries: entries.filter((e) => keep.has(e)) };
}

export function getEntry(history: MasteringHistory, id: string): HistoryEntry | undefined {
  return history.entries.find((e) => e.id === id);
}

// ── Serialization (versioned + validated) ───────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function validEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isStr(o.id) || !isNum(o.createdAt) || !isStr(o.label)) return null;
  if (!isStr(o.sourceFileName) || !isStr(o.sourceFilePath)) return null;
  if (!o.optionsSnapshot || typeof o.optionsSnapshot !== 'object') return null;
  const m = o.metrics as Record<string, unknown> | undefined;
  if (!m || !isNum(m.integratedLufs) || !isNum(m.truePeakDbtp)) return null;
  const entry: HistoryEntry = {
    id: o.id, createdAt: o.createdAt, label: o.label,
    sourceFileName: o.sourceFileName, sourceFilePath: o.sourceFilePath,
    optionsSnapshot: o.optionsSnapshot as MasteringOptions,
    metrics: { integratedLufs: m.integratedLufs, truePeakDbtp: m.truePeakDbtp, ...(isNum(m.lra) ? { lra: m.lra } : {}) },
    ...(isStr(o.presetId) ? { presetId: o.presetId } : {}),
    ...(isStr(o.formatSummary) ? { formatSummary: o.formatSummary } : {}),
    ...(isStr(o.notes) ? { notes: o.notes } : {}),
    ...(typeof o.isFavorite === 'boolean' ? { isFavorite: o.isFavorite } : {}),
  };
  return entry;
}

export function serializeHistory(history: MasteringHistory): MasteringHistory {
  // A plain, JSON-safe object (pruned) for persistence.
  return pruneHistory({ version: HISTORY_VERSION, entries: history.entries });
}

/**
 * Parse an untrusted persisted blob.  A wrong version or any malformed entry is
 * dropped; the result is always a valid (possibly empty) history — a corrupt
 * store can never break the app.
 */
export function deserializeHistory(raw: unknown): MasteringHistory {
  if (!raw || typeof raw !== 'object') return emptyHistory();
  const o = raw as Record<string, unknown>;
  if (o.version !== HISTORY_VERSION || !Array.isArray(o.entries)) return emptyHistory();
  const entries = o.entries.map(validEntry).filter((e): e is HistoryEntry => e !== null);
  return pruneHistory({ version: HISTORY_VERSION, entries });
}
