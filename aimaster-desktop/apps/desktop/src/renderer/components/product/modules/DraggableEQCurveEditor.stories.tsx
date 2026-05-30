// Storybook QA for the draggable EQ editor (OZONE-MODULE-NEXT-5).
// Interactive — drag the band points; values update in the readout.

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { DraggableEQCurveEditor } from './DraggableEQCurveEditor';
import type { EqBands } from './EQCurveOverlay';
import { surface, text, typography } from '../../../theme/loui-theme';

function Editor({ initial, bypassed }: { initial: EqBands; bypassed?: boolean }) {
  const [bands, setBands] = React.useState<EqBands>(initial);
  const set = (paramId: string, value: number) =>
    setBands((b) => ({ ...b, [paramId]: value }));
  const width = 560, height = 240;
  return (
    <div>
      <div style={{ position: 'relative', width, height, background: '#1A1A24', border: `1px solid ${surface.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <DraggableEQCurveEditor width={width} height={height} bands={bands} {...(bypassed ? { bypassed: true } : {})} onChange={set} />
      </div>
      <div style={{ marginTop: 10, fontFamily: typography.family.mono, fontSize: 11, color: text.tertiary }}>
        LowCut {Math.round(bands.lowCutHz)}Hz · LowShelf {bands.lowShelfDb.toFixed(1)} · Presence {bands.presenceDb.toFixed(1)} · Air {bands.airDb.toFixed(1)} · Out {bands.outputGainDb.toFixed(1)}
      </div>
    </div>
  );
}

const FLAT: EqBands = { lowCutHz: 32, lowShelfDb: 0, presenceDb: 0, airDb: 0, outputGainDb: 0 };

const meta: Meta<typeof DraggableEQCurveEditor> = {
  title: 'Product / EQ Editor (draggable)',
  component: DraggableEQCurveEditor,
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
};
export default meta;
type Story = StoryObj<typeof DraggableEQCurveEditor>;

export const Flat: Story = { render: () => <Editor initial={FLAT} /> };
export const LowCutRaised: Story = { render: () => <Editor initial={{ ...FLAT, lowCutHz: 90 }} /> };
export const PresenceCut: Story = { render: () => <Editor initial={{ ...FLAT, presenceDb: -3 }} /> };
export const AirBoost: Story = { render: () => <Editor initial={{ ...FLAT, airDb: 3.5 }} /> };
export const WarmShelf: Story = { render: () => <Editor initial={{ ...FLAT, lowShelfDb: 3, airDb: -1.5 }} /> };
export const Bypassed: Story = { render: () => <Editor initial={{ lowCutHz: 60, lowShelfDb: 3, presenceDb: -2, airDb: 2, outputGainDb: 1 }} bypassed /> };
