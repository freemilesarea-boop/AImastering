import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MultibandGrMeter from './MultibandGrMeter.js';

describe('<MultibandGrMeter>', () => {
  it('renders 4 band labels', () => {
    render(<MultibandGrMeter getReductions={() => null} />);
    ['저역', '저중', '고중', '고역'].forEach((l) => expect(screen.getByText(l)).toBeTruthy());
  });

  it('shows "—" placeholders when no multiband chain is active', () => {
    render(<MultibandGrMeter getReductions={() => null} />);
    expect(screen.getAllByText('—').length).toBe(4);
  });

  it('mounts + unmounts without leaking the rAF loop', () => {
    const spy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const { unmount } = render(<MultibandGrMeter getReductions={() => [-3, 0, -1, 0]} />);
    unmount();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
