// Storybook stories for ProductPage — Loui Mastering product layout.
//
// The page accepts a `sessionOverride` prop in Storybook mode that bypasses
// the production WasmAnalyzerProvider entirely.  Each story builds a
// MockAnalyzerSession from the mock preset library and passes it in.

import { useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import ProductPage from './ProductPage';
import {
  createMockSession,
  MOCK_PRESETS,
  type MockPresetId,
  type MockAnalyzerSession,
} from '../audio/mock-analyzer-session';

interface ProductPageStoryArgs {
  preset: MockPresetId;
  active: boolean;
}

function StoryHost({ preset, active }: ProductPageStoryArgs) {
  const session = useMemo<MockAnalyzerSession>(
    () => createMockSession({ sampleRate: 48_000, channels: 2, preset }),
    [preset],
  );
  const [started, setStarted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    session.start().then(() => { if (!cancelled) setStarted(true); });
    return () => {
      cancelled = true;
      void session.stop();
    };
  }, [session]);
  if (!started) return <div style={{ padding: 24, color: '#a1a1aa' }}>starting mock session…</div>;
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ProductPage sessionOverride={session} storybookActive={active} />
    </div>
  );
}

const meta: Meta<typeof StoryHost> = {
  title: 'Product / ProductPage',
  component: StoryHost,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Full Loui Mastering ProductPage layout — TopBar, Preset Header, ' +
          'central Spectrum canvas, right-rail Meter Column (loudness + ' +
          'stereo), Module Strip shell, and Status Bar.  Driven by a mock ' +
          'AnalyzerSession; production uses WasmAnalyzerProvider with a ' +
          'real audio element instead.',
      },
    },
    viewport: {
      viewports: {
        wide:      { name: 'Wide 1440px',        styles: { width: '1440px', height: '900px' } },
        desktop:   { name: 'Desktop 1280px',     styles: { width: '1280px', height: '800px' } },
        narrow:    { name: 'Narrow laptop 1024', styles: { width: '1024px', height: '720px' } },
      },
      defaultViewport: 'wide',
    },
  },
  argTypes: {
    preset: {
      control: { type: 'select' },
      options: Object.keys(MOCK_PRESETS),
      description: 'Mock timeline preset feeding all analyzer streams.',
    },
    active: { control: 'boolean', description: 'Engine-active state (drives the live pulse).' },
  },
  args: {
    preset: 'spotify-loud' as MockPresetId,
    active: true,
  },
};
export default meta;
type Story = StoryObj<typeof StoryHost>;

export const SpotifyLoud: Story = {
  args: { preset: 'spotify-loud', active: true },
};

export const WarmAcoustic: Story = {
  args: { preset: 'warm-acoustic', active: true },
};

export const AIHarsh: Story = {
  args: { preset: 'ai-harsh', active: true },
};

export const ClippingRisk: Story = {
  args: { preset: 'clipping-risk', active: true },
};

export const BrokenPhase: Story = {
  args: { preset: 'broken-phase', active: true },
};

export const MonoSafe: Story = {
  args: { preset: 'mono-safe', active: true },
};

export const Idle: Story = {
  args: { preset: 'idle', active: false },
};

export const NarrowLaptop: Story = {
  args: { preset: 'spotify-loud', active: true },
  parameters: { viewport: { defaultViewport: 'narrow' } },
};

export const Desktop1280: Story = {
  args: { preset: 'spotify-loud', active: true },
  parameters: { viewport: { defaultViewport: 'desktop' } },
};
