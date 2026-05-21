// Storybook QA for the realtime status indicator (OZONE-MODULE-NEXT-5).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiRealtimeStatus } from './LouiRealtimeStatus';
import { surface } from '../../../theme/loui-theme';

const meta: Meta<typeof LouiRealtimeStatus> = {
  title: 'Product / Realtime Status',
  component: LouiRealtimeStatus,
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.background, padding: 24 }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof LouiRealtimeStatus>;

export const LiveActive: Story = { args: { enabled: true, active: true, readinessLabel: 'realtime-ready' } };
export const Starting: Story = { args: { enabled: true, active: false, readinessLabel: 'realtime-ready' } };
export const Unavailable: Story = {
  args: { enabled: true, active: false, readinessLabel: 'realtime-unavailable: AudioWorklet unavailable' },
};
export const Off: Story = { args: { enabled: false, active: false } };
