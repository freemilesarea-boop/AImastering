// LouiMeterColumn — right-rail meter cluster.
//
// Vertical stack of the two production V2 meter panels:
//   • LoudnessMeterPanelV2 — momentary / short-term / integrated / TP
//   • StereoScopePanel     — correlation needle + categorical verdict
//
// Each panel is wrapped in a Loui-themed `MeterPanelShell` for visual
// consistency with the rest of the product layout (theme-token border,
// header typography, inner padding).

import React from 'react';
import { surface, text, typography, radius, space } from '../../theme/loui-theme.js';
import { LoudnessMeterPanelV2 } from '../LoudnessMeterPanelV2.js';
import { StereoScopePanel } from '../StereoScopePanel.js';
import { NativeLoudnessMeter, NativeStereoMeter, NativeLevelsMeter } from './modules/NativeMeterCards.js';
import type { AnalyzerSession } from '@aimaster/shared-types/streaming';

export interface LouiMeterColumnProps {
  session?: AnalyzerSession | null;
  /** Optional target LUFS — colour-codes the integrated readout. */
  targetLufs?: number;
}

function PanelShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingInline: space['4'],
        paddingBlock: space['3'],
        borderBottom: `1px solid ${surface.border}`,
      }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.md,
          fontWeight: typography.weight.semi,
          color: text.primary,
        }}>
          {title}
        </span>
        {subtitle && (
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            {subtitle}
          </span>
        )}
      </div>
      <div style={{ padding: space['3'] }}>
        {children}
      </div>
    </div>
  );
}

export function LouiMeterColumn(props: LouiMeterColumnProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: space['3'],
      minHeight: 0,
      height: '100%',
      overflowY: 'auto',
    }}>
      {/* Native meters are the always-on base (never an empty card).  The
          WASM BS.1770 panels render above them when a session has data. */}
      <PanelShell title="Loudness" subtitle="Momentary · Short · Integ · Peak">
        <NativeLoudnessMeter />
        {props.session && (
          <div style={{ marginTop: 10 }}>
            <LoudnessMeterPanelV2
              session={props.session}
              tickRate="30Hz"
              {...(typeof props.targetLufs === 'number' ? { targetLufs: props.targetLufs } : {})}
            />
          </div>
        )}
      </PanelShell>
      <PanelShell title="Stereo" subtitle="Correlation · M/S · Width">
        <NativeStereoMeter />
        {props.session && (
          <div style={{ marginTop: 10 }}>
            <StereoScopePanel session={props.session} />
          </div>
        )}
      </PanelShell>
      <PanelShell title="Levels" subtitle="RMS · Peak · Headroom · Clip">
        <NativeLevelsMeter />
      </PanelShell>
    </div>
  );
}
