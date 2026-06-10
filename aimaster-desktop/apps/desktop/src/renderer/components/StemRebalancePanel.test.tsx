import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StemRebalancePanel from './StemRebalancePanel.js';
import { useAudioStore } from '../stores/audioStore.js';

describe('<StemRebalancePanel>', () => {
  beforeEach(() => { useAudioStore.getState().resetRebalance(); });

  it('renders the approximation tier and the (gated) precise tier', () => {
    render(<StemRebalancePanel />);
    expect(screen.getAllByText(/근사/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/정밀/).length).toBeGreaterThan(0);
    // Precise tier is not yet available → labelled as such and disabled.
    expect(screen.getByText(/모델 필요/)).toBeTruthy();
    expect((screen.getByLabelText('정밀 분리 사용') as HTMLInputElement).disabled).toBe(true);
  });

  it('moving the vocal slider updates the store live', () => {
    render(<StemRebalancePanel />);
    const sliders = screen.getAllByRole('slider') as HTMLInputElement[];
    fireEvent.change(sliders[0]!, { target: { value: '4' } });
    expect(useAudioStore.getState().rebalance.vocalDb).toBe(4);
  });

  it('reset returns the store to default rebalance', () => {
    useAudioStore.getState().updateRebalance({ vocalDb: 6, sidePct: 150 });
    render(<StemRebalancePanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useAudioStore.getState().rebalance.vocalDb).toBe(0);
    expect(useAudioStore.getState().rebalance.sidePct).toBe(100);
  });
});
