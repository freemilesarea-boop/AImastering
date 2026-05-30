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

export const LiveActive: Story = { args: { status: 'active', readinessLabel: 'realtime-ready' } };
export const Waiting: Story = { args: { status: 'waiting', readinessLabel: 'realtime-ready' } };
export const Passthrough: Story = { args: { status: 'passthrough', readinessLabel: 'realtime-ready' } };
export const Starting: Story = { args: { status: 'starting', readinessLabel: 'realtime-ready' } };
export const Failed: Story = { args: { status: 'failed', readinessLabel: 'realtime-ready' } };
export const Unavailable: Story = {
  args: { status: 'unavailable', readinessLabel: 'realtime-unavailable: AudioWorklet unavailable' },
};
export const Off: Story = { args: { status: 'off' } };

// Legacy enabled/active props still derive a status (storybook back-compat).
export const LegacyEnabledActive: Story = { args: { enabled: true, active: true, readinessLabel: 'realtime-ready' } };
