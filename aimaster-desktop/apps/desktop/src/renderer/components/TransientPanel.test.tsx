import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TransientPanel from './TransientPanel.js';
import { useAudioStore } from '../stores/audioStore.js';

describe('<TransientPanel>', () => {
  beforeEach(() => { useAudioStore.getState().resetTransient(); });

  it('renders bypassed by default', () => {
    render(<TransientPanel />);
    const cb = screen.getByRole('checkbox', { name: '트랜지언트 사용' }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(useAudioStore.getState().transient.bypass).toBe(true);
  });

  it('enabling flips bypass off', () => {
    render(<TransientPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: '트랜지언트 사용' }));
    expect(useAudioStore.getState().transient.bypass).toBe(false);
  });

  it('multiband toggle reveals 4 band sections', () => {
    useAudioStore.getState().updateTransient({ multibandEnabled: true });
    render(<TransientPanel />);
    ['저역', '저중역', '고중역', '고역'].forEach((l) => expect(screen.getByText(l)).toBeTruthy());
  });

  it('updateTransientBand clamps amounts', () => {
    useAudioStore.getState().updateTransientBand(0, { attackPct: 999 });
    expect(useAudioStore.getState().transient.bands[0]!.attackPct).toBe(100);
  });

  it('reset returns to bypassed default', () => {
    useAudioStore.getState().updateTransient({ bypass: false, attackPct: 50 });
    render(<TransientPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useAudioStore.getState().transient.bypass).toBe(true);
    expect(useAudioStore.getState().transient.attackPct).toBe(0);
  });
});
