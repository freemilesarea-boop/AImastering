// Storybook stories for LouiABCompare (M3-O-NEXT-7).

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { LouiABCompare, useABShortcut, type ABMode } from './LouiABCompare';
import { surface, text, typography, space } from '../../theme/loui-theme';

interface HostArgs {
  available: boolean;
  loudnessDeltaLu: number;
}

function Host({ available, loudnessDeltaLu }: HostArgs) {
  const [mode, setMode] = React.useState<ABMode>('after');
  const [compensated, setCompensated] = React.useState(true);
  useABShortcut(mode, available, setMode);
  return (
    <div style={{
      background: surface.background,
      padding: space['4'],
      display: 'flex',
      flexDirection: 'column',
      gap: space['3'],
      width: 520,
      fontFamily: typography.family.sans,
    }}>
      <LouiABCompare
        mode={mode}
        available={available}
        onToggle={setMode}
        compensated={compensated}
        onToggleCompensation={setCompensated}
        loudnessDeltaLu={loudnessDeltaLu}
      />
      <span style={{ fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.tertiary }}>
        mode: <b style={{ color: text.primary }}>{mode === 'before' ? 'A (Before)' : 'B (After)'}</b>
        {'  ·  '}LU match: {compensated ? 'on' : 'off'}
      </span>
      <span style={{ fontSize: typography.size.xs, color: text.muted }}>
        Press <b>B</b> to flip A/B (when an "After" render is available).
        In the app this performs a real preview source swap, position-preserved.
      </span>
    </div>
  );
}

const meta: Meta<typeof Host> = {
  title: 'Product / A-B Compare',
  component: Host,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Before / After instant compare.  A = original master preview, ' +
          'B = latest re-rendered preview.  Real source swap (no fake ' +
          'bypass), keyboard shortcut B, optional loudness-matched ' +
          'comparison so A/B reflects tone not loudness.',
      },
    },
  },
  argTypes: {
    available: { control: 'boolean' },
    loudnessDeltaLu: { control: { type: 'number', min: -6, max: 6, step: 0.1 } },
  },
  args: { available: true, loudnessDeltaLu: 2.4 },
};
export default meta;
type Story = StoryObj<typeof Host>;

export const Available: Story = { args: { available: true, loudnessDeltaLu: 2.4 } };
export const NoAfterYet: Story = { args: { available: false, loudnessDeltaLu: 0 } };
export const QuieterAfter: Story = { args: { available: true, loudnessDeltaLu: -1.8 } };
