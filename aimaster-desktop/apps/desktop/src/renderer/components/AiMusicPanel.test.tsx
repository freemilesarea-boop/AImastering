import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AiMusicPanel from './AiMusicPanel.js';
import { useAudioStore } from '../stores/audioStore.js';
import { isDeesserActive } from '../audio/deesser-config.js';
import type { AudioAnalysisResult } from '@aimaster/shared-types';

function setAnalysis(over: Partial<AudioAnalysisResult['aiDetection']> = {}, lra = 8): void {
  useAudioStore.getState().setAnalysis({
    fileInfo: { path: '/x', name: 'x', sizeBytes: 1, durationSec: 10, sampleRate: 48000, bitDepth: 24, channels: 2, format: 'wav' },
    loudness: { integratedLufs: -12, truePeakDbtp: -1, lra, shortTermMax: -10 },
    aiDetection: { harshHighMid: false, boomyLowEnd: false, brickwallCompression: false, stereoImbalance: false, silenceAtStart: false, silenceAtEnd: false, intersampleRisk: false, upsampleSuspected: false, ...over },
    dcOffsetDb: -90, silenceStartMs: 0, silenceEndMs: 0,
  } as AudioAnalysisResult);
}

describe('<AiMusicPanel>', () => {
  beforeEach(() => {
    useAudioStore.getState().setAnalysis(null);
    useAudioStore.getState().resetDeesser();
    useAudioStore.getState().resetDynamicEq();
  });

  it('prompts to analyse when no analysis is present', () => {
    render(<AiMusicPanel />);
    expect(screen.getByText(/먼저 파일을 분석/)).toBeTruthy();
  });

  it('clean analysis → "아티팩트 없음", no apply button', () => {
    setAnalysis();
    render(<AiMusicPanel />);
    expect(screen.getByText('아티팩트 없음')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AI 음악 보정 적용/ })).toBeNull();
  });

  it('harsh AI input → shows finding + applies correction on click', () => {
    setAnalysis({ harshHighMid: true });
    render(<AiMusicPanel />);
    expect(screen.getByText('금속성 고중역')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /AI 음악 보정 적용/ }));
    expect(isDeesserActive(useAudioStore.getState().deesser)).toBe(true);
    expect(useAudioStore.getState().dynamicEq.bands.length).toBeGreaterThan(0);
  });
});
