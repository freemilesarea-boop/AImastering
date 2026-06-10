import { describe, it, expect } from 'vitest';
import {
  emptyHistory, entryFromRevision, addEntry, removeEntry, renameEntry,
  toggleFavorite, pruneHistory, getEntry, serializeHistory, deserializeHistory,
  HISTORY_VERSION, HISTORY_MAX, type HistoryEntry, type MasteringHistory,
} from './mastering-history.js';
import type { MasteringOptions } from '../stores/audioStore.js';
import type { RevisionInput } from './revisions/revision-types.js';

const opts = (over: Partial<MasteringOptions> = {}): MasteringOptions => ({
  style: 'balanced', targetLufs: -14, targetTp: -1, sampleRate: 48000, bitDepth: 24,
  applyAiCorrections: true, ...over,
} as MasteringOptions);

const input = (over: Partial<RevisionInput> = {}): RevisionInput => ({
  sourceFilePath: '/songs/a.wav', sourceFileName: 'a.wav',
  optionsSnapshot: opts(), outputPath: '/tmp/a.wav', previewPath: '/tmp/a.mp3',
  metrics: { integratedLufs: -14, truePeakDbtp: -1, lra: 7 }, ...over,
} as RevisionInput);

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: Math.random().toString(36), createdAt: Date.now(), label: 'x',
  sourceFileName: 'a.wav', sourceFilePath: '/songs/a.wav',
  optionsSnapshot: opts(), metrics: { integratedLufs: -14, truePeakDbtp: -1 }, ...over,
});

describe('mastering-history', () => {
  it('entryFromRevision carries options snapshot + metrics', () => {
    const e = entryFromRevision(input({ presetId: 'kpop-loud', formatSummary: '48 kHz · 24-bit' }));
    expect(e.sourceFileName).toBe('a.wav');
    expect(e.optionsSnapshot.targetLufs).toBe(-14);
    expect(e.metrics).toEqual({ integratedLufs: -14, truePeakDbtp: -1, lra: 7 });
    expect(e.presetId).toBe('kpop-loud');
  });

  it('addEntry prepends newest-first', () => {
    let h = emptyHistory();
    h = addEntry(h, entry({ id: '1', label: 'first' }));
    h = addEntry(h, entry({ id: '2', label: 'second' }));
    expect(h.entries.map((e) => e.id)).toEqual(['2', '1']);
  });

  it('prune caps at HISTORY_MAX but always keeps favorites', () => {
    const many: HistoryEntry[] = [];
    // 1 old favorite + (HISTORY_MAX + 10) newer non-favorites
    many.push(entry({ id: 'fav', createdAt: 1, isFavorite: true }));
    for (let i = 0; i < HISTORY_MAX + 10; i++) many.push(entry({ id: `n${i}`, createdAt: 1000 + i }));
    const pruned = pruneHistory({ version: HISTORY_VERSION, entries: [...many].reverse() }); // newest-first
    expect(pruned.entries.length).toBe(HISTORY_MAX);
    expect(pruned.entries.some((e) => e.id === 'fav')).toBe(true); // favorite survived the cap
  });

  it('remove / rename / toggleFavorite are immutable updates', () => {
    let h = addEntry(emptyHistory(), entry({ id: 'a', label: 'old' }));
    h = renameEntry(h, 'a', '  new name  ');
    expect(getEntry(h, 'a')!.label).toBe('new name');
    h = toggleFavorite(h, 'a');
    expect(getEntry(h, 'a')!.isFavorite).toBe(true);
    h = removeEntry(h, 'a');
    expect(getEntry(h, 'a')).toBeUndefined();
  });

  it('rename ignores blank labels', () => {
    let h = addEntry(emptyHistory(), entry({ id: 'a', label: 'keep' }));
    h = renameEntry(h, 'a', '   ');
    expect(getEntry(h, 'a')!.label).toBe('keep');
  });

  it('serialize → deserialize round-trips', () => {
    const h = addEntry(addEntry(emptyHistory(), entry({ id: '1' })), entry({ id: '2', isFavorite: true }));
    const round = deserializeHistory(JSON.parse(JSON.stringify(serializeHistory(h))));
    expect(round.entries.map((e) => e.id).sort()).toEqual(['1', '2']);
  });

  it('deserialize rejects wrong version / corrupt blob → empty', () => {
    expect(deserializeHistory(null).entries).toEqual([]);
    expect(deserializeHistory({ version: 999, entries: [] }).entries).toEqual([]);
    expect(deserializeHistory('garbage').entries).toEqual([]);
  });

  it('deserialize drops malformed entries but keeps valid ones', () => {
    const blob = {
      version: HISTORY_VERSION,
      entries: [
        entry({ id: 'ok' }),
        { id: 'bad', createdAt: 'nope' }, // invalid
        { nonsense: true },               // invalid
      ],
    };
    const h = deserializeHistory(JSON.parse(JSON.stringify(blob)));
    expect(h.entries.map((e) => e.id)).toEqual(['ok']);
  });
});
