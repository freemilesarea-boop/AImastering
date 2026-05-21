// Storybook QA for the dev/QA realtime toggle (REALTIME-SOUND-CHANGE).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiRealtimeToggle } from './LouiRealtimeToggle';
import { surface } from '../../../theme/loui-theme';

const meta: Meta<typeof LouiRealtimeToggle> = {
  title: 'Product / Realtime Toggle',
  component: LouiRealtimeToggle,
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.background, padding: 24 }}><Story /></div>],
  args: { onToggle: () => {} },
};
export default meta;
type Story = StoryObj<typeof LouiRealtimeToggle>;

export const OffReady: Story = { args: { enabled: false, ready: true, readinessLabel: 'realtime-ready' } };
export const On: Story = { args: { enabled: true, ready: true, readinessLabel: 'realtime-ready' } };
export const Blocked: Story = {
  args: { enabled: false, ready: false, readinessLabel: 'realtime-unavailable: AudioWorklet unavailable' },
};
