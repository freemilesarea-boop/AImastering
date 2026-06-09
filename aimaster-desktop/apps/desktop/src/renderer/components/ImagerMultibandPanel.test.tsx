import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImagerMultibandPanel from './ImagerMultibandPanel.js';
import { useAudioStore } from '../stores/audioStore.js';

describe('<ImagerMultibandPanel>', () => {
  beforeEach(() => {
    useAudioStore.getState().resetImagerMultiband();
  });

  it('renders disabled by default', () => {
    render(<ImagerMultibandPanel />);
    const cb = screen.getByRole('checkbox', { name: '멀티밴드 이미저 사용' }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(useAudioStore.getState().imagerMultiband.enabled).toBe(false);
  });

  it('enabling flips enabled on in the store', () => {
    render(<ImagerMultibandPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: '멀티밴드 이미저 사용' }));
    expect(useAudioStore.getState().imagerMultiband.enabled).toBe(true);
  });

  it('renders 4 band labels', () => {
    render(<ImagerMultibandPanel />);
    ['저역', '저중역', '고중역', '고역'].forEach((l) => {
      expect(screen.getByText(`${l} 폭`)).toBeTruthy();
    });
  });

  it('updateImagerBandWidth clamps into range', () => {
    useAudioStore.getState().updateImagerBandWidth(3, 999);
    expect(useAudioStore.getState().imagerMultiband.widthsPct[3]).toBe(200);
  });

  it('reset returns to disabled unity', () => {
    useAudioStore.getState().updateImagerMultiband({ enabled: true });
    useAudioStore.getState().updateImagerBandWidth(0, 0);
    render(<ImagerMultibandPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    const im = useAudioStore.getState().imagerMultiband;
    expect(im.enabled).toBe(false);
    expect(im.widthsPct).toEqual([100, 100, 100, 100]);
  });
});
