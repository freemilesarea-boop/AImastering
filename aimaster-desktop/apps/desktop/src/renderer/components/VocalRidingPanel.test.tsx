import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VocalRidingPanel from './VocalRidingPanel.js';
import { useAudioStore } from '../stores/audioStore.js';
import { defaultVocalRiding } from '../audio/vocal-riding-config.js';

describe('<VocalRidingPanel>', () => {
  beforeEach(() => { useAudioStore.setState({ vocalRiding: defaultVocalRiding() }); });

  it('renders the enable toggle and the rider controls', () => {
    render(<VocalRidingPanel />);
    expect(screen.getByRole('checkbox', { name: '보컬 라이딩 사용' })).toBeTruthy();
    expect(screen.getByLabelText('강도')).toBeTruthy();
    expect(screen.getByLabelText('반응')).toBeTruthy();
  });

  it('toggling enable updates the store', () => {
    render(<VocalRidingPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: '보컬 라이딩 사용' }));
    expect(useAudioStore.getState().vocalRiding.enabled).toBe(true);
  });

  it('the amount slider writes a 0..1 value', () => {
    render(<VocalRidingPanel />);
    fireEvent.change(screen.getByLabelText('강도'), { target: { value: '80' } });
    expect(useAudioStore.getState().vocalRiding.amount).toBeCloseTo(0.8, 5);
  });

  it('reset returns to the default plan', () => {
    useAudioStore.getState().updateVocalRiding({ enabled: true, amount: 1, maxBoostDb: 10 });
    render(<VocalRidingPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    const vr = useAudioStore.getState().vocalRiding;
    expect(vr.enabled).toBe(false);
    expect(vr.maxBoostDb).toBe(6);
  });
});
