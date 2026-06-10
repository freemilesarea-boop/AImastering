import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DeesserPanel from './DeesserPanel.js';
import { useAudioStore } from '../stores/audioStore.js';
import { isDeesserActive } from '../audio/deesser-config.js';

describe('<DeesserPanel>', () => {
  beforeEach(() => { useAudioStore.getState().resetDeesser(); });

  it('renders disabled by default', () => {
    render(<DeesserPanel />);
    expect((screen.getByRole('checkbox', { name: '디에서 사용' }) as HTMLInputElement).checked).toBe(false);
  });

  it('"보컬 디에스" quick preset enables + sets sensible values', () => {
    render(<DeesserPanel />);
    fireEvent.click(screen.getByRole('button', { name: '보컬 디에스' }));
    const d = useAudioStore.getState().deesser;
    expect(isDeesserActive(d)).toBe(true);
    expect(d.freqHz).toBe(6500);
  });

  it('updateDeesser clamps range', () => {
    useAudioStore.getState().updateDeesser({ rangeDb: 999 });
    expect(useAudioStore.getState().deesser.rangeDb).toBe(18);
  });

  it('reset disables it', () => {
    useAudioStore.getState().updateDeesser({ enabled: true, rangeDb: 6 });
    render(<DeesserPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useAudioStore.getState().deesser.enabled).toBe(false);
  });
});
