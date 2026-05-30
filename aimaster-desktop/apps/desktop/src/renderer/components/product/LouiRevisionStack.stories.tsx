// Storybook stories for the revision (version) stack (M3-REVISION-WORKFLOW).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiRevisionStack } from './LouiRevisionStack';
import { initGroup, addRevision } from '../../audio/revisions/revision-logic';
import type { RevisionInput } from '../../audio/revisions/revision-types';
import type { MasteringOptions } from '../../stores/audioStore';
import { surface } from '../../theme/loui-theme';

const opts = (o: Partial<MasteringOptions> = {}): MasteringOptions => ({
  style: 'balanced', targetLufs: -14, targetTp: -1, sampleRate: 48000, bitDepth: 24,
  applyAiCorrections: true, limiterStrength: 'medium', ...o,
});
const input = (o: Partial<RevisionInput> = {}): RevisionInput => ({
  sourceFilePath: '/tmp/song.wav', sourceFileName: 'song.wav',
  optionsSnapshot: opts(), outputPath: '/tmp/o.wav', previewPath: '/tmp/p.mp3',
  metrics: { integratedLufs: -14, truePeakDbtp: -1, lra: 7.2 }, formatSummary: '48 kHz · 24-bit', ...o,
});

let g = initGroup(input({ presetId: 'streaming-pro' }));
g = addRevision(g, input({ optionsSnapshot: opts({ targetLufs: -10, stereoWidth: 1.12 }), presetId: 'ai-pop', metrics: { integratedLufs: -10, truePeakDbtp: -1 } }));
g = addRevision(g, input({ optionsSnapshot: opts({ targetLufs: -8, stereoWidth: 1.25, outputGainDb: 1 }), presetId: 'kpop-loud', metrics: { integratedLufs: -8, truePeakDbtp: -0.9 } }));
g.revisions[1]!.isFavorite = true;

const names: Record<string, string> = { 'streaming-pro': 'Streaming Pro', 'ai-pop': 'AI Pop', 'kpop-loud': 'KPOP Loud' };

const meta: Meta<typeof LouiRevisionStack> = {
  title: 'Product / Revision Stack',
  component: LouiRevisionStack,
  parameters: { layout: 'padded', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.background, padding: 20, maxWidth: 460 }}><Story /></div>],
  args: { presetNameFor: (id: string) => names[id] ?? id },
};
export default meta;
type Story = StoryObj<typeof LouiRevisionStack>;

const single = initGroup(input({ presetId: 'streaming-pro' }));

export const NoVersionSourcePreview: Story = {
  name: 'No version (source preview)',
  args: { revisions: [], activeId: '' },
};

export const FirstRevisionCreating: Story = {
  args: { revisions: [], activeId: '', creating: true },
};

export const FirstRevisionFailed: Story = {
  args: { revisions: [], activeId: '', createError: 'master produced no output' },
};

export const OneRevision: Story = {
  args: { revisions: single.revisions, activeId: single.activeRevisionId },
};

export const MultipleRevisions: Story = {
  args: { revisions: g.revisions, activeId: g.revisions[0]!.id },
};

export const ActiveSelected: Story = {
  args: { revisions: g.revisions, activeId: g.revisions[2]!.id },
};

export const RenderingNew: Story = {
  args: { revisions: g.revisions, activeId: g.revisions[2]!.id, creating: true },
};

export const RenderFailed: Story = {
  args: { revisions: g.revisions, activeId: g.revisions[0]!.id, createError: 'master produced no output' },
};

export const DuplicateWarning: Story = {
  args: { revisions: g.revisions, activeId: g.revisions[2]!.id, duplicateWarning: true },
};

export const Interactive: Story = {
  render: (args) => {
    const [grp, setGrp] = React.useState(g);
    return (
      <LouiRevisionStack
        {...args}
        revisions={grp.revisions}
        activeId={grp.activeRevisionId}
        onSelect={(id) => setGrp((p) => ({ ...p, activeRevisionId: id }))}
        onToggleFavorite={(id) => setGrp((p) => ({ ...p, revisions: p.revisions.map((r) => r.id === id ? { ...r, isFavorite: !r.isFavorite } : r) }))}
      />
    );
  },
};
