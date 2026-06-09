import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MultibandPanel from './MultibandPanel.js';
import { useAudioStore } from '../stores/audioStore.js';

describe('<MultibandPanel>', () => {
  beforeEach(() => {
    useAudioStore.getState().resetMultiband();
  });

  it('renders bypassed by default (enable checkbox unchecked)', () => {
    render(<MultibandPanel />);
    const cb = screen.getByRole('checkbox', { name: '멀티밴드 사용' }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(useAudioStore.getState().multiband.bypass).toBe(true);
  });

  it('enabling flips bypass off in the store', () => {
    render(<MultibandPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: '멀티밴드 사용' }));
    expect(useAudioStore.getState().multiband.bypass).toBe(false);
  });

  it('renders 4 band sections', () => {
    render(<MultibandPanel />);
    expect(screen.getByText('저역')).toBeTruthy();
    expect(screen.getByText('저중역')).toBeTruthy();
    expect(screen.getByText('고중역')).toBeTruthy();
    expect(screen.getByText('고역')).toBeTruthy();
  });

  it('reset returns multiband to the bypassed default', () => {
    useAudioStore.getState().updateMultiband({ bypass: false });
    useAudioStore.getState().updateMultibandBand(0, { ratio: 5 });
    render(<MultibandPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    const mb = useAudioStore.getState().multiband;
    expect(mb.bypass).toBe(true);
    expect(mb.bands[0]!.ratio).toBe(1);
  });

  it('updateMultibandBand clamps ratio into range', () => {
    useAudioStore.getState().updateMultibandBand(2, { ratio: 999 });
    expect(useAudioStore.getState().multiband.bands[2]!.ratio).toBe(20);
  });
});
