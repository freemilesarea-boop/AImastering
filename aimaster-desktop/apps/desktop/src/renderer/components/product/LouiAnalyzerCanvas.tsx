// LouiAnalyzerCanvas — main analyzer surface (spectrum centre-piece).
//
// Wraps `<SpectrumAnalyzerPanel>` in a Loui-themed panel chrome:
//   • Panel header with title and a "live" pulse indicator
//   • Inner padding sized to `loui-theme.space.3`
//   • Bottom legend strip with axis labels
//
// The wrapped panel still owns the canvas + RAF loop — we only style
// the chrome around it.

import React from 'react';
import { surface, text, typography, radius, space, meter } from '../../theme/loui-theme.js';
import { SpectrumAnalyzerPanel } from '../SpectrumAnalyzerPanel.js';
import type { AnalyzerSession } from '@aimaster/shared-types/streaming';

export interface LouiAnalyzerCanvasProps {
  /** Live analyzer session — passed through to SpectrumAnalyzerPanel. */
  session?: AnalyzerSession | null;
  /** Whether the engine is actively producing frames (drives the pulse dot). */
  active?: boolean;
}

function LivePulse({ active }: { active: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: active ? meter.safe.foreground : surface.overlay,
          boxShadow: active ? `0 0 6px ${meter.safe.foreground}` : 'none',
          transition: 'background 120ms ease-out, box-shadow 120ms ease-out',
        }}
      />
      <span
        style={{
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: active ? meter.safe.foreground : text.muted,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {active ? 'live' : 'idle'}
      </span>
    </span>
  );
}

export function LouiAnalyzerCanvas(props: LouiAnalyzerCanvasProps) {
  const active = props.active ?? Boolean(props.session);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
        background: surface.panel,
        border: `1px solid ${surface.border}`,
        borderRadius: radius.panel,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: space['4'],
          paddingBlock: space['3'],
          borderBottom: `1px solid ${surface.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: space['3'] }}>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.md,
            fontWeight: typography.weight.semi,
            color: text.primary,
            letterSpacing: '-0.005em',
          }}>
            Spectrum
          </span>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            Live FFT · 1/3-oct
          </span>
        </div>
        <LivePulse active={active} />
      </div>

      {/* Canvas body — spectrum fills the remaining space.  The panel sets
          its own height via the canvas; we frame it with consistent padding.
          A subtle radial depth wash behind the trace gives the analyzer a
          centre-stage, product-grade feel (CSS only — no CPU cost). */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          padding: space['3'],
          display: 'flex',
          flexDirection: 'column',
          background: active
            ? 'radial-gradient(120% 90% at 50% 100%, rgba(167,139,250,0.06), transparent 70%)'
            : 'transparent',
          transition: 'background 200ms ease-out',
        }}
      >
        <SpectrumAnalyzerPanel session={props.session ?? null} showPeakHold />
      </div>

      {/* Footer legend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: space['4'],
          paddingBlock: space['2'],
          borderTop: `1px solid ${surface.border}`,
          background: surface.well,
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: text.muted,
          letterSpacing: '0.04em',
        }}
      >
        <span>20 Hz · 100 · 1 k · 10 k · 20 kHz</span>
        <span>−90 dB → 0 dB</span>
      </div>
    </div>
  );
}
