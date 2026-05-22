// LouiRealtimeStatus — is the user hearing edits live? (OZONE-MODULE-NEXT-5)
//
// Honest indicator: separates "heard live in the preview" from "staged".
// Only the genuine `active` status (worklet actually processing) shows the
// green "heard live" state — waiting / passthrough / starting / failed all
// read "changes are staged", never a false "Live".

import React from 'react';
import { surface, text, typography, radius, meter } from '../../../theme/loui-theme.js';
import { loui } from '../../../theme/loui-home.js';
import {
  realtimeStatusLabel,
  isRealtimeHeardLive,
  type RealtimePreviewUiStatus,
} from '../../../audio/realtime-ui-status.js';

export interface LouiRealtimeStatusProps {
  /** Honest coarse status from the hook (preferred). */
  status?: RealtimePreviewUiStatus;
  /** Realtime preview flag is on (fallback when `status` absent). */
  enabled?: boolean;
  /** The realtime graph is attached + processing (fallback). */
  active?: boolean;
  /** Readiness label (e.g. "realtime-ready" / "...unavailable: ..."). */
  readinessLabel?: string;
  /** Native DSP fallback is processing audio (WASM down but edits audible). */
  fallbackActive?: boolean;
}

/** Derive a status from the legacy enabled/active props (storybook etc.). */
function legacyStatus(props: LouiRealtimeStatusProps): RealtimePreviewUiStatus {
  if (!props.enabled) return 'off';
  if (props.active) return 'active';
  if (props.readinessLabel && props.readinessLabel !== 'realtime-ready') return 'unavailable';
  return 'starting';
}

export function LouiRealtimeStatus(props: LouiRealtimeStatusProps) {
  const status = props.status ?? legacyStatus(props);
  // When the WASM realtime path failed but the native DSP fallback is
  // processing, the edits ARE audible — show that honestly, not "failed".
  const fallback = !!props.fallbackActive && (status === 'failed' || status === 'unavailable');
  const live = isRealtimeHeardLive(status) || fallback;
  const off = status === 'off';
  const color = live ? meter.safe.foreground : off ? text.muted : loui.warningAmber;
  const dot = live ? meter.safe.foreground : off ? surface.overlay : loui.warningAmber;
  const label = fallback ? 'Fallback active · native DSP' : realtimeStatusLabel(status, props.readinessLabel);

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
