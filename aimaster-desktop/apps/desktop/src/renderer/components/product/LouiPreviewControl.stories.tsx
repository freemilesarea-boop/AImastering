// Storybook stories for the preview re-render loop (M3-P-NEXT-5C).
//
// Drives LouiPreviewControl through a real PreviewRenderController backed
// by a MockPreviewRenderTransport — so debounce / latest-wins / stale
// rejection are exercised without a live IPC.

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { LouiPreviewControl, type PreviewControlPhase } from './LouiPreviewControl';
import {
  PreviewRenderController,
  MockPreviewRenderTransport,
  type PreviewRenderState,
} from '../../audio/engine-bridge/index';
import type { MasteringOptions } from '@aimaster/shared-types';
import { surface, text, typography, space, radius } from '../../theme/loui-theme';

const BASE_OPTIONS: MasteringOptions = {
  style: 'balanced',
  targetLufs: -14,
  targetTp: -1,
  sampleRate: 48000,
  bitDepth: 24,
  applyAiCorrections: true,
};

interface HostArgs {
  scenario: 'no-changes' | 'pending' | 'render-success' | 'render-fail' | 'stale' | 'rapid' | 'mixed';
}

function Host({ scenario }: HostArgs) {
  const [phase, setPhase] = React.useState<PreviewControlPhase>('idle');
  const [lastRenderedAt, setLastRenderedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingCount, setPendingCount] = React.useState(
    scenario === 'no-changes' ? 0 : scenario === 'mixed' ? 3 : 1,
  );
  const stagedOnlyCount = scenario === 'mixed' ? 2 : 0;
  const [renderedPath, setRenderedPath] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<string[]>([]);

  const controllerRef = React.useRef<PreviewRenderController | null>(null);
  if (!controllerRef.current) {
    const transport = new MockPreviewRenderTransport({
      delayMs: 1000,
      ...(scenario === 'render-fail' ? { failWith: 'mock engine: render timed out' } : {}),
    });
    controllerRef.current = new PreviewRenderController(transport, {
      debounceMs: scenario === 'rapid' ? 600 : 200,
      onState: (s: PreviewRenderState) => {
        switch (s.phase) {
          case 'idle':      setPhase('idle'); break;
          case 'pending':   setPhase('pending'); break;
          case 'rendering': setPhase('rendering'); setLog((l) => [...l, `→ rendering req#${s.requestId}`]); break;
          case 'updated':   setPhase('updated'); setLastRenderedAt(s.at); break;
          case 'error':     setPhase('error'); setError(s.error); break;
        }
      },
      onSuccess: (path) => {
        setRenderedPath(path);
        setPendingCount(0);
        setLog((l) => [...l, `✓ preview swapped → ${path}`]);
      },
      onError: (e) => setLog((l) => [...l, `✗ ${e}`]),
    });
  }
  React.useEffect(() => () => controllerRef.current?.dispose(), []);

  const fire = (override: Partial<MasteringOptions>, changedKeys: string[]) => {
    controllerRef.current!.request({
      sourceAudioPath: '/tmp/source.wav',
      options: { ...BASE_OPTIONS, ...override },
      changedKeys,
    });
    controllerRef.current!.flush();
  };

  const onUpdate = () => {
    switch (scenario) {
      case 'no-changes':
        // nothing to render
        break;
      case 'mixed':
        // 3 renderable + 2 staged-only changes; render applies the 3.
        fire({ targetLufs: -10, targetTp: -0.8, stereoWidth: 1.3 }, ['targetLufs', 'targetTp', 'stereoWidth']);
        setLog((l) => [...l, 'fired 3 renderable (targetLufs/targetTp/stereoWidth); 2 staged-only skipped']);
        break;
      case 'stale':
        // Fire two requests rapidly — only the 2nd response should win.
        fire({ targetLufs: -10 }, ['targetLufs']);
        setTimeout(() => fire({ targetLufs: -8 }, ['targetLufs']), 50);
        setLog((l) => [...l, 'fired req A (-10) then req B (-8); only B should swap']);
        break;
      case 'rapid':
        // Three rapid requests within the debounce window → one render.
        controllerRef.current!.request({ sourceAudioPath: '/tmp/source.wav', options: { ...BASE_OPTIONS, targetLufs: -12 }, changedKeys: ['targetLufs'] });
        controllerRef.current!.request({ sourceAudioPath: '/tmp/source.wav', options: { ...BASE_OPTIONS, targetLufs: -11 }, changedKeys: ['targetLufs'] });
        controllerRef.current!.request({ sourceAudioPath: '/tmp/source.wav', options: { ...BASE_OPTIONS, targetLufs: -10 }, changedKeys: ['targetLufs'] });
        setLog((l) => [...l, 'queued 3 requests in the debounce window → expect 1 render']);
        break;
      default:
        fire({ targetLufs: -10 }, ['targetLufs']);
        break;
    }
  };

  return (
    <div style={{
      background: surface.background,
      color: text.secondary,
      fontFamily: typography.family.sans,
      minHeight: 360,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <LouiPreviewControl
        pendingCount={pendingCount}
        stagedOnlyCount={stagedOnlyCount}
        phase={phase}
        lastRenderedAt={lastRenderedAt}
        error={error}
        onUpdate={onUpdate}
      />
      <div style={{ padding: space['4'], display: 'flex', flexDirection: 'column', gap: space['3'] }}>
        <span style={{ fontSize: typography.size.sm, color: text.muted, lineHeight: 1.5 }}>
          Mock transport · {scenario === 'rapid' ? '600ms debounce' : '200ms debounce'} · 1000ms simulated render.
          Click "Update Preview" to drive the scenario.
        </span>
        <div style={{
          background: surface.panel,
          border: `1px solid ${surface.border}`,
          borderRadius: radius.panel,
          padding: space['2'],
          minHeight: 120,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
          {log.length === 0 && (
            <span style={{ fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.muted }}>
              (event log — click Update Preview)
            </span>
          )}
          {log.map((line, i) => (
            <span key={i} style={{ fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.tertiary }}>
              {line}
            </span>
          ))}
        </div>
        {renderedPath && (
          <span style={{ fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.muted }}>
            current preview: {renderedPath}
          </span>
        )}
      </div>
    </div>
  );
}

const meta: Meta<typeof Host> = {
  title: 'Product / Preview Render',
  component: Host,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The preview re-render loop — LouiPreviewControl driven by a ' +
          'PreviewRenderController + MockPreviewRenderTransport.  ' +
          'Exercises debounce, latest-wins, stale-response rejection, and ' +
          'success / failure states without a live IPC render.',
      },
    },
  },
  argTypes: {
    scenario: {
      control: { type: 'select' },
      options: ['no-changes', 'pending', 'render-success', 'render-fail', 'stale', 'rapid', 'mixed'],
    },
  },
  args: { scenario: 'pending' },
};
export default meta;
type Story = StoryObj<typeof Host>;

export const NoChanges:        Story = { args: { scenario: 'no-changes' } };
export const PendingChange:    Story = { args: { scenario: 'pending' } };
export const RenderingSuccess: Story = { args: { scenario: 'render-success' } };
export const RenderFailed:     Story = { args: { scenario: 'render-fail' } };
export const StaleResponseIgnored: Story = { args: { scenario: 'stale' } };
export const RapidDebounced:   Story = { args: { scenario: 'rapid' } };
export const MixedRenderableAndStaged: Story = { args: { scenario: 'mixed' } };
