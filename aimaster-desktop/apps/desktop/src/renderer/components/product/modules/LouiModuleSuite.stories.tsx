// Storybook QA for the Loui Module Suite (OZONE-STYLE-MODULE-SUITE).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiModuleChain } from './LouiModuleChain';
import { LouiMasteringVisualizer } from './LouiMasteringVisualizer';
import { LouiModuleStatusBadge } from './LouiModuleStatusBadge';
import { CHAIN_MODULE_IDS, LOUI_MODULES } from '../../../audio/modules/loui-module-suite';
import { surface, text } from '../../../theme/loui-theme';
import { loui } from '../../../theme/loui-home';

// Synthetic spectrum (log bins) for visual review without an audio device.
function synthSpectrum(tiltDb = 0) {
  const bins = 128;
  const binCentresHz: number[] = [];
  const magnitudeDb: number[] = [];
  const peakHoldDb: number[] = [];
  for (let i = 0; i < bins; i++) {
    const f = Math.pow(10, Math.log10(20) + (i / (bins - 1)) * (Math.log10(20000) - Math.log10(20)));
    binCentresHz.push(f);
    const base = -18 - 18 * (Math.log10(f / 20) / Math.log10(1000));
    const wobble = 6 * Math.sin(i * 0.5) * Math.exp(-i / 90);
    const tilt = tiltDb * (Math.log10(f / 20) / Math.log10(1000));
    const v = base + wobble + tilt;
    magnitudeDb.push(v);
    peakHoldDb.push(v + 4);
  }
  return { binCentresHz, magnitudeDb, peakHoldDb };
}
const spec = synthSpectrum();

const eqBands = { lowCutHz: 34, lowShelfDb: 0.8, presenceDb: 0.5, airDb: 2.0, outputGainDb: 0 };

const meta: Meta = {
  title: 'Product / Module Suite',
  parameters: { layout: 'fullscreen', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.background, padding: 20, minHeight: '100vh' }}><Story /></div>],
};
export default meta;
type Story = StoryObj;

export const StatusBadges: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 10 }}>
      <LouiModuleStatusBadge status="live" />
      <LouiModuleStatusBadge status="preview-only" />
      <LouiModuleStatusBadge status="export-only" />
      <LouiModuleStatusBadge status="planned" />
    </div>
  ),
};

export const Chain: Story = {
  render: () => {
    const [active, setActive] = React.useState('eq');
    const [bypassed, setBypassed] = React.useState<Record<string, boolean>>({});
    return (
      <LouiModuleChain
        activeId={active}
        bypassed={bypassed}
        onSelect={setActive}
        onToggleBypass={(id) => setBypassed((b) => ({ ...b, [id]: !b[id] }))}
      />
    );
  },
};

export const PlannedModuleState: Story = {
  render: () => (
    <LouiModuleChain
      moduleIds={['dynamic-eq', 'exciter', 'bass-control', 'reference-match', 'ai-harshness-guard']}
      activeId="exciter"
    />
  ),
};

export const VisualizerWithData: Story = {
  render: () => <LouiMasteringVisualizer {...spec} eqBands={eqBands} playhead={0.4} />,
};

export const VisualizerEqBypassed: Story = {
  render: () => <LouiMasteringVisualizer {...spec} eqBands={eqBands} eqBypassed />,
};

export const VisualizerNoSignal: Story = {
  render: () => <LouiMasteringVisualizer eqBands={eqBands} />,
};

// Full module hub — chain + central visualizer + active module summary.
function Hub({ narrow }: { narrow?: boolean }) {
  const [active, setActive] = React.useState('eq');
  const [bypassed, setBypassed] = React.useState<Record<string, boolean>>({});
  const mod = LOUI_MODULES.find((m) => m.id === active);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: narrow ? 420 : '100%' }}>
      <LouiMasteringVisualizer {...spec} eqBands={eqBands} eqBypassed={Boolean(bypassed['eq'])} playhead={0.3} />
      <LouiModuleChain
        moduleIds={CHAIN_MODULE_IDS as string[]}
        activeId={active}
        bypassed={bypassed}
        onSelect={setActive}
        onToggleBypass={(id) => setBypassed((b) => ({ ...b, [id]: !b[id] }))}
      />
      {mod && (
        <div style={{ padding: 14, borderRadius: 12, border: `1px solid ${surface.border}`, background: surface.panel }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: text.primary, fontWeight: 600 }}>{mod.displayName}</span>
            <LouiModuleStatusBadge status={mod.status} />
            {mod.algorithmName && <span style={{ color: loui.softLavender, fontSize: 11 }}>{mod.algorithmName}</span>}
          </div>
          <p style={{ color: text.tertiary, fontSize: 12, marginTop: 8, lineHeight: 1.4 }}>{mod.description}</p>
        </div>
      )}
    </div>
  );
}

export const FullModuleHub: Story = { render: () => <Hub /> };
export const NarrowLayout: Story = { render: () => <Hub narrow /> };
