import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MasteringHistoryPanel from './MasteringHistoryPanel.js';
import { useAudioStore } from '../stores/audioStore.js';
import type { RevisionInput } from '../audio/revisions/revision-types.js';
import type { MasteringOptions } from '../stores/audioStore.js';

const opts = (over: Partial<MasteringOptions> = {}): MasteringOptions => ({
  style: 'balanced', targetLufs: -14, targetTp: -1, sampleRate: 48000, bitDepth: 24,
  applyAiCorrections: true, ...over,
} as MasteringOptions);

const push = (over: Partial<RevisionInput> = {}) => useAudioStore.getState().pushHistoryEntry({
  sourceFilePath: '/songs/a.wav', sourceFileName: 'a.wav', optionsSnapshot: opts(),
  outputPath: '/tmp/a.wav', previewPath: '/tmp/a.mp3',
  metrics: { integratedLufs: -14, truePeakDbtp: -1, lra: 7 }, ...over,
} as RevisionInput);

describe('<MasteringHistoryPanel>', () => {
  beforeEach(() => {
    useAudioStore.setState({ history: { version: 1, entries: [] } });
  });

  it('shows an empty prompt when there is no history', () => {
    render(<MasteringHistoryPanel />);
    expect(screen.getByText(/아직 마스터링 이력이 없습니다/)).toBeTruthy();
  });

  it('lists recorded masters with metrics + settings', () => {
    push({ sourceFileName: 'song.wav', optionsSnapshot: opts({ targetLufs: -9 }) });
    render(<MasteringHistoryPanel />);
    expect(screen.getAllByText(/song\.wav/).length).toBeGreaterThan(0);
    expect(screen.getByText(/-9\.0 LUFS/)).toBeTruthy();
  });

  it('restore applies the entry options snapshot into active options', () => {
    push({ optionsSnapshot: opts({ targetLufs: -7, outputGainDb: 2 }) });
    render(<MasteringHistoryPanel />);
    expect(useAudioStore.getState().options.targetLufs).toBe(-14); // unchanged before restore
    fireEvent.click(screen.getByRole('button', { name: '설정 복원' }));
    expect(useAudioStore.getState().options.targetLufs).toBe(-7);
    expect(useAudioStore.getState().options.outputGainDb).toBe(2);
  });

  it('favorite toggles and pins the entry', () => {
    push();
    render(<MasteringHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: '즐겨찾기' }));
    expect(useAudioStore.getState().history.entries[0]!.isFavorite).toBe(true);
  });

  it('delete removes the entry', () => {
    push();
    render(<MasteringHistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(useAudioStore.getState().history.entries.length).toBe(0);
  });
});
