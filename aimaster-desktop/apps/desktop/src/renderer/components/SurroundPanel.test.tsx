import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SurroundPanel from './SurroundPanel.js';
import { useAudioStore } from '../stores/audioStore.js';
import { defaultSurroundOptions } from '../audio/surround-config.js';

describe('<SurroundPanel>', () => {
  beforeEach(() => { useAudioStore.setState({ surround: defaultSurroundOptions() }); });

  it('renders the enable toggle and fold-down trim sliders by default', () => {
    render(<SurroundPanel />);
    expect(screen.getByRole('checkbox', { name: '서라운드 처리 사용' })).toBeTruthy();
    expect(screen.getByLabelText('센터')).toBeTruthy();
    expect(screen.getByLabelText('LFE')).toBeTruthy();
  });

  it('LFE shows "제외" at the floor by default', () => {
    render(<SurroundPanel />);
    expect(screen.getByText('제외')).toBeTruthy();
  });

  it('enabling surround updates the store', () => {
    render(<SurroundPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: '서라운드 처리 사용' }));
    expect(useAudioStore.getState().surround.foldDownEnabled).toBe(true);
  });

  it('switching to multichannel mode shows master gain + ceiling', () => {
    render(<SurroundPanel />);
    fireEvent.click(screen.getByRole('button', { name: '멀티채널 출력' }));
    expect(useAudioStore.getState().surround.mode).toBe('multichannel');
    expect(screen.getByLabelText('마스터 게인')).toBeTruthy();
    expect(screen.getByLabelText('트루피크 실링')).toBeTruthy();
  });

  it('centre trim writes a clamped value', () => {
    render(<SurroundPanel />);
    fireEvent.change(screen.getByLabelText('센터'), { target: { value: '3' } });
    expect(useAudioStore.getState().surround.trims.centerDb).toBe(3);
  });

  it('reset returns to default', () => {
    useAudioStore.getState().updateSurround({ foldDownEnabled: true });
    render(<SurroundPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useAudioStore.getState().surround.foldDownEnabled).toBe(false);
  });
});
