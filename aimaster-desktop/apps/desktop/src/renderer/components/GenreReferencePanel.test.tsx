import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GenreReferencePanel from './GenreReferencePanel.js';
import { useAudioStore } from '../stores/audioStore.js';
import type { AudioAnalysisResult } from '@aimaster/shared-types';

function setAnalysis(lufs: number, lra: number): void {
  useAudioStore.getState().setAnalysis({
    fileInfo: { path: '/x', name: 'x', sizeBytes: 1, durationSec: 10, sampleRate: 48000, bitDepth: 24, channels: 2, format: 'wav' },
    loudness: { integratedLufs: lufs, truePeakDbtp: -1, lra, shortTermMax: lufs + 2 },
    aiDetection: { harshHighMid: false, boomyLowEnd: false, brickwallCompression: false, stereoImbalance: false, silenceAtStart: false, silenceAtEnd: false, intersampleRisk: false, upsampleSuspected: false },
    dcOffsetDb: -90, silenceStartMs: 0, silenceEndMs: 0,
  } as AudioAnalysisResult);
}

describe('<GenreReferencePanel>', () => {
  beforeEach(() => { useAudioStore.getState().setAnalysis(null); });

  it('prompts to analyse when no analysis', () => {
    render(<GenreReferencePanel />);
    expect(screen.getByText(/먼저 파일을 분석/)).toBeTruthy();
  });

  it('quiet high-LRA input → 어쿠스틱/재즈 + applies natural style + target', () => {
    setAnalysis(-16, 12);
    render(<GenreReferencePanel />);
    expect(screen.getAllByText('어쿠스틱/재즈').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '추천 모드 적용' }));
    expect(useAudioStore.getState().options.style).toBe('natural');
    expect(useAudioStore.getState().options.targetLufs).toBe(-16);
  });

  it('shows copyright-safe reference rows', () => {
    setAnalysis(-9, 4);
    render(<GenreReferencePanel />);
    expect(screen.getByText(/저작권 안전한 톤 fingerprint/)).toBeTruthy();
  });
});
