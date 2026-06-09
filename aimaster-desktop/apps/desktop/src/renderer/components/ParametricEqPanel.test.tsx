import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ParametricEqPanel from './ParametricEqPanel.js';
import { useAudioStore } from '../stores/audioStore.js';

describe('<ParametricEqPanel> (renderer component harness)', () => {
  beforeEach(() => {
    useAudioStore.getState().resetParametricEq();
  });

  it('renders the empty hint when no bands exist', () => {
    render(<ParametricEqPanel />);
    expect(screen.getByText(/밴드를 추가하면/)).toBeTruthy();
  });

  it('adds a band to the store + DOM when "밴드 추가" is clicked', () => {
    render(<ParametricEqPanel />);
    fireEvent.click(screen.getByRole('button', { name: /밴드 추가/ }));
    expect(useAudioStore.getState().parametricEqBands).toHaveLength(1);
    // A band row exposes a type <select> with the band-type options.
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('caps the add button at MAX_BANDS (disabled when full)', () => {
    const add = useAudioStore.getState().addParametricBand;
    for (let i = 0; i < 7; i++) add(1000);
    render(<ParametricEqPanel />);
    const btn = screen.getByRole('button', { name: /밴드 추가/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(useAudioStore.getState().parametricEqBands).toHaveLength(7);
  });

  it('changing the type <select> updates the store band', () => {
    useAudioStore.getState().addParametricBand(1000);
    render(<ParametricEqPanel />);
    const row = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(row, { target: { value: 'highshelf' } });
    expect(useAudioStore.getState().parametricEqBands[0]!.type).toBe('highshelf');
  });

  it('removing a band clears it from the store', () => {
    useAudioStore.getState().addParametricBand(1000);
    render(<ParametricEqPanel />);
    fireEvent.click(screen.getByRole('button', { name: '밴드 삭제' }));
    expect(useAudioStore.getState().parametricEqBands).toHaveLength(0);
  });

  it('toggling a band enable checkbox flips its enabled flag', () => {
    useAudioStore.getState().addParametricBand(1000);
    render(<ParametricEqPanel />);
    const cb = within(screen.getByRole('checkbox').closest('div')!).getByRole('checkbox') as HTMLInputElement;
    expect(useAudioStore.getState().parametricEqBands[0]!.enabled).toBe(true);
    fireEvent.click(cb);
    expect(useAudioStore.getState().parametricEqBands[0]!.enabled).toBe(false);
  });
});
