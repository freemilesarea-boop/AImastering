// LouiRealtimeDebugPanel — dev-only realtime-preview metrics overlay
// (M2-full device test).
//
// Surfaces the realtime mastering chain's health so device testing can
// read CPU / glitch / state at a glance.  Rendered only when the
// realtime flag is on (and ideally behind a dev-only gate).

import React from 'react';
import { surface, text, typography, meter, space, radius } from '../../theme/loui-theme.js';
import type { RealtimeMetricsSnapshot } from '../../audio/realtime-metrics.js';

export interface LouiRealtimeDebugPanelProps {
  /** Realtime path active (flag on + worklet attached). */
  active: boolean;
  /** Readiness summary (e.g. "realtime-ready" / "...unavailable: ..."). */
  readiness: string;
  /** Aggregated metrics from the worklet. */
  metrics: RealtimeMetricsSnapshot;
  /** AudioContext state ('running' / 'suspended' / 'closed'). */
  contextState?: string;
  /** Active buffer / quantum size (samples). */
  bufferSize?: number;
  sampleRate?: number;
}

function Row({ label, value, status }: { label: string; value: string; status?: 'ok' | 'warn' | 'danger' | undefined }) {
  const colour = status === 'danger' ? meter.danger.foreground
    : status === 'warn' ? meter.warn.foreground
    : status === 'ok' ? meter.safe.foreground
    : text.secondary;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: space['3'] }}>
      <span style={{ color: text.muted, fontSize: typography.size.xs }}>{label}</span>
      <span style={{
        color: colour,
        fontFamily: typography.family.mono,
        fontSize: typography.size.xs,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </div>
  );
}

export function LouiRealtimeDebugPanel(props: LouiRealtimeDebugPanelProps) {
  const m = props.metrics;
  const cpuPct = m.cpuLoad * 100;
  const cpuStatus = cpuPct > 50 ? 'danger' : cpuPct > 25 ? 'warn' : 'ok';
  const xrunStatus = m.totalXruns > 0 ? 'danger' : 'ok';
  return (
    <div style={{
      width: 240,
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      padding: space['3'],
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      fontFamily: typography.family.sans,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{
          fontSize: typography.size.xs, fontWeight: typography.weight.semi,
          letterSpacing: '0.12em', textTransform: 'uppercase', color: text.muted,
        }}>
          Realtime Preview
        </span>
        <span style={{
          width: 8, height: 8, borderRadius: 999,
          background: props.active ? meter.safe.foreground : surface.overlay,
          boxShadow: props.active ? `0 0 6px ${meter.safe.foreground}` : 'none',
        }} />
      </div>
      <Row label="status" value={props.active ? 'ON (Rust chain)' : 'OFF (re-render)'}
           status={props.active ? 'ok' : undefined} />
      <Row label="readiness" value={props.readiness} status={props.readiness === 'realtime-ready' ? 'ok' : 'warn'} />
      {props.contextState && <Row label="ctx" value={props.contextState} />}
      {typeof props.sampleRate === 'number' && <Row label="rate" value={`${(props.sampleRate / 1000).toFixed(1)} kHz`} />}
      {typeof props.bufferSize === 'number' && <Row label="quantum" value={`${props.bufferSize} smp`} />}
      <div style={{ height: 1, background: surface.border, marginBlock: 4 }} />
      <Row label="cpu (chain)" value={`${cpuPct.toFixed(1)}%`} status={cpuStatus} />
      <Row label="avg process" value={`${m.avgProcessMs.toFixed(3)} ms`} />
      <Row label="peak process" value={`${m.peakProcessMs.toFixed(3)} ms`} />
      <Row label="block period" value={`${m.blockPeriodMs.toFixed(3)} ms`} />
      <Row label="xruns" value={`${m.totalXruns}`} status={xrunStatus} />
      <Row label="limiter GR" value={`${m.limiterGrDb.toFixed(1)} dB`} />
    </div>
  );
}
