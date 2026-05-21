// LouiRealtimeStatus — is the user hearing edits live? (OZONE-MODULE-NEXT-5)
//
// Honest indicator: separates "heard live in the preview" from "reaches the
// exported file".  When realtime is OFF, edits still apply — but only on
// the next Update Preview / Re-master, not instantly.

import React from 'react';
import { surface, text, typography, radius, meter } from '../../../theme/loui-theme.js';
import { loui } from '../../../theme/loui-home.js';

export interface LouiRealtimeStatusProps {
  /** Realtime preview flag is on. */
  enabled: boolean;
  /** The realtime graph is attached + processing. */
  active: boolean;
  /** Readiness label (e.g. "realtime-ready" / "...unavailable: ..."). */
  readinessLabel?: string;
}

export function LouiRealtimeStatus(props: LouiRealtimeStatusProps) {
  const live = props.enabled && props.active;
  const color = live ? meter.safe.foreground : props.enabled ? loui.warningAmber : text.muted;
  const dot = live ? meter.safe.foreground : props.enabled ? loui.warningAmber : surface.overlay;
  const label = live
    ? 'Realtime on · module edits are heard live'
    : props.enabled
      ? (props.readinessLabel && props.readinessLabel !== 'realtime-ready'
          ? `Realtime unavailable — changes are staged (${props.readinessLabel})`
          : 'Realtime starting… — changes are staged until it is active')
      : 'Realtime off — changes are staged. Click Update Preview or Create Revision to hear supported changes.';

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 7,
      padding: '4px 10px', borderRadius: radius.chip,
      border: `1px solid ${surface.border}`, background: surface.panel,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: dot, boxShadow: live ? `0 0 6px ${dot}` : 'none' }} />
      <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color }}>{label}</span>
    </div>
  );
}
