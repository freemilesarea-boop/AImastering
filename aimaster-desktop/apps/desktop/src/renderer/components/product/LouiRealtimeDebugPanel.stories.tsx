// Storybook stories for the realtime-preview debug panel (M2-full).

import type { Meta, StoryObj } from '@storybook/react-vite';

import { LouiRealtimeDebugPanel } from './LouiRealtimeDebugPanel';
import type { RealtimeMetricsSnapshot } from '../../audio/realtime-metrics';
import { surface } from '../../theme/loui-theme';

function metrics(p: Partial<RealtimeMetricsSnapshot> = {}): RealtimeMetricsSnapshot {
  return {
    cpuLoad: 0.08, avgProcessMs: 0.21, peakProcessMs: 0.55, blockPeriodMs: 2.67,
    totalXruns: 0, limiterGrDb: 2.3, samples: 64, ...p,
  };
}

const meta: Meta<typeof LouiRealtimeDebugPanel> = {
  title: 'Product / Realtime Debug Panel',
  component: LouiRealtimeDebugPanel,
  parameters: {
    layout: 'centered',
    backgrounds: { default: 'dark' },
    docs: {
      description: {
        component:
          'Dev-only realtime-preview health overlay for device testing — ' +
          'CPU load, process time, xruns, limiter GR, AudioContext state, ' +
          'readiness, and ON/OFF status.',
      },
    },
  },
  decorators: [(Story) => <div style={{ background: surface.background, padding: 24 }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof LouiRealtimeDebugPanel>;

export const ActiveHealthy: Story = {
  args: {
    active: true, uiStatus: 'active', readiness: 'realtime-ready',
    contextState: 'running', sampleRate: 48000, bufferSize: 128,
    configUpdates: 42, lastConfigAt: Date.now(),
    metrics: metrics(),
  },
};

export const Failed: Story = {
  args: {
    active: false, uiStatus: 'failed', readiness: 'realtime-ready',
    fallbackReason: 'wasm-fetch-failed',
    contextState: 'running', sampleRate: 48000,
    configUpdates: 0, lastConfigAt: null,
    metrics: metrics({ cpuLoad: 0, avgProcessMs: 0, peakProcessMs: 0, samples: 0, limiterGrDb: 0 }),
  },
};

export const HighCpuWarning: Story = {
  args: {
    active: true, readiness: 'realtime-ready',
    contextState: 'running', sampleRate: 48000, bufferSize: 128,
    metrics: metrics({ cpuLoad: 0.32, avgProcessMs: 0.85, peakProcessMs: 1.6 }),
  },
};

export const XrunsDetected: Story = {
  args: {
    active: true, readiness: 'realtime-ready',
    contextState: 'running', sampleRate: 48000, bufferSize: 128,
    metrics: metrics({ cpuLoad: 0.61, avgProcessMs: 1.7, peakProcessMs: 3.2, totalXruns: 7 }),
  },
};

export const OffReRender: Story = {
  args: {
    active: false, readiness: 'realtime-ready',
    contextState: 'running', sampleRate: 48000,
    metrics: metrics({ cpuLoad: 0, avgProcessMs: 0, peakProcessMs: 0, samples: 0, limiterGrDb: 0 }),
  },
};

export const Unavailable: Story = {
  args: {
    active: false,
    readiness: 'realtime-unavailable: AudioWorklet unavailable (ScriptProcessor is not used)',
    metrics: metrics({ cpuLoad: 0, avgProcessMs: 0, peakProcessMs: 0, samples: 0, limiterGrDb: 0 }),
  },
};

export const WasmReady: Story = {
  args: {
    active: true, readiness: 'realtime-ready',
    contextState: 'running', sampleRate: 48000, bufferSize: 128,
    metrics: metrics(),
    wasmLoad: {
      phase: 'ready', wasmCompiled: true, glueLoaded: true,
      processorRegistered: true, nodeConstructed: true,
    },
  },
};

export const WasmLoading: Story = {
  args: {
    active: false, readiness: 'realtime-ready',
    contextState: 'suspended', sampleRate: 48000,
    metrics: metrics({ cpuLoad: 0, avgProcessMs: 0, peakProcessMs: 0, samples: 0, limiterGrDb: 0 }),
    wasmLoad: {
      phase: 'loading-glue', wasmCompiled: true, glueLoaded: false,
      processorRegistered: false, nodeConstructed: false,
    },
  },
};

export const WasmLoadFailed: Story = {
  args: {
    active: false, readiness: 'realtime-ready',
    contextState: 'running', sampleRate: 48000,
    metrics: metrics({ cpuLoad: 0, avgProcessMs: 0, peakProcessMs: 0, samples: 0, limiterGrDb: 0 }),
    wasmLoad: {
      phase: 'failed', wasmCompiled: false, glueLoaded: false,
      processorRegistered: false, nodeConstructed: false,
      failureReason: 'wasm-fetch-failed', lastError: 'failed to fetch ./loui-mastering-wasm.nomodules.wasm',
    },
  },
};
