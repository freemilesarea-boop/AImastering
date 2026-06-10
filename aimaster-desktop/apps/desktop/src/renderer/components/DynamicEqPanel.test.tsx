import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DynamicEqPanel from './DynamicEqPanel.js';
import { useAudioStore } from '../stores/audioStore.js';

describe('<DynamicEqPanel>', () => {
  beforeEach(() => { useAudioStore.getState().resetDynamicEq(); });

  it('renders empty + bypassed by default', () => {
    render(<DynamicEqPanel />);
    expect(screen.getByText('밴드를 추가하세요.')).toBeTruthy();
    expect(useAudioStore.getState().dynamicEq.bands).toHaveLength(0);
  });

  it('adds a band to the store + DOM', () => {
    render(<DynamicEqPanel />);
    fireEvent.click(screen.getByRole('button', { name: /밴드 추가/ }));
    expect(useAudioStore.getState().dynamicEq.bands).toHaveLength(1);
    expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(2); // type + mode selects
  });

  it('caps the add button at MAX_DYNEQ_BANDS', () => {
    for (let i = 0; i < 6; i++) useAudioStore.getState().addDynEqBand(1000);
    render(<DynamicEqPanel />);
    expect((screen.getByRole('button', { name: /밴드 추가/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('changing band mode updates the store', () => {
    useAudioStore.getState().addDynEqBand(1000);
    render(<DynamicEqPanel />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(selects[1]!, { target: { value: 'upboost' } });
    expect(useAudioStore.getState().dynamicEq.bands[0]!.mode).toBe('upboost');
  });

  it('removing a band clears it', () => {
    useAudioStore.getState().addDynEqBand(1000);
    render(<DynamicEqPanel />);
    fireEvent.click(screen.getByRole('button', { name: '밴드 삭제' }));
    expect(useAudioStore.getState().dynamicEq.bands).toHaveLength(0);
  });
});
