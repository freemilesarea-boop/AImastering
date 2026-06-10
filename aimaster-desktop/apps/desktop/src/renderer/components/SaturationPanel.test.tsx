import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SaturationPanel from './SaturationPanel.js';
import { useAudioStore } from '../stores/audioStore.js';

describe('<SaturationPanel>', () => {
  beforeEach(() => {
    useAudioStore.getState().resetSaturation();
  });

  it('renders bypassed by default', () => {
    render(<SaturationPanel />);
    const cb = screen.getByRole('checkbox', { name: '새추레이션 사용' }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(useAudioStore.getState().saturation.bypass).toBe(true);
  });

  it('enabling flips bypass off', () => {
    render(<SaturationPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: '새추레이션 사용' }));
    expect(useAudioStore.getState().saturation.bypass).toBe(false);
  });

  it('changing the character select updates the store', () => {
    render(<SaturationPanel />);
    const sel = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'tube' } });
    expect(useAudioStore.getState().saturation.character).toBe('tube');
  });

  it('shows per-band drives only when multiband enabled', () => {
    useAudioStore.getState().updateSaturation({ multibandEnabled: true });
    render(<SaturationPanel />);
    expect(screen.getByText('저역 드라이브')).toBeTruthy();
  });

  it('updateSaturationBandDrive clamps into range', () => {
    useAudioStore.getState().updateSaturationBandDrive(2, 999);
    expect(useAudioStore.getState().saturation.bandDrivesPct[2]).toBe(200);
  });

  it('reset returns to bypassed default', () => {
    useAudioStore.getState().updateSaturation({ bypass: false, drive: 70 });
    render(<SaturationPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useAudioStore.getState().saturation.bypass).toBe(true);
    expect(useAudioStore.getState().saturation.drive).toBe(0);
  });
});
