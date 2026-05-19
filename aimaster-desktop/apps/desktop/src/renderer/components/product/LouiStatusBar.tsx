// LouiStatusBar — slim bottom strip with engine + signal stats.
//
// Left cluster: sample rate · channels · oversampling factor
// Mid cluster:  target LUFS · target TP
// Right cluster: engine status (WASM/Synthetic) · running indicator

import React from 'react';
import { surface, text, typography, space, meter } from '../../theme/loui-theme.js';

export interface LouiStatusBarProps {
  sampleRate?: number;
  channels?: number;
  oversample?: number;
  targetLufs?: number;
  targetTp?: number;
  engineLabel?: string;
  /** Whether the analyzer engine is producing frames. */
  running?: boolean;
}

function StatusCell({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 6,
    }}>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: mono ? typography.family.mono : typography.family.sans,
        fontSize: typography.size.xs,
        color: text.secondary,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </span>
  );
}

export function LouiStatusBar(props: LouiStatusBarProps) {
  const sr = props.sampleRate ?? 48000;
  const channels = props.channels ?? 2;
  const oversample = props.oversample ?? 4;
  const tLufs = typeof props.targetLufs === 'number' ? `${props.targetLufs.toFixed(1)} LUFS` : '−14.0 LUFS';
  const tTp   = typeof props.targetTp   === 'number' ? `${props.targetTp.toFixed(1)} dBTP` : '−1.0 dBTP';
  const running = props.running ?? false;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: space['4'],
      height: 28,
      paddingInline: space['4'],
      background: surface.background,
      borderTop: `1px solid ${surface.border}`,
      flexShrink: 0,
    }}>
      <StatusCell label="Rate"      value={`${sr.toLocaleString()} Hz`} />
      <StatusCell label="Channels"  value={channels === 2 ? 'Stereo' : `${channels}ch`} mono={false} />
      <StatusCell label="Oversample" value={`${oversample}×`} />

      <span style={{
        height: 12,
        width: 1,
        background: surface.border,
      }} />

      <StatusCell label="Target LUFS" value={tLufs} />
      <StatusCell label="Target TP"   value={tTp} />

      <div style={{ flex: 1 }} />

      {props.engineLabel && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.tertiary,
        }}>
          <span
            style={{
              width: 6, height: 6, borderRadius: 999,
              background: running ? meter.safe.foreground : surface.overlay,
              transition: 'background 120ms ease-out',
            }}
          />
          <span style={{ letterSpacing: '0.04em' }}>{props.engineLabel}</span>
        </span>
      )}
    </div>
  );
}
