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

/** User-facing Korean status (plain language, no engine jargon). */
function friendlyLabel(status: RealtimePreviewUiStatus, fallback: boolean): string {
  if (fallback) return '실시간으로 적용 중 (대체 엔진)';
  switch (status) {
    case 'active':      return '변경 내용이 실시간으로 적용 중입니다';
    case 'passthrough':
    case 'starting':    return '실시간 미리듣기 준비 중…';
    case 'waiting':     return '재생을 시작하면 변경 내용이 바로 적용됩니다';
    case 'bypassed':    return '바이패스 — 원본을 듣고 있습니다';
    case 'failed':      return '실시간 엔진 오류 — 다시 시작해 주세요';
    case 'unavailable': return '이 환경에서는 실시간 미리듣기를 사용할 수 없습니다';
    case 'off':
    default:            return '실시간 미리듣기 꺼짐';
  }
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
  const label = friendlyLabel(status, fallback);

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
