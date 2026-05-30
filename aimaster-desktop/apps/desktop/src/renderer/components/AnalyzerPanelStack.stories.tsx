// Storybook stories for AnalyzerPanelStack — the gate that ResultPage
// renders.
//
// In production, AnalyzerPanelStack picks between V1 (existing
// LoudnessMeterPanel) and V2 (V2PanelStack inside WasmAnalyzerProvider)
// based on the WASM analyzer feature flag.
//
// Storybook can't easily mount the production gate because:
//   • The V1 path requires a real `HTMLMediaElement` with playable audio.
//   • The V2 path requires real WASM + AudioContext (none in jsdom).
//
// So this file demonstrates the V2 visual layout via a thin re-creation
// — three V2 components mounted with the same mock session.  This is
// the same stack the real `<V2PanelStack>` renders inside the provider,
// minus the WASM session boot.

import { useEffect, useState, useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { LoudnessMeterPanelV2 } from './LoudnessMeterPanelV2';
import { SpectrumAnalyzerPanel } from './SpectrumAnalyzerPanel';
import { StereoScopePanel } from './StereoScopePanel';

import {
  createMockSession,
  MOCK_PRESETS,
  type MockPresetId,
  type MockAnalyzerSession,
} from '../audio/mock-analyzer-session';

interface PanelStackArgs {
  preset: MockPresetId;
  showSpectrum: boolean;
  showStereo: boolean;
}

function MockPanelStack({ preset, showSpectrum, showStereo }: PanelStackArgs) {
  // Build a session once per (preset) and re-use across child panels.
  // Cleaning it up on unmount mirrors WasmAnalyzerProvider's behaviour.
  const session = useMemo<MockAnalyzerSession>(
    () =>
      createMockSession({
        sampleRate: 48_000,
        channels: 2,
        preset,
      }),
    [preset],
  );
  const [started, setStarted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    session.start().then(() => { if (!cancelled) setStarted(true); });
    return () => {
      cancelled = true;
      session.stop();
    };
  }, [session]);
  if (!started) return <div className="text-zinc-500 text-sm font-mono">starting mock…</div>;

  return (
    <div className="space-y-3" style={{ width: 640 }}>
      <LoudnessMeterPanelV2 session={session} tickRate="30Hz" />
      {showSpectrum && <SpectrumAnalyzerPanel session={session} showPeakHold />}
      {showStereo && <StereoScopePanel session={session} />}
    </div>
  );
}

const meta: Meta<typeof MockPanelStack> = {
  title: 'Audio Panels / Analyzer Panel Stack (V2)',
  component: MockPanelStack,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The full V2 stack — Loudness Meter + Spectrum Analyzer + Stereo ' +
          'Scope — driven by one shared mock session.  This mirrors the ' +
          'production `WasmAnalyzerProvider` → `V2PanelStack` layout that ' +
          'ResultPage mounts when the WASM analyzer flag is on.',
      },
    },
  },
  argTypes: {
    preset: {
      control: { type: 'select' },
      options: Object.keys(MOCK_PRESETS),
      description: 'Mock timeline preset driving the entire stack.',
    },
    showSpectrum: { control: 'boolean' },
    showStereo: { control: 'boolean' },
  },
  args: {
    preset: 'spotify-loud' as MockPresetId,
    showSpectrum: true,
    showStereo: true,
  },
};
export default meta;
type Story = StoryObj<typeof MockPanelStack>;

export const SpotifyLoud: Story = { args: { preset: 'spotify-loud' } };
export const WarmAcoustic: Story = { args: { preset: 'warm-acoustic' } };
export const AIHarsh: Story = { args: { preset: 'ai-harsh' } };
export const BrokenPhase: Story = { args: { preset: 'broken-phase' } };
export const ClippingRisk: Story = { args: { preset: 'clipping-risk' } };
export const MonoSafe: Story = { args: { preset: 'mono-safe' } };
export const Idle: Story = { args: { preset: 'idle' } };

export const MeterOnly: Story = {
  args: { preset: 'spotify-loud', showSpectrum: false, showStereo: false },
};

export const MeterAndSpectrum: Story = {
  args: { preset: 'spotify-loud', showSpectrum: true, showStereo: false },
};
