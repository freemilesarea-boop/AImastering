import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ModulePresetBar from './ModulePresetBar.js';
import { useAudioStore } from '../stores/audioStore.js';
import { isTransientUnity } from '../audio/transient-config.js';
import { isMultibandUnity } from '../audio/multiband-config.js';

describe('<ModulePresetBar>', () => {
  beforeEach(() => {
    const st = useAudioStore.getState();
    st.resetMultiband(); st.resetImagerMultiband(); st.resetSaturation();
    st.resetTransient(); st.resetDynamicEq();
  });

  it('renders all presets', () => {
    render(<ModulePresetBar />);
    ['끄기', 'Punchy', 'Warm', 'Wide', 'Clean', 'Loud'].forEach((n) => expect(screen.getByText(n)).toBeTruthy());
  });

  it('clicking Punchy applies all 5 module slices (transient + multiband engaged)', () => {
    render(<ModulePresetBar />);
    fireEvent.click(screen.getByText('Punchy'));
    expect(isTransientUnity(useAudioStore.getState().transient)).toBe(false);
    expect(isMultibandUnity(useAudioStore.getState().multiband)).toBe(false);
  });

  it('clicking 끄기 bypasses everything again', () => {
    useAudioStore.getState().updateTransient({ bypass: false, attackPct: 50 });
    render(<ModulePresetBar />);
    fireEvent.click(screen.getByText('끄기'));
    expect(isTransientUnity(useAudioStore.getState().transient)).toBe(true);
  });
});
