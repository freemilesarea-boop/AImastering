// Storybook QA for the collapsible realtime debug drawer.

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiRealtimeDebugDrawer } from './LouiRealtimeDebugDrawer';
import { LouiRealtimeDebugPanel } from './LouiRealtimeDebugPanel';
import type { RealtimeMetricsSnapshot } from '../../audio/realtime-metrics';
import { surface } from '../../theme/loui-theme';

function metrics(p: Partial<RealtimeMetricsSnapshot> = {}): RealtimeMetricsSnapshot {
  return {
    cpuLoad: 0.08, avgProcessMs: 0.21, peakProcessMs: 0.55, blockPeriodMs: 2.67,
    totalXruns: 0, limiterGrDb: 2.3, safetyEvents: 0,
    processCalls: 1920, audioBlocks: 1920, nonSilentBlocks: 1880, samples: 64, ...p,
  };
}

const meta: Meta<typeof LouiRealtimeDebugDrawer> = {
  title: 'Product / Realtime Debug Drawer',
  component: LouiRealtimeDebugDrawer,
  parameters: { layout: 'fullscreen', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.background, minHeight: 320 }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof LouiRealtimeDebugDrawer>;

const panel = (
  <LouiRealtimeDebugPanel
    active uiStatus="active" readiness="realtime-ready"
    contextState="running" sampleRate={48000} bufferSize={128}
    configUpdates={42} lastConfigAt={Date.now()}
    config={{ imgWidthPct: 130, eqPresenceDb: 1.4, eqAirDb: 2, dynThresholdDb: -14, dynRatio: 2 }}
    metrics={metrics()}
  />
);

export const Active: Story = { args: { status: 'active', children: panel } };
export const Waiting: Story = { args: { status: 'waiting', children: panel } };
export const Off: Story = { args: { status: 'off', children: panel } };
